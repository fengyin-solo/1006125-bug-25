import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  commitRingConfirmation,
  listRingLedger,
  listRows,
  resetRows,
  saveRows,
} from '@/data/local-store'
import {
  averageRingSpeed,
  compareRingNo,
  countBreakthroughByMonth,
  crewOwnsSection,
  currentMonth,
  formatDateTime,
  joinPendingRingNos,
  ledgerCountForNodeMonth,
  monthOfDate,
  sectionOfCrew,
  sectionOfRing,
  splitPendingRingNos,
} from '@/data/ring-domain'
import type {
  ActionResult,
  BreakthroughRecord,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  RingConfirmItem,
  RingConfirmResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 贯通确认只认这一个来源状态：待掘进、已纠偏都算越级，整组不收。
const BREAKTHROUGH_FROM_STATUS = '掘进中'
const BREAKTHROUGH_STATUS = '已贯通'

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

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
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
  // 环次页与迁移规则保持一致：只有「已贯通」才算办结，已纠偏仍留在在办；
  // 同时让「环次状态」业务字段跟着状态列走，避免两处读法打架。
  if (key === 'ring') {
    updated.pending = target !== BREAKTHROUGH_STATUS
    updated['环次状态'] = target
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

function failedReturn(items: RingConfirmItem[], message: string): RingConfirmResult {
  return {
    ok: false,
    committed: false,
    message,
    items: [...items].sort((a, b) => compareRingNo(a.环号, b.环号)),
    confirmedCount: 0,
    skippedCount: 0,
  }
}

/**
 * 批量确认已贯通（单条入口也走这里，不再各写一套写库逻辑）。
 *
 * 事务语义：整组先逐条校验——班组只认本班组区间、只许「掘进中」进「已贯通」、
 * 进度节点在办清单里要有这一环；有一环写不成就整组退回，一环不落，并逐条给出
 * 是哪个环号失败。全部通过后，环次进度、贯通时间、贯通台账、节点回写在同一次
 * 提交里落库。反复提交只入一条台账，贯通时间保留最早那次。
 */
export function confirmRings(ids: number[], crew: string): RingConfirmResult {
  const idList = [...new Set(ids.map(Number))]
  if (idList.length === 0) {
    return {
      ok: false,
      committed: false,
      message: '请先勾选要确认贯通的环次',
      items: [],
      confirmedCount: 0,
      skippedCount: 0,
    }
  }

  const section = sectionOfCrew(crew)
  if (!section) {
    return {
      ok: false,
      committed: false,
      message: `当前班组「${crew}」没有负责的施工区间，不能确认贯通`,
      items: [],
      confirmedCount: 0,
      skippedCount: 0,
    }
  }

  const rings = listRows('ring')
  const ringById = new Map(rings.map((row) => [Number(row.id), row]))
  const progressRows = listRows('progress')
  const ledger = listRingLedger()

  // 逐条校验阶段：只收集结论，不动任何数据。
  const targets: EntryRow[] = []
  const items: RingConfirmItem[] = []
  let blocked = false

  for (const id of idList) {
    const row = ringById.get(id)
    if (!row) {
      blocked = true
      items.push({ id, 环号: `#${id}`, ok: false, state: 'failed', reason: '环次记录不存在' })
      continue
    }
    const ringNo = String(row['环号'] ?? id)
    const ringSection = sectionOfRing(row)

    // 跨班组的环：不归本班组区间，不收。
    if (ringSection && ringSection !== section) {
      blocked = true
      items.push({
        id,
        环号: ringNo,
        ok: false,
        state: 'failed',
        reason: `环号 ${ringNo} 属于${ringSection}，不在本班组（${crew}·${section}）区间，跨班组不能确认`,
      })
      continue
    }
    // 归属不明的环也不能收，避免误确认别人的区间。
    if (!ringSection) {
      blocked = true
      items.push({
        id,
        环号: ringNo,
        ok: false,
        state: 'failed',
        reason: `环号 ${ringNo} 没有区间信息，无法判定归属，不能确认`,
      })
      continue
    }
    if (String(row['掘进班组'] ?? '').trim() && String(row['掘进班组']).trim() !== crew) {
      blocked = true
      items.push({
        id,
        环号: ringNo,
        ok: false,
        state: 'failed',
        reason: `环号 ${ringNo} 的掘进班组是「${String(row['掘进班组']).trim()}」，不是当前班组「${crew}」，不能代确认`,
      })
      continue
    }
    // 越级：待掘进、已纠偏等都不能直接标已贯通。
    if (String(row.status) !== BREAKTHROUGH_FROM_STATUS && String(row.status) !== BREAKTHROUGH_STATUS) {
      blocked = true
      items.push({
        id,
        环号: ringNo,
        ok: false,
        state: 'failed',
        reason: `环号 ${ringNo} 当前是「${String(row.status)}」，只有「${BREAKTHROUGH_FROM_STATUS}」才能确认贯通，越级确认不收`,
      })
      continue
    }

    if (String(row.status) === BREAKTHROUGH_STATUS) {
      // 已经贯通的环：幂等跳过，不拦整组、不重复入台账。
      items.push({
        id,
        环号: ringNo,
        ok: true,
        state: 'skipped',
        reason: `环号 ${ringNo} 已贯通，本次不重复记账`,
      })
      continue
    }
    targets.push(row)
    items.push({ id, 环号: ringNo, ok: true, state: 'confirmed' })
  }

  if (blocked) {
    // 全组退回：把没通过的逐条原因摆出来，通过了的也不落。
    for (const item of items) {
      if (item.state === 'confirmed') {
        item.state = 'returned'
        item.ok = false
        item.reason = `环号 ${item.环号} 本组有其他环校验不过，整组退回，本环未落库`
      }
    }
    const failedNos = items
      .filter((item) => item.state === 'failed')
      .map((item) => item.环号)
      .join('、')
    return failedReturn(items, `整组退回，未落任何一环；失败环号：${failedNos}`)
  }

  if (targets.length === 0) {
    return {
      ok: true,
      committed: false,
      message: `勾选的 ${idList.length} 环都已是「已贯通」，贯通时间与台账保持最早那次，未重复记账`,
      items: [...items].sort((a, b) => compareRingNo(a.环号, b.环号)),
      confirmedCount: 0,
      skippedCount: items.length,
    }
  }

  // 找本区间「进行中」的进度节点；节点没在办，结论无处回写，同样整组不收。
  const node = progressRows.find(
    (row) => String(row['区间'] ?? '') === section && String(row.status) === '进行中',
  )
  if (!node) {
    for (const item of items) {
      if (item.state === 'confirmed') {
        item.state = 'returned'
        item.ok = false
        item.reason = `环号 ${item.环号} 所在${section}没有「进行中」的进度节点，确认结论无处回写，整组退回`
      }
    }
    return failedReturn(items, `整组退回：${section}没有进行中的进度节点承接本次确认结论`)
  }

  const targetNos = new Set(targets.map((row) => String(row['环号'] ?? '')))
  const pendingNos = splitPendingRingNos(String(node['在办清单'] ?? ''))
  const missingNos = [...targetNos]
    .filter((ringNo) => !pendingNos.includes(ringNo))
    .sort(compareRingNo)
  if (missingNos.length > 0) {
    for (const item of items) {
      if (item.state === 'confirmed' && missingNos.includes(item.环号)) {
        item.state = 'returned'
        item.ok = false
        item.reason = `环号 ${item.环号} 不在进度节点「${String(node['节点名称'])}」的在办清单里，整组退回`
      }
    }
    return failedReturn(
      items,
      `整组退回：环号 ${missingNos.join('、')} 不在节点在办清单中`,
    )
  }

  // 全部校验通过：贯通时间取这一次提交开始的时刻；连点两回，第二回目标已是已贯通，
  // 走幂等跳过，台账里永远是最早那次时间。
  const confirmedAt = formatDateTime()
  const month = monthOfDate(confirmedAt) || currentMonth()

  const nextRings = rings.map((row) => {
    if (!targets.some((target) => Number(target.id) === Number(row.id))) {
      return row
    }
    return {
      ...row,
      status: BREAKTHROUGH_STATUS,
      pending: false,
      abnormal: false,
      贯通时间: confirmedAt,
      环次状态: BREAKTHROUGH_STATUS,
    }
  })

  // 台账：按 ringId 去重，只入新环；存量行顺序不动，台账始终按环号排序。
  const ledgerById = new Map(ledger.map((item) => [Number(item.ringId), { ...item }]))
  for (const row of targets) {
    const id = Number(row.id)
    if (!ledgerById.has(id)) {
      ledgerById.set(id, {
        ringId: id,
        环号: String(row['环号'] ?? ''),
        区间: section,
        掘进班组: crew,
        贯通时间: confirmedAt,
      })
    }
  }
  const nextLedger = [...ledgerById.values()].sort((a, b) => compareRingNo(a.环号, b.环号))

  // 确认结论回写进度节点在办清单：已贯通的环移出在办，实际掘进量只认台账这一份。
  const remainingNos = pendingNos.filter((ringNo) => !targetNos.has(ringNo))
  const confirmedNos = targets.map((row) => String(row['环号'] ?? '')).sort(compareRingNo)
  const monthCount = ledgerCountForNodeMonth(nextLedger, section, month)
  const nextNode: EntryRow = {
    ...node,
    在办清单: joinPendingRingNos(remainingNos),
    实际掘进量: String(monthCount),
    // 偏差天数：实际贯通相对计划完成日，提前为负、滞后为正；还没完工就先按 0。
    偏差天数: '0',
    确认结论: `${crew}于 ${confirmedAt} 批量确认 ${confirmedNos.length} 环已贯通：${confirmedNos.join(
      '、',
    )}；在办剩余 ${remainingNos.length} 环`,
  }
  const nextProgress = progressRows.map((row) =>
    Number(row.id) === Number(node.id) ? nextNode : row,
  )

  // 一次提交：环次进度 + 贯通时间 + 台账 + 节点，在同一事务落点里写，不许只落一半。
  commitRingConfirmation({ rings: nextRings, ledger: nextLedger, progress: nextProgress })

  return {
    ok: true,
    committed: true,
    confirmedAt,
    message: `本次 ${confirmedNos.length} 环已确认贯通（贯通时间 ${confirmedAt}），结论已回写节点「${String(
      node['节点名称'],
    )}」在办清单`,
    items: [...items].sort((a, b) => compareRingNo(a.环号, b.环号)),
    confirmedCount: confirmedNos.length,
    skippedCount: items.filter((item) => item.state === 'skipped').length,
  }
}

export function getRingLedger(): BreakthroughRecord[] {
  return listRingLedger()
}

export type RingStats = {
  monthBreakthrough: number
  averageSpeed: string
  correctedCount: number
}

/** 环次页 / 进度节点 / 运营概览共用：本月贯通环数只从台账算，不各算一遍。 */
export function getRingStats(month: string = currentMonth()): RingStats {
  const rings = listRows('ring')
  return {
    monthBreakthrough: countBreakthroughByMonth(listRingLedger(), month),
    averageSpeed: averageRingSpeed(rings),
    correctedCount: rings.filter((row) => String(row.status) === '已纠偏').length,
  }
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
  // 本月贯通环数与环次页、进度节点同一口径：只数贯通台账。
  const monthBreakthrough = getRingStats().monthBreakthrough
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
    { label: '本月贯通环数', value: monthBreakthrough },
  ]
  return { cards, modules }
}
