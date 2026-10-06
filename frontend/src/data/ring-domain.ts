import type { EntryRow, LedgerEntry } from './types'

/**
 * 掘进环次领域规则：单条与批量、掘进环次页与进度节点页/概览页都只认这一处，
 * 不允许在页面或批量入口里再各写一套判断与统计。
 */

export const RING_KEY = 'ring'
export const PROGRESS_KEY = 'progress'
export const LEDGER_KEY = '__ring_ledger__'
export const RING_STATUS_THROUGH = '已贯通'
export const RING_STATUS_CORRECTED = '已纠偏'
export const RING_STATUS_DIGGING = '掘进中'
export const RING_ACTION_CONFIRM = '确认完成'

// 班组与掘进区间的绑定：只有本班组能确认自己区间里的环次，跨班组不收。
export const CREW_SECTION_MAP: Record<string, string> = {
  掘进甲班: '左线',
  掘进乙班: '右线',
}

export const RING_CREWS = Object.keys(CREW_SECTION_MAP)
export const SECTIONS = ['左线', '右线']

/** 从环号里解析出数字部分用于排序与比较；兼容老数据里非纯数字的环号。 */
export function ringNumber(ringNo: unknown): number {
  const matched = String(ringNo ?? '').match(/\d+/)
  return matched ? Number(matched[0]) : Number.POSITIVE_INFINITY
}

export function ringLabel(row: EntryRow): string {
  return String(row['环号'] ?? `编号${row.id}`)
}

/** 按环号顺序排列（存量环次补台账、列表展示、批量处理都用它）。 */
export function sortByRingNo<T extends Pick<EntryRow, 'id'> & { [k: string]: unknown }>(
  rows: T[],
  getNo: (row: T) => unknown = (row) => (row as unknown as EntryRow)['环号'],
): T[] {
  return [...rows].sort((a, b) => {
    const diff = ringNumber(getNo(a)) - ringNumber(getNo(b))
    if (diff !== 0) return diff
    return Number(a.id) - Number(b.id)
  })
}

export function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 整组确认共用一个贯通时刻：格式 YYYY-MM-DD HH:mm。 */
export function formatTimestamp(date: Date): string {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  )
}

export function currentMonth(date: Date = new Date()): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`
}

/**
 * 偏差天数：实际完成日晚于计划完成日为正（延期），早于为负（提前）。
 * 两个口径在全平台统一用这个函数，不在页面里各算一遍；日期不全时无法判断，返回空。
 */
export function deviationDays(planned: unknown, actual: unknown): string {
  if (!planned || !actual) return ''
  const p = new Date(`${planned}T00:00:00`)
  const a = new Date(`${actual}T00:00:00`)
  if (Number.isNaN(p.getTime()) || Number.isNaN(a.getTime())) return ''
  const days = Math.round((a.getTime() - p.getTime()) / 86_400_000)
  return days > 0 ? `延期${days}天` : days < 0 ? `提前${-days}天` : '按期'
}

export function isThroughStatus(status: unknown): boolean {
  return status === RING_STATUS_THROUGH || status === RING_STATUS_CORRECTED
}

/**
 * 台账并入一批新贯通的环：同一环（按环次 id）只保留最早那条贯通时间，
 * 反复提交不会产生第二条记录。台账始终按环号顺序维护。
 */
export function mergeLedger(existing: LedgerEntry[], incoming: LedgerEntry[]): LedgerEntry[] {
  const byId = new Map<number, LedgerEntry>()
  for (const item of sortByRingNo(existing, (row) => row['环号'])) {
    byId.set(Number(item.id), item)
  }
  for (const item of incoming) {
    const key = Number(item.id)
    const prev = byId.get(key)
    if (!prev) {
      byId.set(key, { ...item })
      continue
    }
    // 贯通时间以最早一次为准；较早记录里缺时间而本次有时补回。
    const prevTime = String(prev['贯通时间'] ?? '')
    const nextTime = String(item['贯通时间'] ?? '')
    byId.set(key, {
      ...prev,
      ...item,
      贯通时间: prevTime && nextTime ? (nextTime < prevTime ? nextTime : prevTime) : prevTime || nextTime,
    })
  }
  return sortByRingNo([...byId.values()], (row) => row['环号'])
}

/** 由环次现状重建一份台账：存量已贯通环按环号顺序补进台账的依据。 */
export function buildLedger(rings: EntryRow[]): LedgerEntry[] {
  const entries = rings
    .filter((row) => isThroughStatus(row.status))
    .map((row) => ({
      ...row,
      '贯通时间': String(row['贯通时间'] ?? ''),
    }))
  // 老数据可能因历史重复确认留有同环多条，这里按环号顺序去重，保留最早贯通时间。
  return mergeLedger([], entries)
}

/** 台账里贯通时间落在本月的环数（贯通时间缺失的老记录无法归月，不计入）。 */
export function monthlyThroughCount(ledger: LedgerEntry[], now: Date = new Date()): number {
  const prefix = currentMonth(now)
  return ledger.filter((item) => String(item['贯通时间'] ?? '').startsWith(prefix)).length
}

/** 平均掘进速度：统一取掘进中/已贯通/已纠偏环次的「掘进速度」数值，口径只此一处。 */
export function averageDiggingSpeed(rings: EntryRow[]): number {
  const values = rings
    .filter((row) => row.status !== '待掘进')
    .map((row) => Number(String(row['掘进速度'] ?? '').replace(/[^\d.]/g, '')))
    .filter((value) => Number.isFinite(value) && value > 0)
  if (!values.length) return 0
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10
}

type ProgressSnapshot = {
  throughTotal: number
  monthlyThrough: number
  pendingRings: string[]
}

/** 某区间在台账与当前环次状态下的进度快照：进度节点回写的唯一算法。 */
export function sectionSnapshot(
  rings: EntryRow[],
  ledger: LedgerEntry[],
  section: string,
  now: Date = new Date(),
): ProgressSnapshot {
  const inSection = rings.filter((row) => String(row['区间'] ?? '') === section)
  const ledgerIds = new Set(
    ledger
      .filter((item) => String(item['区间'] ?? '') === section)
      .map((item) => Number(item.id)),
  )
  const throughTotal = ledgerIds.size
  const monthlyThrough = ledger.filter(
    (item) =>
      String(item['区间'] ?? '') === section &&
      String(item['贯通时间'] ?? '').startsWith(currentMonth(now)),
  ).length
  const pendingRings = sortByRingNo(
    inSection.filter((row) => !isThroughStatus(row.status)),
    (row) => row['环号'],
  ).map((row) => ringLabel(row))
  return { throughTotal, monthlyThrough, pendingRings }
}

/**
 * 把确认结论回写到进度节点的在办清单：
 * 「实际掘进量」与台账累计贯通环数对齐，「贯通在办」列出本区间尚未确认的环，
 * 偏差天数由计划/实际完成日统一重算。只动能按区间认领到的节点。
 */
export function applyProgressWriteback(
  progressRows: EntryRow[],
  rings: EntryRow[],
  ledger: LedgerEntry[],
  now: Date = new Date(),
): EntryRow[] {
  return progressRows.map((node) => {
    const section = String(node['所属区间'] ?? '')
    if (!section) return node
    const snapshot = sectionSnapshot(rings, ledger, section, now)
    const actualDate = String(node['实际完成日'] ?? '')
    return {
      ...node,
      '实际掘进量': snapshot.throughTotal,
      '贯通在办': snapshot.pendingRings.join('、'),
      '偏差天数': deviationDays(node['计划完成日'], actualDate),
    }
  })
}
