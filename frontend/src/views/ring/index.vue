<template>
  <section class="page" data-module="ring">
    <header class="page-head">
      <div>
        <h2>掘进环次管理</h2>
        <p class="page-desc">维护掘进环，围绕环号、区间、起始里程、掘进速度、总推力做登记、筛选与状态流转。批量确认整组一次提交，一环失败全组退回。</p>
      </div>
      <div class="page-actions">
        <label class="crew-switch">
          当前班组
          <select :value="store.crew" @change="onCrewChange">
            <option v-for="crew in store.crewOptions" :key="crew" :value="crew">{{ crew }}</option>
          </select>
        </label>
        <button class="btn primary" type="button" @click="openCreate">登记掘进环</button>
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
      <label class="batch-check">
        <input
          type="checkbox"
          :checked="allVisibleSelected"
          :indeterminate.prop="someVisibleSelected && !allVisibleSelected"
          @change="toggleAllVisible"
        />
        全选本页
      </label>
      <button class="btn primary" type="button" :disabled="submitting" @click="submitBatch">
        {{ submitting ? '提交中…' : `批量确认贯通（已选 ${selectedIds.size} 环）` }}
      </button>
      <span class="batch-hint">勾选多环后一次提交：每环进度与贯通时间同事务落库，任一环写不成整组退回</span>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th class="col-check">选择</th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td class="col-check">
            <input
              type="checkbox"
              :value="Number(row.id)"
              v-model="selection"
              :disabled="submitting"
            />
          </td>
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
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
          <td :colspan="columns.length + 3" class="empty-state">暂无掘进环次数据，可先登记掘进环</td>
        </tr>
      </tbody>
    </table>

    <div v-if="lastResult" class="result-panel" :class="lastResult.ok ? 'result-ok' : 'result-fail'">
      <header class="result-head">
        <strong>{{ lastResult.ok ? '提交成功' : '整组退回' }}</strong>
        <span>{{ lastResult.message }}</span>
        <button class="link" type="button" @click="clearResult">收起</button>
      </header>
      <ul v-if="lastResult.items.length" class="result-items">
        <li v-for="item in lastResult.items" :key="item.ringId" :class="item.ok ? 'item-ok' : 'item-fail'">
          <span class="item-ring">{{ item.ringNo }}</span>
          <span class="item-msg">{{ item.message }}</span>
        </li>
      </ul>
      <button v-if="!lastResult.ok && selectedIds.size" class="btn" type="button" :disabled="submitting" @click="submitBatch">
        按当前选择重试
      </button>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条掘进环次记录（按环号顺序排列）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  confirmRings,
  downloadEntries,
  getRingMetrics,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { RING_ACTION_CONFIRM, sortByRingNo } from '@/data/ring-domain'
import { useSessionStore } from '@/stores/session'
import type { EntryRow, RingConfirmResult } from '@/data/types'

const store = useSessionStore()
const meta = moduleMeta('ring')
const columns = ["环号", "区间", "起始里程", "掘进速度", "总推力", "刀盘扭矩", "出土方量", "掘进班组", "贯通时间", "环次状态"]
const actions = ["开始掘进", "确认完成", "申请纠偏"]
const statuses = ["待掘进", "掘进中", "已贯通", "已纠偏"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["环号", "区间", "掘进班组"]
const selection = ref<number[]>([])
const submitting = ref(false)
const lastResult = ref<RingConfirmResult | null>(null)
// 每次提交递增的序号：只认本次提交回来的结果，慢回来的旧结果不许顶上来。
let requestToken = 0

const stats = computed(() => {
  const metrics = getRingMetrics()
  return [
    { label: '本月贯通环数（贯通台账）', value: metrics.monthlyThrough },
    { label: '平均掘进速度', value: metrics.averageSpeed },
    { label: '纠偏环数', value: metrics.corrected },
  ]
})

const selectedIds = computed(() => new Set(selection.value))
const visibleIds = computed(() => rows.value.map((row) => Number(row.id)))
const allVisibleSelected = computed(
  () => visibleIds.value.length > 0 && visibleIds.value.every((id) => selectedIds.value.has(id)),
)
const someVisibleSelected = computed(() => visibleIds.value.some((id) => selectedIds.value.has(id)))

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function onCrewChange(event: Event) {
  store.setCrew((event.target as HTMLSelectElement).value)
  clearResult()
}

function toggleAllVisible(event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  const set = selectedIds.value
  if (checked) {
    visibleIds.value.forEach((id) => set.add(id))
  } else {
    visibleIds.value.forEach((id) => set.delete(id))
  }
  selection.value = [...set]
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '掘进环登记入口尚未接入审批流'
}

function clearResult() {
  lastResult.value = null
}

// 单条确认与批量确认共用这一个提交入口，背后是同一套事务写库逻辑。
async function confirmSelection(ids: number[]) {
  if (submitting.value) return
  clearResult()
  errorMessage.value = ''
  const token = ++requestToken
  submitting.value = true
  // 让按钮的「提交中」状态先渲染，同时也模拟出真实提交的异步窗口。
  await new Promise((resolve) => window.setTimeout(resolve, 60))
  try {
    const result = confirmRings(ids, store.crew)
    // 提交返回列表再看一次：只认最新一次提交的结果，旧结果不许顶上来。
    if (token === requestToken) {
      lastResult.value = result
      reload()
    }
  } catch (error) {
    if (token === requestToken) {
      errorMessage.value = error instanceof Error ? error.message : '贯通确认提交失败，可重试'
    }
  } finally {
    if (token === requestToken) {
      submitting.value = false
    }
  }
}

function submitBatch() {
  const ids = sortByRingNo(
    selection.value.map((id) => ({ id, 环号: rows.value.find((row) => Number(row.id) === id)?.['环号'] ?? '' })),
    (item) => item['环号'],
  ).map((item) => item.id)
  if (!ids.length) {
    errorMessage.value = '请先勾选要确认贯通的环次'
    return
  }
  void confirmSelection(ids)
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  if (action === RING_ACTION_CONFIRM) {
    void confirmSelection([Number(row.id)])
    return
  }
  const result = applyAction(meta.key, Number(row.id), action, store.crew)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    // 列表一律按环号顺序展示，批量勾选后重排的次序不会串位。
    rows.value = sortByRingNo(payload.items, (row) => row['环号'])
    total.value = payload.total
    const live = new Set(rows.value.map((row) => Number(row.id)))
    selection.value = selection.value.filter((id) => live.has(id))
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '掘进环次列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.page-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.crew-switch {
  font-size: 12px;
  color: var(--muted);
  display: flex;
  align-items: center;
  gap: 6px;
}
.crew-switch select {
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.batch-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 10px;
}
.batch-check {
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.batch-hint {
  font-size: 12px;
  color: var(--muted);
}
.col-check {
  width: 44px;
  text-align: center;
}
.result-panel {
  margin-top: 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: #fff;
  padding: 10px 12px;
}
.result-ok {
  border-color: #86efac;
  background: #f0fdf4;
}
.result-fail {
  border-color: #fca5a5;
  background: #fef2f2;
}
.result-head {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
.result-head span {
  color: var(--muted);
  flex: 1;
}
.result-items {
  list-style: none;
  margin: 8px 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.result-items li {
  font-size: 13px;
  display: flex;
  gap: 8px;
}
.item-ring {
  font-weight: 600;
  min-width: 42px;
}
.item-ok {
  color: #166534;
}
.item-fail {
  color: #b42318;
}
</style>
