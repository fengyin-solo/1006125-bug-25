/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 贯通台账中的一环：每个环号至多一条，反复确认只保留最早的贯通时间。 */
export type LedgerEntry = EntryRow

/** 批量确认时每一环的逐条结论。 */
export type RingConfirmItem = {
  ringId: number
  ringNo: string
  /** 该环自身的校验/写入是否成功；整组退回时未落库的环也会如实标注。 */
  ok: boolean
  /** 本次提交是否真正改动了该环（重复提交已贯通环时为 false）。 */
  changed: boolean
  message: string
}

/** 一次「确认贯通」事务（单环与多环共用）的总结果。 */
export type RingConfirmResult = {
  /** true 仅当整组通过校验并已一次提交落库。 */
  ok: boolean
  /** 是否真的发生了写入；纯重复提交时为 false。 */
  committed: boolean
  /** 本次入账的贯通时间（整组同一时刻）。 */
  confirmedAt: string
  message: string
  /** 逐环结论，按环号排序；整组退回时失败环逐条写明原因。 */
  items: RingConfirmItem[]
}

/** 掘进环次相关指标：所有页面统一从这里读，不在各处各算一遍。 */
export type RingMetrics = {
  totalRings: number
  /** 本月贯通环数，唯一依据是贯通台账。 */
  monthlyThrough: number
  averageSpeed: number
  corrected: number
}

/** 提交所依据的数据版本已过期（别人先写过）：调用方应重读后重试，旧结果不许顶上来。 */
export class StaleCommitError extends Error {
  constructor(expected: number, actual: number) {
    super(`数据已被其他操作更新（版本 ${expected} -> ${actual}），请刷新列表后重试`)
    this.name = 'StaleCommitError'
  }
}
