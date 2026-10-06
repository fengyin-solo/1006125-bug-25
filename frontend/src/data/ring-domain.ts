import type { BreakthroughRecord, EntryRow } from './types'

// 掘进班组与施工区间的对应关系：一个班组只负责一个区间，跨区间确认一律不收。
export const CREW_SECTIONS: Record<string, string> = {
  掘进一班: '左线',
  掘进二班: '右线',
}

/** 已知掘进班组清单，供会话里的当前班组选择。 */
export const CONFIRM_CREWS = Object.keys(CREW_SECTIONS)

export function sectionOfCrew(crew: string): string {
  return CREW_SECTIONS[crew] ?? ''
}

/** 判断一个掘进班组是不是负责该区间的本班组。 */
export function crewOwnsSection(crew: string, section: string): boolean {
  return section !== '' && sectionOfCrew(crew) === section
}

/**
 * 环号归属哪个区间。先读记录上的「区间」字段；老数据没有这个字段时，
 * 用环号前缀兜底（左线 L、右线 R），兼容存量环次记录。
 */
export function sectionOfRing(row: EntryRow): string {
  const explicit = String(row['区间'] ?? '').trim()
  if (explicit) {
    return explicit
  }
  const ringNo = String(row['环号'] ?? '').trim().toUpperCase()
  if (ringNo.startsWith('R')) {
    return '右线'
  }
  if (ringNo.startsWith('L')) {
    return '左线'
  }
  return ''
}

/** 环号数值部分，存量环次按环号顺序补进台账时排序用。 */
export function ringNumberValue(ringNo: string): number {
  const digits = String(ringNo).replace(/[^0-9]/g, '')
  return digits === '' ? Number.POSITIVE_INFINITY : Number(digits)
}

export function compareRingNo(a: string, b: string): number {
  const diff = ringNumberValue(a) - ringNumberValue(b)
  if (diff !== 0) {
    return diff
  }
  return String(a).localeCompare(String(b))
}

/** 取贯通时间里的年月（YYYY-MM）；非日期格式的老数据返回空串，不进本月统计。 */
export function monthOfDate(value: string): string {
  const match = /^(\d{4})-(\d{2})/.exec(String(value ?? '').trim())
  return match ? `${match[1]}-${match[2]}` : ''
}

export function currentMonth(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  return `${now.getFullYear()}-${month}`
}

export function formatDateTime(now: Date = new Date()): string {
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(
    now.getMinutes(),
  ).padStart(2, '0')}`
  return `${date} ${time}`
}

/**
 * 存量环次按环号顺序补进台账：已贯通但台账里没有的环，逐环补一条。
 * 贯通时间取记录上的「贯通时间」，老数据没记的留空（无法保证最早值，不能瞎编）。
 */
export function buildLedgerFromRings(rings: EntryRow[]): BreakthroughRecord[] {
  return rings
    .filter((row) => String(row.status) === '已贯通')
    .map((row) => ({
      ringId: Number(row.id),
      环号: String(row['环号'] ?? ''),
      区间: sectionOfRing(row),
      掘进班组: String(row['掘进班组'] ?? ''),
      贯通时间: String(row['贯通时间'] ?? ''),
    }))
    .sort((a, b) => compareRingNo(a.环号, b.环号))
}

/**
 * 台账与环次现状对齐：以台账已有记录为准（保留最早贯通时间），
 * 再把存量的已贯通环按环号顺序补进来；已退回为非贯通的环会从台账里剔除。
 */
export function reconcileLedger(
  ledger: BreakthroughRecord[],
  rings: EntryRow[],
): BreakthroughRecord[] {
  const ringById = new Map(rings.map((row) => [Number(row.id), row]))
  const byId = new Map<number, BreakthroughRecord>()
  for (const item of ledger) {
    const ring = ringById.get(Number(item.ringId))
    // 台账上有但环次已经不是已贯通的记录，视为废弃不落回。
    if (ring && String(ring.status) === '已贯通') {
      byId.set(Number(item.ringId), { ...item })
    }
  }
  for (const row of rings) {
    if (String(row.status) !== '已贯通' || byId.has(Number(row.id))) {
      continue
    }
    byId.set(Number(row.id), {
      ringId: Number(row.id),
      环号: String(row['环号'] ?? ''),
      区间: sectionOfRing(row),
      掘进班组: String(row['掘进班组'] ?? ''),
      贯通时间: String(row['贯通时间'] ?? ''),
    })
  }
  return [...byId.values()].sort((a, b) => compareRingNo(a.环号, b.环号))
}

/** 在办清单：顿号分隔的环号列表，空项忽略。 */
export function splitPendingRingNos(value: string): string[] {
  return String(value ?? '')
    .split(/[、,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

export function joinPendingRingNos(items: string[]): string {
  return items.join('、')
}

/**
 * 进度节点按台账对齐实际掘进量：台账里该区间、落在节点计划完成日当月的贯通环数。
 * 「本月贯通环数」两处（环次页 / 运营概览 / 进度节点）都只算台账这一份，不各算一遍。
 */
export function ledgerCountForNodeMonth(
  ledger: BreakthroughRecord[],
  section: string,
  month: string,
): number {
  return ledger.filter(
    (item) =>
      item.区间 === section && monthOfDate(item.贯通时间) === month,
  ).length
}

/** 整月贯通环数（按贯通时间所在月），本月为空串时返回全部。 */
export function countBreakthroughByMonth(
  ledger: BreakthroughRecord[],
  month: string = currentMonth(),
): number {
  return ledger.filter((item) => monthOfDate(item.贯通时间) === month).length
}

/** 平均掘进速度：只认能解析成数字的存量记录，占位文本不算。 */
export function averageRingSpeed(rings: EntryRow[]): string {
  let sum = 0
  let count = 0
  for (const row of rings) {
    const value = Number(String(row['掘进速度'] ?? '').replace(/[^0-9.]/g, ''))
    if (Number.isFinite(value) && value > 0) {
      sum += value
      count += 1
    }
  }
  return count > 0 ? (sum / count).toFixed(1) : '0'
}
