import { __resetCache, resetRows, listRows } from '@/data/local-store'
import { listEntries, confirmRings, getRingLedger, getRingStats, loadOverview, runAction } from '@/api/local-service'

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

function resetAll() {
  mem.clear()
  __resetCache()
  resetRows('ring')
  resetRows('progress')
}

// 用例1：批量5环（含1环待掘进越级），整组退回，一环不落，逐条有失败原因
resetAll()
// L105-L109 掘进中（5环），把 L109 改成待掘进模拟越级混入
{
  const rows = listRows('ring').map((r) => (r['环号'] === 'L109' ? { ...r, status: '待掘进', pending: true } : r))
  // 直接写回存储（绕过服务动作）
  const storage = JSON.parse(mem.get('shield-tunnel-construction:entries')!)
  storage.modules.ring = rows
  mem.set('shield-tunnel-construction:entries', JSON.stringify(storage))
  __resetCache()
}
{
  const ids = [5, 6, 7, 8, 9] // L105..L109
  const res = confirmRings(ids, '掘进一班')
  check('1. 越级混入时整组 ok=false', res.ok === false && res.committed === false, res.message)
  check('1. 逐条结果5条齐全', res.items.length === 5, `got ${res.items.length}`)
  const failedItems = res.items.filter((i) => i.state === 'failed')
  check('1. 失败原因点名 L109', failedItems.some((i) => i.环号 === 'L109' && /L109/.test(i.reason ?? '')), JSON.stringify(failedItems))
  const returned = res.items.filter((i) => i.state === 'returned')
  check('1. 其余4环标记随组退回', returned.length === 4 && returned.every((i) => i.ok === false), `returned=${returned.length}`)
  // 库里一环都没变
  const tunneling = listRows('ring').filter((r) => ['L105', 'L106', 'L107', 'L108'].includes(String(r['环号'])))
  check('1. 全组退回后4环仍是掘进中', tunneling.every((r) => r.status === '掘进中'), JSON.stringify(tunneling.map((r) => [r['环号'], r.status])))
  check('1. 台账仍只有种子4环', getRingLedger().length === 4, `ledger=${getRingLedger().length}`)
}

// 用例2：5环全部掘进中，一次提交全部贯通
resetAll()
{
  const res = confirmRings([5, 6, 7, 8, 9], '掘进一班')
  check('2. 5环整组提交成功', res.ok && res.committed && res.confirmedCount === 5, res.message)
  check('2. 逐条结果5条且均 confirmed', res.items.length === 5 && res.items.every((i) => i.state === 'confirmed'), JSON.stringify(res.items.map((i) => i.state)))
  const rows = listRows('ring').filter((r) => Number(r.id) >= 5 && Number(r.id) <= 9)
  check('2. 5环状态都已贯通且有贯通时间', rows.every((r) => r.status === '已贯通' && String(r['贯通时间']).length > 0), JSON.stringify(rows.map((r) => [r['环号'], r.status, r['贯通时间']])))
  check('2. 贯通时间同一时刻（同事务）', new Set(rows.map((r) => String(r['贯通时间']))).size === 1)
  check('2. 台账增加到9环且按环号排序', (() => {
    const ledger = getRingLedger().map((i) => i.环号)
    const sorted = [...ledger].sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')))
    return ledger.length === 9 && JSON.stringify(ledger) === JSON.stringify(sorted)
  })(), JSON.stringify(getRingLedger().map((i) => i.环号)))
}

// 用例3：连点两回，只记最早贯通时间，台账不重复
resetAll()
{
  const first = confirmRings([5, 6], '掘进一班')
  const t1 = first.confirmedAt!
  const second = confirmRings([5, 6], '掘进一班')
  check('3. 第二回幂等成功但不提交', second.ok === true && second.committed === false && second.skippedCount === 2, second.message)
  const ledger = getRingLedger().filter((i) => ['L105', 'L106'].includes(i.环号))
  check('3. 台账每环仅一条', ledger.length === 2, `n=${ledger.length}`)
  check('3. 贯通时间保留最早那次', ledger.every((i) => i.贯通时间 === t1), JSON.stringify(ledger.map((i) => [i.环号, i.贯通时间, t1])))
  // 环行上的贯通时间也没变
  const rows = listRows('ring').filter((r) => ['L105', 'L106'].includes(String(r['环号'])))
  check('3. 环行贯通时间未被第二回覆盖', rows.every((r) => r['贯通时间'] === t1))
}

// 用例4：跨班组确认不收（一班勾右线环）
resetAll()
{
  const res = confirmRings([12], '掘进一班') // R201 右线
  check('4. 跨班组被拒且整组退回', res.ok === false, res.message)
  check('4. 失败原因点名 R201 与区间', res.items.some((i) => i.环号 === 'R201' && /右线/.test(i.reason ?? '') && /跨班组/.test(i.reason ?? '')), JSON.stringify(res.items))
  const r201 = listRows('ring').find((r) => r['环号'] === 'R201')!
  check('4. R201 仍是掘进中', r201.status === '掘进中')
}

// 用例5：本班组确认自己区间成功（二班 R201、R202）
resetAll()
{
  const res = confirmRings([12, 13], '掘进二班')
  check('5. 二班确认右线2环成功', res.ok && res.confirmedCount === 2, res.message)
}

// 用例6：越级（待掘进 L110 / 已纠偏 L111）不收
resetAll()
{
  const a = confirmRings([10], '掘进一班')
  check('6a. 待掘进直接确认被拒（越级）', a.ok === false && /越级/.test(a.items[0]?.reason ?? ''), JSON.stringify(a.items))
  const b = confirmRings([11], '掘进一班')
  check('6b. 已纠偏直接确认被拒（越级）', b.ok === false && /越级/.test(b.items[0]?.reason ?? ''), JSON.stringify(b.items))
}

// 用例7：确认结论回写进度节点在办清单，实际掘进量=台账本月数
resetAll()
{
  const before = listRows('progress').find((n) => n['节点编号'] === 'PROG-L-202610')!
  check('7. 提交前在办6环', String(before['在办清单']).split('、').length === 6, String(before['在办清单']))
  const res = confirmRings([5, 6, 7, 8, 9], '掘进一班')
  check('7. 提交成功', res.ok, res.message)
  const after = listRows('progress').find((n) => n['节点编号'] === 'PROG-L-202610')!
  const pending = String(after['在办清单']).split('、').filter(Boolean)
  check('7. 在办清单移除5环剩 L110', pending.length === 1 && pending[0] === 'L110', String(after['在办清单']))
  const ledgerMonth = getRingStats().monthBreakthrough
  check('7. 实际掘进量与本月台账数一致', String(after['实际掘进量']) === String(ledgerMonth), `node=${after['实际掘进量']} ledger=${ledgerMonth}`)
  check('7. 确认结论已回写', /批量确认 5 环/.test(String(after['确认结论'])), String(after['确认结论']))
}

// 用例8：环次页统计、进度页、概览三处本月贯通环数同一口径
resetAll()
{
  confirmRings([5, 6, 7], '掘进一班')
  const ringStats = getRingStats().monthBreakthrough
  const node = listRows('progress').find((n) => n['节点编号'] === 'PROG-L-202610')!
  const overviewCard = loadOverview().cards.find((c) => c.label === '本月贯通环数')!.value
  check('8. 三处本月贯通环数对得上', ringStats === Number(node['实际掘进量']) && ringStats === overviewCard, `${ringStats} vs ${node['实际掘进量']} vs ${overviewCard}`)
  check('8. 本月贯通=3（种子9月贯通不计本月）', ringStats === 3, `got ${ringStats}`)
}

// 用例9：混合勾选（3环掘进中 + 1环已贯通），已贯通跳过不拦组，其余3环成功
resetAll()
{
  // 先确认 L105
  confirmRings([5], '掘进一班')
  const res = confirmRings([5, 6, 7, 8], '掘进一班')
  check('9. 混合勾选提交成功', res.ok && res.confirmedCount === 3 && res.skippedCount === 1, JSON.stringify({ ok: res.ok, c: res.confirmedCount, s: res.skippedCount }))
}

// 用例10：组内含跨班组环，全组退回
resetAll()
{
  const res = confirmRings([6, 12], '掘进一班') // L106 左线 + R201 右线
  check('10. 混组含跨区间整组退回', res.ok === false && res.items.every((i) => i.ok === false), JSON.stringify(res.items))
  check('10. L106 未落库', listRows('ring').find((r) => r['环号'] === 'L106')!.status === '掘进中')
}

// 用例11：台账去重不依赖重复提交——直接验证 ledger 中无重复 ringId
resetAll()
{
  confirmRings([5, 6], '掘进一班')
  confirmRings([5, 6], '掘进一班')
  confirmRings([5, 6, 7], '掘进一班')
  const ids = getRingLedger().map((i) => i.ringId)
  check('11. 台账 ringId 无重复', new Set(ids).size === ids.length, JSON.stringify(ids))
}

// 用例12：列表总数不丢（重排后次序不串位）——确认后行数不变，id 顺序一致
resetAll()
{
  const before = listEntries('ring').items.map((r) => r.id)
  confirmRings([5, 6, 7, 8, 9], '掘进一班')
  const after = listEntries('ring').items.map((r) => r.id)
  check('12. 批量后行序与数量不变', JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} != ${JSON.stringify(after)}`)
}

// 用例13：通用动作（开始掘进）仍走 runAction，单条确认也走 confirmRings
resetAll()
{
  const single = confirmRings([5], '掘进一班')
  check('13. 单条确认同样落库', single.ok && single.confirmedCount === 1, single.message)
  const other = runAction('ring', 10, '开始掘进')
  check('13. 通用动作可用', other.ok === true, other.message)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
