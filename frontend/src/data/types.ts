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

/** 贯通台账记录：一环一行，反复提交也只入一条，贯通时间保留最早那次。 */
export type BreakthroughRecord = {
  ringId: number
  环号: string
  区间: string
  掘进班组: string
  贯通时间: string
}

/** 批量（含单条入口复用）确认后，逐环给出的结果。 */
export type RingConfirmItemState = 'confirmed' | 'skipped' | 'failed' | 'returned'

export type RingConfirmItem = {
  id: number
  环号: string
  ok: boolean
  state: RingConfirmItemState
  reason?: string
}

export type RingConfirmResult = {
  /** 整组是否真正落库：false 表示全组退回，一环都没写。 */
  ok: boolean
  committed: boolean
  message: string
  items: RingConfirmItem[]
  confirmedCount: number
  skippedCount: number
  confirmedAt?: string
}
