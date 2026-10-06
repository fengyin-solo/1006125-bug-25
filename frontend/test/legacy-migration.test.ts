// 老版本存储迁移验证：旧结构只有 modules 行数组，没有 ringLedger / 区间 / 在办清单。
import { __resetCache, listRows, listRingLedger } from '@/data/local-store'

let mem = new Map<string, string>()
Object.assign(globalThis, {
  window: {
    localStorage: {
      getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
    },
  },
})

let passed = 0
let failed = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    passed++
    console.log(`PASS  ${name}`)
  } else {
    failed++
    console.error(`FAIL  ${name} ${extra}`)
  }
}

// 构造一份典型旧数据：环号带 L/R 前缀但没有「区间」字段；有2环已贯通但无台账。
const legacy = {
  ring: [
    { id: 1, status: '掘进中', pending: true, abnormal: false, 环号: 'L301', 起始里程: 'K3+000', 掘进班组: '掘进一班' },
    { id: 2, status: '已贯通', pending: false, abnormal: false, 环号: 'R250', 起始里程: 'K2+000', 掘进班组: '掘进二班', 贯通时间: '2026-10-02 10:00' },
    { id: 3, status: '已贯通', pending: false, abnormal: false, 环号: 'R251', 起始里程: 'K2+001', 掘进班组: '掘进二班', 贯通时间: '2026-10-03 11:00' },
  ],
  progress: [
    { id: 1, status: '进行中', pending: true, abnormal: false, 节点编号: 'P1', 节点名称: '老节点', 计划完成日: '2026-10-20' },
  ],
}
mem.set('shield-tunnel-construction:entries', JSON.stringify(legacy))
__resetCache()

// 首次读取触发迁移
const rings = listRows('ring')
check('迁移后3环都在', rings.length === 3)
check('老数据 L301 区间按环号前缀补成左线', rings[0]['区间'] === '左线', String(rings[0]['区间']))
check('老数据 R250 区间按环号前缀补成右线', rings[1]['区间'] === '右线', String(rings[1]['区间']))

const ledger = listRingLedger()
check('存量已贯通2环按环号顺序补进台账', ledger.length === 2 && ledger[0].环号 === 'R250' && ledger[1].环号 === 'R251', JSON.stringify(ledger.map((i) => i.环号)))
check('补进台账保留原贯通时间', ledger[0].贯通时间 === '2026-10-02 10:00', JSON.stringify(ledger))
check('台账环带区间与班组', ledger[0].区间 === '右线' && ledger[0].掘进班组 === '掘进二班')

const nodes = listRows('progress')
check('老进度节点补在办清单字段', Object.prototype.hasOwnProperty.call(nodes[0], '在办清单') && nodes[0]['在办清单'] === '', JSON.stringify(nodes[0]))
check('老进度节点补确认结论字段', Object.prototype.hasOwnProperty.call(nodes[0], '确认结论'))

// 迁移结果已写回存储，且写回的是新结构
const written = JSON.parse(mem.get('shield-tunnel-construction:entries')!)
check('写回存储含 ringLedger 新结构', Array.isArray(written.ringLedger) && written.ringLedger.length === 2, Object.keys(written).join(','))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
