import { SEED_ROWS } from './seed'
import { buildLedgerFromRings, reconcileLedger, sectionOfRing } from './ring-domain'
import type { BreakthroughRecord, EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'shield-tunnel-construction:entries'

type Database = {
  modules: Record<string, EntryRow[]>
  ringLedger: BreakthroughRecord[]
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 全新库：示例数据播种，并按环号顺序把存量已贯通环补进台账。 */
function freshDatabase(): Database {
  const modules = clone(SEED_ROWS)
  const ringLedger = buildLedgerFromRings(modules.ring ?? [])
  return { modules, ringLedger }
}

/**
 * 老数据兼容：旧版本只存了各模块的行数组，没有贯通台账。
 * 迁移时补区间、统一 pending，并把存量已贯通环按环号顺序补进台账；
 * 进度节点补上在办清单字段，实际掘进量以台账为准对齐。
 */
function migrateLegacy(legacy: Record<string, EntryRow[]>): Database {
  const modules: Record<string, EntryRow[]> = {}
  for (const [key, rows] of Object.entries(legacy)) {
    modules[key] = rows.map((row) => ({ ...row }))
  }

  const rings = modules.ring ?? []
  for (const row of rings) {
    if (!String(row['区间'] ?? '').trim()) {
      row['区间'] = sectionOfRing(row)
    }
    row.pending = String(row.status) !== '已贯通'
  }

  const ringLedger = reconcileLedger([], rings)

  const progressRows = modules.progress ?? []
  for (const node of progressRows) {
    if (!String(node['区间'] ?? '').trim()) {
      node['区间'] = ''
    }
    if (!String(node['在办清单'] ?? '').trim()) {
      node['在办清单'] = ''
    }
    if (!String(node['确认结论'] ?? '').trim()) {
      node['确认结论'] = ''
    }
  }

  return { modules, ringLedger }
}

function isDatabase(value: unknown): value is Database {
  return (
    typeof value === 'object' &&
    value !== null &&
    'modules' in value &&
    typeof (value as Database).modules === 'object'
  )
}

function persist(db: Database): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(db))
  }
}

function readStorage(): Database {
  const fallback = freshDatabase()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    persist(fallback)
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    // 老版本结构：直接是模块名 -> 行数组，迁移一次再写回。
    if (!isDatabase(parsed)) {
      const migrated = migrateLegacy(parsed as Record<string, EntryRow[]>)
      persist(migrated)
      return migrated
    }
    const db: Database = {
      modules: { ...clone(SEED_ROWS), ...clone(parsed.modules) },
      ringLedger: Array.isArray(parsed.ringLedger) ? clone(parsed.ringLedger) : [],
    }
    // 每次读取都与环次现状对齐一次：补区间、存量已贯通环补台账、退环的出台账。
    let changed = false
    for (const row of db.modules.ring ?? []) {
      if (!String(row['区间'] ?? '').trim()) {
        row['区间'] = sectionOfRing(row)
        changed = true
      }
      const pending = String(row.status) !== '已贯通'
      if (Boolean(row.pending) !== pending) {
        row.pending = pending
        changed = true
      }
    }
    const beforeLedger = db.ringLedger.length
    db.ringLedger = reconcileLedger(db.ringLedger, db.modules.ring ?? [])
    if (db.ringLedger.length !== beforeLedger) {
      changed = true
    }
    for (const node of db.modules.progress ?? []) {
      if (!String(node['在办清单'] ?? '').trim()) {
        node['在办清单'] = ''
        changed = true
      }
      if (!String(node['确认结论'] ?? '').trim()) {
        node['确认结论'] = ''
        changed = true
      }
    }
    if (changed) {
      persist(db)
    }
    return db
  } catch {
    persist(fallback)
    return fallback
  }
}

let cache: Database | null = null

function db(): Database {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function allRows(): Record<string, EntryRow[]> {
  return db().modules
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function listRingLedger(): BreakthroughRecord[] {
  return db().ringLedger
}

/** 环次确认的事务落点：整组通过校验后，环次与台账、节点在一次写入里提交。 */
export function commitRingConfirmation(input: {
  rings: EntryRow[]
  ledger: BreakthroughRecord[]
  progress: EntryRow[]
}): void {
  const next: Database = {
    modules: { ...db().modules, ring: input.rings, progress: input.progress },
    ringLedger: input.ledger,
  }
  cache = next
  persist(next)
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next: Database = {
    modules: { ...db().modules, [key]: rows },
    ringLedger: db().ringLedger,
  }
  cache = next
  persist(next)
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  const current = db()
  const nextModules = { ...current.modules, [key]: rows }
  // 重置环次或进度后，台账按新环次重新对齐，避免两处口径再分叉。
  const ringLedger =
    key === 'ring' || key === 'progress'
      ? reconcileLedger(key === 'ring' ? [] : current.ringLedger, nextModules.ring ?? [])
      : current.ringLedger
  cache = { modules: nextModules, ringLedger }
  persist(cache)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

/** 测试辅助：清掉内存缓存，强制下次从 localStorage 重读。 */
export function __resetCache(): void {
  cache = null
}
