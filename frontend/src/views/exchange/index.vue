<template>
  <section class="page" data-module="well-exchange">
    <header class="page-head">
      <div>
        <h2>成井档案交换台</h2>
        <p class="page-desc">
          导入井点基础资料，交换批次整包校验、整包落库：任一井点失败则原档案保留，修正失败项后重试；重复井点以已有档案为准，旧资料缺井深按首次观测日期的埋深回填。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="downloadTemplate">下载导入模板</button>
        <button class="btn" type="button" @click="downloadGapReport()">下载观测缺口报告</button>
        <RouterLink class="btn ghost" to="/groundwater">返回地下水观测</RouterLink>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">在档井点</span>
        <strong class="stat-value">{{ archives.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">井深回填井点</span>
        <strong class="stat-value">{{ backfillCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待重试批次</span>
        <strong class="stat-value">{{ retryBatchCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">观测缺口井点</span>
        <strong class="stat-value">{{ gapWellCount }}</strong>
      </article>
    </div>

    <section class="panel">
      <h3 class="panel-title">导入交换文件</h3>
      <form class="import-bar" @submit.prevent="onImport">
        <label class="filter-item">
          <span>交换批次号（同一批次多终端共用一个号，只落一份结果）</span>
          <input v-model="batchNo" placeholder="如 EXC-20261003-01" />
        </label>
        <label class="file-box">
          <span>成井档案 CSV 文件</span>
          <input type="file" accept=".csv,text/csv" @change="onFileChange" />
        </label>
        <button class="btn primary" type="submit" :disabled="!file">导入校验（暂不落库）</button>
      </form>
      <p v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</p>
    </section>

    <section class="panel">
      <h3 class="panel-title">交换批次</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>批次号</th>
            <th>来源文件</th>
            <th>状态</th>
            <th>通过/总数</th>
            <th>井深回填</th>
            <th>更新时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="detail in details" :key="detail.batch.id">
            <td>{{ detail.batch.batchNo }}</td>
            <td>{{ detail.batch.fileName }}</td>
            <td>
              <span :class="['tag', statusClass(detail.batch.status)]">{{ detail.batch.status }}</span>
            </td>
            <td>{{ detail.batch.passed }} / {{ detail.batch.total }}</td>
            <td>{{ detail.batch.backfilled || '—' }}</td>
            <td>{{ detail.batch.updatedAt }}</td>
            <td class="row-actions">
              <button class="link" type="button" @click="openDetail(detail.batch.id)">查看明细</button>
              <button
                v-if="detail.batch.failed > 0"
                class="link"
                type="button"
                @click="useForRetry(detail.batch.batchNo)"
              >
                从失败项重试
              </button>
              <button
                v-if="detail.batch.status === '待落库'"
                class="link"
                type="button"
                @click="onCommit(detail.batch.id)"
              >
                确认整包落库
              </button>
            </td>
          </tr>
          <tr v-if="!details.length">
            <td colspan="7" class="empty-state">暂无交换批次，先导入成井档案文件</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section v-if="activeDetail" class="panel">
      <h3 class="panel-title">批次 {{ activeDetail.batch.batchNo }} 明细</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>行号</th>
            <th>井点编号</th>
            <th>井点名称</th>
            <th>井深(米)</th>
            <th>成井日期</th>
            <th>地面高程</th>
            <th>管理单位</th>
            <th>校验结果</th>
            <th>失败原因</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in activeDetail.items" :key="item.id">
            <td>{{ item.id }}</td>
            <td>{{ item.井点编号 }}</td>
            <td>{{ item.井点名称 }}</td>
            <td>{{ item.井深 || '（空，落库时按首次观测回填）' }}</td>
            <td>{{ item.成井日期 }}</td>
            <td>{{ item.地面高程 }}</td>
            <td>{{ item.管理单位 }}</td>
            <td>
              <span :class="['tag', item.status === '通过' ? 'tag-ok' : 'tag-fail']">{{ item.status }}</span>
            </td>
            <td class="error-text">{{ item.失败原因 || '—' }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="panel">
      <h3 class="panel-title">井点档案库</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>井点编号</th>
            <th>井点名称</th>
            <th>井深(米)</th>
            <th>来源</th>
            <th>成井日期</th>
            <th>地面高程</th>
            <th>管理单位</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="archive in archives" :key="archive.井点编号">
            <td>{{ archive.井点编号 }}</td>
            <td>{{ archive.井点名称 }}</td>
            <td>{{ archive.井深 ? `${archive.井深}${archive.回填标记 === '首次观测回填' ? '（回填）' : ''}` : '—' }}</td>
            <td>{{ archive.档案来源 }}</td>
            <td>{{ archive.成井日期 }}</td>
            <td>{{ archive.地面高程 }}</td>
            <td>{{ archive.管理单位 }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

import {
  buildGapReport,
  commitBatch,
  downloadGapReport,
  importBatch,
  importTemplate,
  listBatchDetails,
} from '@/api/exchange-service'
import { listArchives } from '@/data/exchange-store'
import type { BatchDetail } from '@/data/exchange-types'

const archives = ref(listArchives())
const details = ref<BatchDetail[]>(listBatchDetails())
const activeId = ref<number | null>(null)
const activeDetail = computed(() => details.value.find((item) => item.batch.id === activeId.value) ?? null)

const batchNo = ref(defaultBatchNo())
const file = ref<File | null>(null)
const message = ref('')
const messageOk = ref(false)

const backfillCount = computed(() => archives.value.filter((item) => item.回填标记 === '首次观测回填').length)
const retryBatchCount = computed(() => details.value.filter((item) => item.batch.status === '待重试').length)
const gapWellCount = computed(() => buildGapReport().rows.filter((row) => row.缺口次数 > 0 || row.备注).length)

function defaultBatchNo(): string {
  const stamp = new Date()
  const day = `${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, '0')}${String(stamp.getDate()).padStart(2, '0')}`
  return `EXC-${day}-01`
}

function refresh() {
  archives.value = listArchives()
  details.value = listBatchDetails()
}

function onFileChange(event: Event) {
  const target = event.target as HTMLInputElement
  file.value = target.files?.[0] ?? null
}

async function onImport() {
  message.value = ''
  if (!file.value) {
    messageOk.value = false
    message.value = '请先选择成井档案 CSV 文件'
    return
  }
  const content = await file.value.text()
  const result = importBatch(batchNo.value, file.value.name, content)
  messageOk.value = result.ok
  message.value = result.message
  if (result.ok) {
    refresh()
    activeId.value = result.batch?.id ?? activeId.value
  }
}

function onCommit(id: number) {
  const result = commitBatch(id)
  messageOk.value = result.ok
  message.value = result.message
  refresh()
}

function openDetail(id: number) {
  activeId.value = id
}

function useForRetry(code: string) {
  batchNo.value = code
  file.value = null
  message.value = `已载入批次号 ${code}，请选择修正后的 CSV（只需包含失败井点），导入即按失败项重试`
  messageOk.value = true
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

function downloadTemplate() {
  const { filename, content } = importTemplate()
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function statusClass(status: string): string {
  if (status === '已落库') return 'tag-ok'
  if (status === '待重试') return 'tag-fail'
  return 'tag-wait'
}
</script>

<style scoped>
.panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 14px;
}
.panel-title { margin: 0 0 10px; font-size: 14px; }
.import-bar { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; }
.file-box span { display: block; font-size: 12px; color: var(--muted); }
.tag { border-radius: 999px; padding: 2px 10px; font-size: 12px; }
.tag-ok { background: #e7f6ec; color: #1a7f37; }
.tag-fail { background: #fdecec; color: #b42318; }
.tag-wait { background: #fff4e0; color: #b54708; }
.ok-text { color: #1a7f37; }
.btn[disabled] { opacity: 0.5; cursor: not-allowed; }
</style>
