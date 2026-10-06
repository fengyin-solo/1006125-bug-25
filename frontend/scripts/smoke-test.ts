/* 数据层冒烟测试：内存版 localStorage + 真实模块代码，分场景独立进程运行。 */
import { confirmRings, getRingMetrics, runAction } from '@/api/local-service'
import { allRows, currentRevision } from '@/data/local-store'
import { LEDGER_KEY, RING_KEY, PROGRESS_KEY } from '@/data/ring-domain'
import type { EntryRow } from '@/data/types'

type Store = Record<string, unknown>

function installStorage(initial?: string): Store {
  const memory = new Map<string, string>()
  if (initial !== undefined) memory.set('shield-tunnel-construction:entries', initial)
  const store: Store = {}
  globalThis.window = {
    localStorage: {
      getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
      setItem: (key: string, value: string) => void memory.set(key, value),
      removeItem: (key: string) => void memory.delete(key),
    },
  } as unknown as Store
  return store
}

function persisted(): Record<string, unknown> {
  const text = (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage.getItem(
    'shield-tunnel-construction:entries',
  )
  return JSON.parse(text)
}

let failures = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

function ring(id: number): EntryRow {
  const rows = allRows()[RING_KEY] as EntryRow[]
  return rows.find((row) => Number(row.id) === id)!
}
function ledger(): EntryRow[] {
  return allRows()[LEDGER_KEY] as EntryRow[]
}
function progressNode(name: string): EntryRow {
  return (allRows()[PROGRESS_KEY] as EntryRow[]).find((row) => row['节点名称'] === name)!
}

const NOW = new Date('2026-10-06T12:00:00')

function scenarioHappyPath(): void {
  installStorage()
  console.log('场景 A：5 环批量确认 + 连点两回只记最早贯通时间')
  check('初始本月贯通 4 环（R01/R02/R03/R09）', getRingMetrics(NOW).monthlyThrough === 4)

  const result = confirmRings([8, 6, 7, 4, 5], '掘进甲班', new Date('2026-10-05T10:00:00'))
  check('整组提交成功', result.ok && result.committed, result.message)
  check('逐条结果 5 条且全部 ok', result.items.length === 5 && result.items.every((i) => i.ok),
    result.items.map((i) => i.message).join(' | '))
  check('逐条按环号顺序返回', result.items.map((i) => i.ringNo).join(',') === 'R04,R05,R06,R07,R08')
  check('5 环均为已贯通', [4, 5, 6, 7, 8].every((id) => ring(id).status === '已贯通'))
  check('5 环贯通时间相同（同一事务时刻）',
    new Set([4, 5, 6, 7, 8].map((id) => ring(id)['贯通时间'])).size === 1)
  check('贯通时间为提交时刻', String(ring(4)['贯通时间']) === '2026-10-05 10:00')
  check('台账 9 条（每环一条）', ledger().length === 9, `实际 ${ledger().length}`)
  check('本月贯通变为 9 环', getRingMetrics(NOW).monthlyThrough === 9)
  const left = progressNode('左线区间掘进')
  check('进度节点实际掘进量回写为 8', Number(left['实际掘进量']) === 8, String(left['实际掘进量']))
  check('进度节点在办清单清空', String(left['贯通在办']) === '', String(left['贯通在办']))
  const right = progressNode('右线区间掘进')
  check('右线节点不串写', Number(right['实际掘进量']) === 1 && String(right['贯通在办']) === 'R10')

  const repeat = confirmRings([4, 5], '掘进甲班', new Date('2026-10-06T18:30:00'))
  check('重复提交仍成功（幂等）', repeat.ok)
  check('重复提交不再写入', repeat.committed === false)
  check('台账仍 9 条', ledger().length === 9)
  check('贯通时间保持最早一次', String(ring(4)['贯通时间']) === '2026-10-05 10:00')
  check('本月贯通仍 9 环', getRingMetrics(NOW).monthlyThrough === 9)
}

function scenarioAtomicFail(): void {
  installStorage()
  console.log('场景 B：混入跨班组环 → 整组退回，逐条给出失败环号')
  const before = ring(4)
  const result = confirmRings([10, 4], '掘进甲班', new Date('2026-10-05T10:00:00'))
  check('整组失败', !result.ok && !result.committed, result.message)
  const r10 = result.items.find((i) => i.ringNo === 'R10')
  const r04 = result.items.find((i) => i.ringNo === 'R04')
  check('R10 逐条报跨班组原因', !!r10 && !r10.ok && r10.message.includes('跨班组'), r10?.message)
  check('R04 逐条报整组退回未落库', !!r04 && !r04.ok && r04.message.includes('整组退回'), r04?.message)
  check('R04 状态未动', ring(4).status === before.status)
  check('R04 没有贯通时间', String(ring(4)['贯通时间']) === '')
  check('台账未增加（仍 4 条）', ledger().length === 4)
  check('本月贯通仍 4 环', getRingMetrics(NOW).monthlyThrough === 4)
  check('进度节点在办清单未被改动', String(progressNode('左线区间掘进')['贯通在办']) === 'R04、R05、R06、R07、R08')
}

function scenarioSingleAndAuth(): void {
  installStorage()
  console.log('场景 C：单条入口走同一核心；越级/跨班组不收')
  const single = runAction('ring', 4, '确认完成', '掘进甲班')
  check('单条确认成功', single.ok, single.message)
  check('单条也记贯通时间', String(ring(4)['贯通时间']).startsWith('2026-10'), String(ring(4)['贯通时间']))
  check('台账 +1（5 条）', ledger().length === 5)
  const again = runAction('ring', 4, '确认完成', '掘进甲班')
  check('单条重复确认不报错且不重复入账', again.ok && ledger().length === 5, again.message)

  const outsider = runAction('ring', 5, '确认完成', '注浆班')
  check('非掘进班组（越级）不收', !outsider.ok && outsider.message.includes('越级'), outsider.message)
  check('R05 未被写入', ring(5).status === '掘进中' && String(ring(5)['贯通时间']) === '')

  const cross = runAction('ring', 10, '确认完成', '掘进甲班')
  check('跨区间（甲班确认右线）不收', !cross.ok && cross.message.includes('跨班组'), cross.message)
  check('R10 未被写入', ring(10).status === '掘进中')

  const rightOwner = runAction('ring', 10, '确认完成', '掘进乙班', )
  check('本班组确认本区间成功', rightOwner.ok, rightOwner.message)
}

function scenarioMigration(): void {
  console.log('场景 D：老数据（v1，无区间/贯通时间、台账有重复）迁移兼容')
  const old = {
    ring: [
      // 存量真实数据：缺「区间」「贯通时间」字段（两环都属甲班左线）
      { id: 2, status: '掘进中', pending: true, abnormal: false, 环号: 'R12', 起始里程: 'K12+113.5', 掘进速度: '46', 总推力: '18700', 刀盘扭矩: '3300', 出土方量: '22', 掘进班组: '掘进甲班', 环次状态: '掘进中' },
      { id: 1, status: '已贯通', pending: false, abnormal: false, 环号: 'R01', 起始里程: 'K12+100.0', 掘进速度: '42', 总推力: '18500', 刀盘扭矩: '3200', 出土方量: '58', 掘进班组: '掘进甲班', 环次状态: '已贯通' },
    ],
    progress: [
      { id: 1, status: '进行中', pending: true, abnormal: false, 节点编号: 'PROG-0001', 节点名称: '左线区间掘进', 计划完成日: '2026-11-30', 实际完成日: '', 计划掘进量: '60', 实际掘进量: '0', 偏差天数: '', 节点状态: '进行中' },
    ],
    // 老 bug 造成的同环重复贯通记录，时间一新一旧
    __ring_ledger__: [
      { id: 1, status: '已贯通', pending: false, abnormal: false, 环号: 'R01', 区间: '左线', 掘进班组: '掘进甲班', 贯通时间: '2026-10-05 09:00' },
      { id: 1, status: '已贯通', pending: false, abnormal: false, 环号: 'R01', 区间: '左线', 掘进班组: '掘进甲班', 贯通时间: '2026-10-04 08:00' },
    ],
  }
  installStorage(JSON.stringify(old))
  const rings = allRows()[RING_KEY] as EntryRow[]
  check('存量环次按环号顺序排列', rings.map((r) => r['环号']).join(',') === 'R01,R12')
  check('老环补出区间', rings.every((r) => String(r['区间']) === '左线'))
  check('老环贯通时间字段补齐（缺则留空）', rings.some((r) => String(r['贯通时间']) === ''))
  check('台账重复记录去重为 1 条', ledger().length === 1, `实际 ${ledger().length}`)
  check('保留最早贯通时间', String(ledger()[0]['贯通时间']) === '2026-10-04 08:00')
  check('本月贯通 1 环', getRingMetrics(NOW).monthlyThrough === 1)
  const left = progressNode('左线区间掘进')
  check('老节点补出所属区间', String(left['所属区间']) === '左线')
  check('老节点实际掘进量按台账回写为 1', Number(left['实际掘进量']) === 1, String(left['实际掘进量']))
  check('老节点在办清单回写 R12', String(left['贯通在办']) === 'R12', String(left['贯通在办']))
  const onDisk = persisted()
  check('迁移后版本号落盘为 2', Number((onDisk.__meta__ as { schemaVersion: number })?.schemaVersion) === 2)
  check('迁移后仍可正常提交', confirmRings([2], '掘进甲班', new Date('2026-10-05T11:00:00')).ok)
  check('版本号随提交递增', currentRevision() === 2)
}

const scenario = process.argv[2]
if (scenario === 'A') scenarioHappyPath()
else if (scenario === 'B') scenarioAtomicFail()
else if (scenario === 'C') scenarioSingleAndAuth()
else if (scenario === 'D') scenarioMigration()
else throw new Error(`未知场景 ${scenario}`)

if (failures > 0) {
  console.error(`\n${failures} 项断言失败`)
  process.exit(1)
}
console.log('全部通过')
