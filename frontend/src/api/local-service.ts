import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  commitState,
  currentRevision,
  listLedger,
  listRows,
  resetRows,
  saveRows,
} from '@/data/local-store'
import {
  CREW_SECTION_MAP,
  LEDGER_KEY,
  PROGRESS_KEY,
  RING_ACTION_CONFIRM,
  RING_KEY,
  RING_STATUS_CORRECTED,
  RING_STATUS_DIGGING,
  RING_STATUS_THROUGH,
  applyProgressWriteback,
  averageDiggingSpeed,
  formatTimestamp,
  isThroughStatus,
  mergeLedger,
  monthlyThroughCount,
  ringLabel,
  ringNumber,
  sortByRingNo,
} from '@/data/ring-domain'
import type {
  ActionResult,
  EntryRow,
  LedgerEntry,
  ModuleMeta,
  OverviewResult,
  PageResult,
  RingConfirmItem,
  RingConfirmResult,
  RingMetrics,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

type CommitDraft =
  | { valid: false; result: RingConfirmResult }
  | {
      valid: true
      changedIds: number[]
      updatedRings: EntryRow[]
      ledger: LedgerEntry[]
      progress: EntryRow[]
      items: RingConfirmItem[]
    }

/**
 * 贯通确认的唯一写库核心：单条入口与批量入口都走这里，不再各写一套。
 *
 * 事务语义：先对整组每一环做完校验（权限、状态），有一环不通过就整组退回，
 * 不提交任何一环；全部通过才把「环次状态 + 贯通时间 + 贯通台账 + 进度节点回写」
 * 在一次原子提交里落库。逐环结论随结果返回，失败时逐条写出是哪个环号。
 *
 * 幂等：已是已贯通/已纠偏的环按成功处理但不改动；同一环反复提交只入一条台账，
 * 贯通时间只记最早那次。
 *
 * 权限：只有本掘进班组能确认本班组所属区间里的环；跨班组或越级班组一律不收。
 */
export function confirmRings(
  ringIds: number[],
  operatorCrew: string | undefined,
  now: Date = new Date(),
): RingConfirmResult {
  const section = operatorCrew ? CREW_SECTION_MAP[operatorCrew] : undefined
  const confirmedAt = formatTimestamp(now)

  const buildDraft = (): CommitDraft => {
    const state = allRows()
    const rings = (state[RING_KEY] ?? []) as EntryRow[]
    const ledger = (state[LEDGER_KEY] ?? []) as LedgerEntry[]
    const progress = (state[PROGRESS_KEY] ?? []) as EntryRow[]
    const byId = new Map(rings.map((row) => [Number(row.id), row]))

    // 去重后按环号顺序处理，保证「重排后的次序」不串位、逐条结论对得上环。
    // 找不到的环按编号补在后面，由下面的校验逐条报「没有找到」。
    const uniqueIds = [...new Set(ringIds.map((id) => Number(id)))]
    const ids = sortByRingNo(
      uniqueIds
        .filter((id) => byId.has(id))
        .map((id) => byId.get(id) as EntryRow),
      (row) => row['环号'],
    )
      .map((row) => Number(row.id))
      .concat(uniqueIds.filter((id) => !byId.has(id)))

    const items: RingConfirmItem[] = []
    const changedIds: number[] = []
    const updatedRings = [...rings]
    let hardFail = false

    const failItem = (row: EntryRow | undefined, id: number, message: string): void => {
      hardFail = true
      items.push({
        ringId: id,
        ringNo: row ? ringLabel(row) : `编号${id}`,
        ok: false,
        changed: false,
        message,
      })
    }

    for (const id of ids) {
      const row = byId.get(id)
      if (!row) {
        failItem(undefined, id, `没有找到编号为 ${id} 的掘进环`)
        continue
      }
      const ringNo = ringLabel(row)
      if (!section) {
        failItem(row, id, `环号 ${ringNo}：当前班组「${operatorCrew || '未指定班组'}」不具备掘进贯通确认权限，越级操作不收`)
        continue
      }
      if (String(row['区间'] ?? '') !== section) {
        failItem(
          row,
          id,
          `环号 ${ringNo}：属于${String(row['区间'] ?? '未分配')}区间，${operatorCrew}只能确认${section}区间，跨班组改动不收`,
        )
        continue
      }
      if (String(row['掘进班组'] ?? '') !== operatorCrew) {
        failItem(
          row,
          id,
          `环号 ${ringNo}：归属${String(row['掘进班组'] ?? '未分配')}，不是${operatorCrew}本班组环次，跨班组改动不收`,
        )
        continue
      }
      const status = String(row.status)
      if (isThroughStatus(status)) {
        // 幂等：已贯通的环不再改状态、不再记第二条贯通时间。
        items.push({
          ringId: id,
          ringNo,
          ok: true,
          changed: false,
          message: `环号 ${ringNo}：已是「${status}」，贯通时间 ${String(row['贯通时间'] ?? '') || '（老数据未记录）'}，不重复入账`,
        })
        continue
      }
      if (status !== RING_STATUS_DIGGING) {
        failItem(row, id, `环号 ${ringNo}：当前状态「${status}」，只有「${RING_STATUS_DIGGING}」的环能确认贯通`)
        continue
      }
      changedIds.push(id)
    }

    if (hardFail) {
      // 校验未通过的环已经逐条写明原因；其余环如实标注：整组退回、未提交。
      const failedIds = new Set(items.filter((item) => !item.ok).map((item) => item.ringId))
      for (const id of ids) {
        if (!failedIds.has(id)) {
          const row = byId.get(id)!
          items.push({
            ringId: id,
            ringNo: ringLabel(row),
            ok: false,
            changed: false,
            message: `环号 ${ringLabel(row)}：因同组其他环校验未过，整组退回，本环未写入`,
          })
        }
      }
      items.sort((a, b) => ringNumber(a.ringNo) - ringNumber(b.ringNo))
      return {
        valid: false,
        result: {
          ok: false,
          committed: false,
          confirmedAt,
          message: `整组 ${ids.length} 环已全部退回，未写入任何一环`,
          items,
        },
      }
    }

    // 全部校验通过：整组使用同一个贯通时刻，逐环改状态并记贯通时间。
    for (const id of changedIds) {
      const index = updatedRings.findIndex((row) => Number(row.id) === id)
      const row = updatedRings[index]
      updatedRings[index] = {
        ...row,
        status: RING_STATUS_THROUGH,
        pending: false,
        '贯通时间': confirmedAt,
        '环次状态': RING_STATUS_THROUGH,
      }
      items.push({
        ringId: id,
        ringNo: ringLabel(row),
        ok: true,
        changed: true,
        message: `环号 ${ringLabel(row)}：已确认贯通，贯通时间 ${confirmedAt}`,
      })
    }

    const incoming: LedgerEntry[] = changedIds.map(
      (id) => updatedRings.find((row) => Number(row.id) === id) as LedgerEntry,
    )
    const nextLedger = mergeLedger(ledger, incoming)
    const nextProgress = applyProgressWriteback(progress, updatedRings, nextLedger, now)

    items.sort((a, b) => ringNumber(a.ringNo) - ringNumber(b.ringNo))
    return {
      valid: true,
      changedIds,
      updatedRings: sortByRingNo(updatedRings, (row) => row['环号']),
      ledger: nextLedger,
      progress: nextProgress,
      items,
    }
  }

  const commitDraft = (draft: Extract<CommitDraft, { valid: true }>): RingConfirmResult => {
    const state = allRows()
    const nextState = {
      ...state,
      [RING_KEY]: draft.updatedRings,
      [LEDGER_KEY]: draft.ledger,
      [PROGRESS_KEY]: draft.progress,
    }
    commitState(nextState, currentRevision())
    const changedCount = draft.changedIds.length
    const skippedCount = draft.items.length - changedCount
    return {
      ok: true,
      committed: changedCount > 0,
      confirmedAt,
      message:
        changedCount > 0
          ? `已一次提交 ${changedCount} 环贯通（贯通时间 ${confirmedAt}）` +
            (skippedCount > 0 ? `，另有 ${skippedCount} 环此前已贯通，未重复入账` : '')
          : `所选 ${skippedCount} 环此前均已贯通，未重复入账，贯通时间保持最早一次`,
      items: draft.items,
    }
  }

  if (ringIds.length === 0) {
    return {
      ok: false,
      committed: false,
      confirmedAt,
      message: '请先勾选要确认贯通的环次',
      items: [],
    }
  }

  let draft = buildDraft()
  if (!draft.valid) {
    return draft.result
  }
  try {
    return commitDraft(draft)
  } catch (error) {
    if ((error as { name?: string })?.name !== 'StaleCommitError') throw error
    // 依据的数据版本过期：重读后重新校验并重试一次；旧结果绝不顶上来。
    draft = buildDraft()
    if (!draft.valid) {
      return draft.result
    }
    try {
      return commitDraft(draft)
    } catch (retryError) {
      if ((retryError as { name?: string })?.name !== 'StaleCommitError') throw retryError
      return {
        ok: false,
        committed: false,
        confirmedAt,
        message: '列表数据已被其他操作更新，本次提交未写入，请刷新列表后重试',
        items: [],
      }
    }
  }
}

/**
 * 掘进环次指标的唯一来源：本月贯通环数只认贯通台账（台账每环只一条），
 * 掘进环次页、进度节点页、运营概览都从这里取，两处不再各算一遍。
 */
export function getRingMetrics(now: Date = new Date()): RingMetrics {
  const rings = listRows(RING_KEY)
  const ledger = listLedger()
  return {
    totalRings: rings.length,
    monthlyThrough: monthlyThroughCount(ledger, now),
    averageSpeed: averageDiggingSpeed(rings),
    corrected: rings.filter((row) => String(row.status) === RING_STATUS_CORRECTED).length,
  }
}

export function runAction(
  key: string,
  id: number,
  action: string,
  operatorCrew?: string,
): ActionResult {
  const meta = moduleMeta(key)
  // 掘进环次的「确认完成」与批量入口共用同一个事务写库核心。
  if (key === RING_KEY && action === RING_ACTION_CONFIRM) {
    const result = confirmRings([id], operatorCrew)
    return {
      ok: result.ok,
      message: result.ok
        ? result.message
        : `${result.message}：${result.items.map((item) => item.message).join('；')}`,
    }
  }
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const metrics = getRingMetrics()
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
    { label: '本月贯通环数', value: metrics.monthlyThrough },
  ]
  return { cards, modules }
}
