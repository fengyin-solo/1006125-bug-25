import { SEED_ROWS } from './seed'
import {
  LEDGER_KEY,
  RING_KEY,
  PROGRESS_KEY,
  applyProgressWriteback,
  buildLedger,
  isThroughStatus,
  mergeLedger,
  sortByRingNo,
} from './ring-domain'
import { StaleCommitError } from './types'
import type { EntryRow, LedgerEntry } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'shield-tunnel-construction:entries'
const META_KEY = '__meta__'
const SCHEMA_VERSION = 2

type StoreState = Record<string, EntryRow[]>
type StoreMeta = { schemaVersion: number; revision: number }

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function freshState(): StoreState {
  const state = clone(SEED_ROWS) as StoreState
  state[LEDGER_KEY] = buildLedger(state[RING_KEY] ?? [])
  return state
}

function isPlaceholderRows(rows: EntryRow[] | undefined, field: string): boolean {
  return !!rows && rows.length > 0 && rows.every((row) => String(row[field] ?? '').includes('样例'))
}

/**
 * 老数据迁移（v1 -> v2）：
 * - 还是占位示例的环次/进度节点换成新示例；真实登记过的数据原样保留并补字段。
 * - 环次按环号排序，补「区间」「贯通时间」，贯通状态与在办标记对齐。
 * - 已贯通环按环号顺序补进贯通台账（同一环只留最早贯通时间），兼容老环次记录。
 * - 进度节点回写「实际掘进量 / 贯通在办 / 偏差天数」。
 */
function migrateV2(raw: Record<string, unknown>): { state: StoreState; meta: StoreMeta } {
  const state = freshState()
  for (const [key, value] of Object.entries(raw)) {
    if (key === META_KEY || key === LEDGER_KEY) continue
    if (Array.isArray(value)) state[key] = clone(value) as EntryRow[]
  }

  // 掘进环次：占位示例整组替换；真实数据做兼容补齐。
  if (isPlaceholderRows(state[RING_KEY], '环号')) {
    state[RING_KEY] = clone(SEED_ROWS[RING_KEY])
  } else {
    const crewSection: Record<string, string> = { 掘进甲班: '左线', 掘进乙班: '右线' }
    state[RING_KEY] = sortByRingNo(state[RING_KEY] ?? [], (row) => row['环号']).map((row) => {
      const crew = String(row['掘进班组'] ?? '')
      const section = String(row['区间'] ?? '') || crewSection[crew] || ''
      const next: EntryRow = {
        ...row,
        区间: section,
        贯通时间: row['贯通时间'] === undefined ? '' : String(row['贯通时间']),
        环次状态: row['环次状态'] === undefined ? row.status : row['环次状态'],
      }
      next.pending = !isThroughStatus(String(row.status))
      return next
    })
  }

  // 贯通台账：老台账若有则保留（去重、保最早贯通时间），存量已贯通环按环号顺序补齐。
  let ledger: LedgerEntry[] = Array.isArray(raw[LEDGER_KEY])
    ? (clone(raw[LEDGER_KEY]) as LedgerEntry[])
    : []
  ledger = mergeLedger(ledger, buildLedger(state[RING_KEY] ?? []))
  state[LEDGER_KEY] = ledger

  // 进度节点：占位示例整组替换；真实数据补所属区间并统一回写。
  if (isPlaceholderRows(state[PROGRESS_KEY], '节点名称')) {
    state[PROGRESS_KEY] = clone(SEED_ROWS[PROGRESS_KEY])
  } else {
    state[PROGRESS_KEY] = (state[PROGRESS_KEY] ?? []).map((node) => {
      let section = String(node['所属区间'] ?? '')
      if (!section) {
        const name = String(node['节点名称'] ?? '')
        section = name.includes('左线') ? '左线' : name.includes('右线') ? '右线' : ''
      }
      return {
        ...node,
        所属区间: section,
        贯通在办: node['贯通在办'] === undefined ? '' : String(node['贯通在办']),
        pending: ['未开始', '进行中'].includes(String(node.status)),
      }
    })
    state[PROGRESS_KEY] = applyProgressWriteback(
      state[PROGRESS_KEY],
      state[RING_KEY] ?? [],
      ledger,
    )
  }

  return { state, meta: { schemaVersion: SCHEMA_VERSION, revision: 1 } }
}

function persist(state: StoreState, meta: StoreMeta): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, [META_KEY]: meta }))
  }
}

function readStorage(): { state: StoreState; meta: StoreMeta } {
  const fallbackState = freshState()
  const fallbackMeta: StoreMeta = { schemaVersion: SCHEMA_VERSION, revision: 1 }
  if (typeof window === 'undefined' || !window.localStorage) {
    return { state: fallbackState, meta: fallbackMeta }
  }
  const rawText = window.localStorage.getItem(STORAGE_KEY)
  if (!rawText) {
    persist(fallbackState, fallbackMeta)
    return { state: fallbackState, meta: fallbackMeta }
  }
  try {
    const raw = JSON.parse(rawText) as Record<string, unknown>
    const storedMeta = (raw[META_KEY] ?? {}) as Partial<StoreMeta>
    if (Number(storedMeta.schemaVersion ?? 1) < SCHEMA_VERSION) {
      const migrated = migrateV2(raw)
      persist(migrated.state, migrated.meta)
      return migrated
    }
    const state = fallbackState
    for (const [key, value] of Object.entries(raw)) {
      if (key === META_KEY) continue
      if (Array.isArray(value)) state[key] = clone(value) as EntryRow[]
    }
    // 台账是贯通口径的根：任何时候缺失都用当前环次现状重建一份。
    if (!state[LEDGER_KEY]) {
      state[LEDGER_KEY] = buildLedger(state[RING_KEY] ?? [])
    }
    return {
      state,
      meta: { schemaVersion: SCHEMA_VERSION, revision: Number(storedMeta.revision ?? 1) },
    }
  } catch {
    persist(fallbackState, fallbackMeta)
    return { state: fallbackState, meta: fallbackMeta }
  }
}

let cache: StoreState | null = null
let meta: StoreMeta = { schemaVersion: SCHEMA_VERSION, revision: 1 }

function ensureLoaded(): { state: StoreState; meta: StoreMeta } {
  if (cache === null) {
    const loaded = readStorage()
    cache = loaded.state
    meta = loaded.meta
  }
  return { state: cache, meta }
}

export function allRows(): StoreState {
  return ensureLoaded().state
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function listLedger(): LedgerEntry[] {
  return (allRows()[LEDGER_KEY] ?? []) as LedgerEntry[]
}

export function currentRevision(): number {
  return ensureLoaded().meta.revision
}

/**
 * 整库原子提交：环次进度、贯通时间、贯通台账、进度节点回写必须一起提交，
 * 有一环写不成就整体不提交（调用方在提交前先做完全量校验）。
 * 带着读到时的版本号提交；版本对不上说明已有别的写入，抛 StaleCommitError，
 * 由调用方重读重试，旧结果不许顶上来。
 */
export function commitState(next: StoreState, expectedRevision: number): number {
  const current = ensureLoaded()
  if (current.meta.revision !== expectedRevision) {
    throw new StaleCommitError(expectedRevision, current.meta.revision)
  }
  const nextMeta: StoreMeta = { ...current.meta, revision: current.meta.revision + 1 }
  cache = next
  meta = nextMeta
  persist(next, nextMeta)
  return nextMeta.revision
}

/** 单模块保存：同样走带版本号的原子提交，避免和批量入口各写一套写库逻辑。 */
export function saveRows(key: string, rows: EntryRow[]): void {
  const current = ensureLoaded()
  commitState({ ...current.state, [key]: rows }, current.meta.revision)
}

export function resetRows(key: string): EntryRow[] {
  const current = ensureLoaded()
  const rows = clone(SEED_ROWS[key] ?? [])
  const next = { ...current.state, [key]: rows }
  // 环次回到初始数据时，贯通台账也回到与初始环次一致的那份。
  if (key === RING_KEY) {
    next[LEDGER_KEY] = buildLedger(rows)
  }
  commitState(next, current.meta.revision)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
