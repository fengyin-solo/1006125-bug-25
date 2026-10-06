<template>
  <section class="page" data-module="ring">
    <header class="page-head">
      <div>
        <h2>掘进环次管理</h2>
        <p class="page-desc">
          收工时勾选多环一次批量确认贯通：整组同事务落库，一环不过全组退回；
          当前班组「{{ store.currentCrew }} · {{ store.currentSection }}」只能确认本区间环次。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出掘进环次清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <div class="batch-bar">
      <label class="select-all">
        <input
          type="checkbox"
          :checked="allVisibleSelected"
          :indeterminate.prop="someVisibleSelected && !allVisibleSelected"
          @change="toggleSelectAll"
        />
        本页全选
      </label>
      <button
        class="btn primary"
        type="button"
        :disabled="submitting || selectedIds.size === 0"
        @click="confirmSelected"
      >
        {{ submitting ? '确认中…' : `批量确认已贯通（已选 ${selectedIds.size} 环）` }}
      </button>
      <button class="btn ghost" type="button" :disabled="selectedIds.size === 0" @click="selectedIds.clear()">
        清除勾选
      </button>
      <span class="batch-hint">只接受本班组区间内、当前为「掘进中」的环；任一环不符，整组退回。</span>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th class="check-col">选择</th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td class="check-col">
            <input type="checkbox" :value="Number(row.id)" v-model="selectedRowIds" />
          </td>
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              :disabled="submitting"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无掘进环次数据</td>
        </tr>
      </tbody>
    </table>

    <div v-if="confirmResult" class="result-panel" :class="confirmResult.ok ? 'result-ok' : 'result-fail'">
      <header class="result-head">
        <strong>{{ confirmResult.ok ? '提交成功' : '整组退回' }}</strong>
        <span>{{ confirmResult.message }}</span>
        <button class="link" type="button" @click="confirmResult = null">关闭</button>
      </header>
      <ul class="result-list">
        <li v-for="item in confirmResult.items" :key="item.id" :class="`item-${item.state}`">
          <span class="item-ring">环号 {{ item.环号 }}</span>
          <span class="item-state">{{ stateLabel(item.state) }}</span>
          <span v-if="item.reason" class="item-reason">{{ item.reason }}</span>
        </li>
      </ul>
    </div>

    <section class="ledger-panel">
      <header class="ledger-head">
        <h3>贯通台账（本月贯通 {{ stats[0].value }} 环，以台账为唯一口径）</h3>
        <span class="batch-hint">反复提交只入一条，贯通时间保留最早那次；台账按环号排序。</span>
      </header>
      <table class="data-table">
        <thead>
          <tr><th>环号</th><th>区间</th><th>掘进班组</th><th>贯通时间</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in ledger" :key="item.ringId">
            <td>{{ item.环号 }}</td>
            <td>{{ item.区间 }}</td>
            <td>{{ item.掘进班组 }}</td>
            <td>{{ item.贯通时间 || '—（老数据未记录）' }}</td>
          </tr>
          <tr v-if="!ledger.length">
            <td colspan="4" class="empty-state">台账暂无贯通记录</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条掘进环次记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  confirmRings,
  downloadEntries,
  getRingLedger,
  getRingStats,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type { BreakthroughRecord, EntryRow, RingConfirmItemState, RingConfirmResult } from '@/data/types'

const meta = moduleMeta('ring')
const store = useSessionStore()
// 环次状态单独用状态列展示，不与业务字段列重复。
const columns = ["环号", "区间", "起始里程", "掘进速度", "总推力", "刀盘扭矩", "出土方量", "掘进班组", "贯通时间"]
const actions = ["开始掘进", "申请纠偏", "确认完成"]
const statuses = ["待掘进", "掘进中", "已贯通", "已纠偏"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["环号", "区间", "掘进班组"]
const selectedRowIds = ref<number[]>([])
const submitting = ref(false)
const confirmResult = ref<RingConfirmResult | null>(null)
const ledger = ref<BreakthroughRecord[]>([])
// 每次提交一个自增序号：返回列表后旧序号的结果一律丢弃，不许顶上来。
let submitSeq = 0

const stats = computed(() => {
  const summary = getRingStats()
  return [
    { label: '本月贯通环数', value: summary.monthBreakthrough },
    { label: '平均掘进速度(mm/min)', value: summary.averageSpeed },
    { label: '纠偏环数', value: summary.correctedCount },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 勾选集合以 id 为准，筛选/重排后次序不会串。
const selectedIds = computed(() => new Set(selectedRowIds.value))
const visibleIds = computed(() => rows.value.map((row) => Number(row.id)))
const allVisibleSelected = computed(
  () => visibleIds.value.length > 0 && visibleIds.value.every((id) => selectedIds.value.has(id)),
)
const someVisibleSelected = computed(() => visibleIds.value.some((id) => selectedIds.value.has(id)))

function toggleSelectAll(event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  const keep = selectedRowIds.value.filter((id) => !visibleIds.value.includes(id))
  selectedRowIds.value = checked ? keep.concat(visibleIds.value) : keep
}

function stateLabel(state: RingConfirmItemState): string {
  switch (state) {
    case 'confirmed':
      return '已贯通'
    case 'skipped':
      return '已贯通·重复提交跳过'
    case 'returned':
      return '随组退回'
    case 'failed':
    default:
      return '失败'
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

// 提交后重新从数据层读取一次；失败后允许原样重试，旧结果不会顶掉新结果。
function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    ledger.value = getRingLedger()
    // 清掉已经不在列表/已贯通的勾选，避免拿旧选择再提。
    const live = new Set(rows.value.filter((row) => String(row.status) === '掘进中').map((row) => Number(row.id)))
    selectedRowIds.value = selectedRowIds.value.filter((id) => live.has(id))
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '掘进环次列表读取失败'
  }
}

async function submitConfirmation(ids: number[]) {
  if (submitting.value) {
    return
  }
  submitting.value = true
  errorMessage.value = ''
  const seq = ++submitSeq
  try {
    // 事务在数据层同步完成，这里包一层微任务只是防止连点；旧序号结果直接丢弃。
    await Promise.resolve()
    const result = confirmRings(ids, store.currentCrew)
    if (seq !== submitSeq) {
      return
    }
    confirmResult.value = result
    if (!result.ok) {
      errorMessage.value = result.message
    }
  } finally {
    if (seq === submitSeq) {
      submitting.value = false
    }
    reload()
  }
}

function confirmSelected() {
  const ids = [...selectedIds.value]
  if (ids.length === 0) {
    errorMessage.value = '请先勾选要确认贯通的环次'
    return
  }
  void submitConfirmation(ids)
}

function runAction(action: string, row: EntryRow) {
  if (action === '确认完成') {
    // 单条入口与批量入口共用同一套事务逻辑，不再各写一遍写库。
    void submitConfirmation([Number(row.id)])
    return
  }
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

onMounted(reload)
</script>

<style scoped>
.batch-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  padding: 8px 10px;
  background: #eef4ff;
  border: 1px solid #cfe0ff;
  border-radius: 8px;
}
.select-all {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.check-col {
  width: 42px;
  text-align: center;
}
.batch-hint {
  color: var(--muted);
  font-size: 12px;
}
.result-panel,
.ledger-panel {
  margin-top: 14px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: #fff;
  overflow: hidden;
}
.result-panel {
  border-width: 1px;
}
.result-ok {
  border-color: #86c9a3;
  background: #f1faf5;
}
.result-fail {
  border-color: #f0a8a0;
  background: #fdf3f2;
}
.result-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  font-size: 13px;
  border-bottom: 1px dashed var(--border);
}
.result-head button {
  margin-left: auto;
}
.result-list {
  list-style: none;
  margin: 0;
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}
.item-ring {
  font-weight: 600;
  margin-right: 8px;
}
.item-state {
  margin-right: 8px;
}
.item-confirmed .item-state {
  color: #117a3d;
}
.item-skipped .item-state {
  color: #8a6d1d;
}
.item-failed .item-state,
.item-returned .item-state {
  color: #b42318;
}
.item-reason {
  color: var(--muted);
}
.ledger-panel {
  margin-top: 18px;
}
.ledger-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 8px 12px;
}
.ledger-head h3 {
  margin: 0;
  font-size: 14px;
}
.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
</style>
