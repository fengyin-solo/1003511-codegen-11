<template>
  <section class="page" data-module="groundwater-exchange">
    <header class="page-head">
      <div>
        <h2>成井档案交换台</h2>
        <p class="page-desc">导入井点基础资料、维护成井档案，并下载观测缺口报告；批次整包落库，任一井点失败即保留原档案。</p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn ghost" to="/groundwater">返回地下水观测</RouterLink>
        <button class="btn" type="button" @click="downloadTemplate">下载导入模板</button>
        <button class="btn" type="button" @click="runGapReport">下载观测缺口报告</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <section class="panel">
      <h3>导入井点基础资料</h3>
      <p class="panel-note">
        同一井点重复导入以新文件为准（新文件留空的字段保留旧档案值）；旧档案缺井深时按首次观测日期回填。
        批次整包落库：任一井点失败即保留原档案，修正后保持批次号不变重新导入，将从失败项继续；
        多终端处理同一批次只生成一份结果。
      </p>
      <div class="import-bar">
        <input type="file" accept=".csv,text/csv" @change="onFileChange" />
        <button class="btn primary" type="button" :disabled="importing" @click="runImport">
          {{ importing ? '导入中…' : '校验并落库' }}
        </button>
      </div>
      <p v-if="notice" class="notice-text">{{ notice }}</p>
      <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>
    </section>

    <section class="panel">
      <h3>交换批次</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>批次号</th>
            <th>文件名</th>
            <th>导入时间</th>
            <th>总条数</th>
            <th>状态</th>
            <th>失败项</th>
            <th>结果摘要</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="batch in batches" :key="batch.批次号">
            <td>{{ batch.批次号 }}</td>
            <td>{{ batch.文件名 }}</td>
            <td>{{ batch.导入时间 }}</td>
            <td>{{ batch.总条数 }}</td>
            <td>{{ batch.status }}</td>
            <td>{{ batch.失败序号 ? `第${batch.失败序号}项 ${batch.失败井点 || '井点未填'}` : '—' }}</td>
            <td>{{ batch.结果摘要 }}</td>
            <td class="row-actions">
              <button
                v-if="batch.status === '待重试'"
                class="link"
                type="button"
                @click="retryBatch(batch)"
              >
                从第{{ batch.失败序号 }}项重试
              </button>
              <span v-else>—</span>
            </td>
          </tr>
          <tr v-if="!batches.length">
            <td colspan="8" class="empty-state">暂无交换批次，可先下载模板导入井点基础资料</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="panel">
      <h3>成井档案</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in archiveColumns" :key="column">{{ column }}</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="archive in archives" :key="archive.档案编号">
            <td v-for="column in archiveColumns" :key="column">{{ archive[column] || '—' }}</td>
            <td>{{ archive.status }}</td>
          </tr>
          <tr v-if="!archives.length">
            <td :colspan="archiveColumns.length + 1" class="empty-state">暂无成井档案</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ archives.length }} 口井的成井档案 · {{ batches.length }} 个交换批次</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  commitBatchFile,
  computeGapReport,
  downloadGapReport,
  downloadImportTemplate,
  listArchives,
  listBatches,
  retryStoredBatch,
  syncArchivesWithObservations,
} from '@/api/well-archive-service'
import type { ExchangeBatch, WellArchive } from '@/data/types'

const archiveColumns = ['档案编号', '井点编号', '井点名称', '井深', '成井日期', '井口高程', '位置', '管理单位', '首次观测日期', '资料来源', '备注']

const archives = ref<WellArchive[]>([])
const batches = ref<ExchangeBatch[]>([])
const gapWells = ref(0)
const file = ref<File | null>(null)
const importing = ref(false)
const notice = ref('')
const errorMessage = ref('')

const stats = computed(() => [
  { label: '成井档案', value: archives.value.length },
  { label: '待补录档案', value: archives.value.filter((archive) => archive.status === '待补录').length },
  { label: '已落库批次', value: batches.value.filter((batch) => batch.status === '已落库').length },
  { label: '缺口井点', value: gapWells.value },
])

function reload() {
  archives.value = listArchives()
  batches.value = listBatches()
  gapWells.value = computeGapReport().filter((row) => row.缺口月数 > 0).length
}

function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  file.value = input.files?.[0] ?? null
  notice.value = ''
  errorMessage.value = ''
}

async function runImport() {
  if (!file.value) {
    errorMessage.value = '请先选择井点基础资料文件（CSV）'
    return
  }
  importing.value = true
  notice.value = ''
  errorMessage.value = ''
  try {
    const text = await file.value.text()
    const result = await commitBatchFile(file.value.name, text)
    if (result.ok) {
      notice.value = result.message
    } else {
      errorMessage.value = result.message
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '批次导入失败，原档案未改动'
  } finally {
    importing.value = false
    reload()
  }
}

async function retryBatch(batch: ExchangeBatch) {
  notice.value = ''
  errorMessage.value = ''
  const result = await retryStoredBatch(batch.批次号)
  if (result.ok) {
    notice.value = result.message
  } else {
    errorMessage.value = result.message
  }
  reload()
}

async function runGapReport() {
  notice.value = ''
  errorMessage.value = ''
  try {
    const { wells, todosAdded } = await downloadGapReport()
    notice.value = `观测缺口报告已下载：${wells} 口井存在缺口；巡检待办新增 ${todosAdded} 项观测缺口核查`
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '观测缺口报告生成失败'
  }
  reload()
}

function downloadTemplate() {
  downloadImportTemplate()
}

onMounted(() => {
  // 打开交换台先同步观测信息：旧档案缺井深的按首次观测日期回填，再刷新列表。
  syncArchivesWithObservations()
  reload()
})
</script>
