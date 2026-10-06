<template>
  <section class="page" data-module="progress">
    <header class="page-head">
      <div>
        <h2>进度节点管理</h2>
        <p class="page-desc">维护进度节点，围绕节点编号、节点名称、计划完成日、实际完成日做登记、筛选与状态流转；贯通确认结论回写到在办清单。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记进度节点</button>
        <button class="btn" type="button" @click="exportRows">导出进度节点清单</button>
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

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column" :class="{ 'cell-wrap': column === '在办清单' || column === '确认结论' }">
            {{ row[column] || (column === '在办清单' ? '—（在办已清空）' : '—') }}
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无进度节点数据，可先登记进度节点</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条进度节点记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  getRingStats,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('progress')
// 节点状态走独立的状态列；在办清单与确认结论是贯通确认的回写落点。
const columns = ["节点编号", "节点名称", "区间", "计划完成日", "实际完成日", "计划掘进量", "实际掘进量", "偏差天数", "在办清单", "确认结论"]
const actions = ["开始节点", "确认完成", "登记延期"]
const statuses = ["未开始", "进行中", "已完成", "已延期"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["节点编号", "节点名称", "区间"]
const stats = ref([
  { label: '进行中节点', value: 0 },
  { label: '已完成节点', value: 0 },
  { label: '延期节点', value: 0 },
  { label: '本月贯通环数（台账口径）', value: 0 },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '进度节点登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
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
    rows.value = payload.items
    total.value = payload.total
    // 本月贯通环数与掘进环次页、运营概览读同一份台账，两处必须对得上。
    stats.value = [
      { label: '进行中节点', value: payload.items.filter((row) => String(row.status) === '进行中').length },
      { label: '已完成节点', value: payload.items.filter((row) => String(row.status) === '已完成').length },
      { label: '延期节点', value: payload.items.filter((row) => String(row.status) === '已延期').length },
      { label: '本月贯通环数（台账口径）', value: getRingStats().monthBreakthrough },
    ]
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '进度节点列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.cell-wrap {
  max-width: 260px;
  white-space: normal;
  word-break: break-all;
}
</style>
