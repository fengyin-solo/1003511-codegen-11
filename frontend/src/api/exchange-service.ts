import {
  listArchives,
  listBatches,
  listItems,
  readLock,
  saveArchives,
  saveBatches,
  saveItems,
  terminalId,
  writeLock,
} from '@/data/exchange-store'
import { listRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'
import type {
  BatchDetail,
  CommitResult,
  ExchangeItem,
  GapReport,
  GapRow,
  ImportBatch,
  WellArchive,
} from '@/data/exchange-types'

// 巡检待办（巡检模块）与水位异常清单（水位监测模块）共用的固定核对项。
export const GAP_CHECK_ITEM = '观测缺口核查'

// 确认成井交换批次后追加到两处核对清单的任务标题。
function checkTitle(batchNo: string): string {
  return `成井档案批次 ${batchNo} 观测缺口核对`
}

// 批次号散出的确定性 id：同一批次在任何终端重复确认都命中同一行，天然幂等。
function stableId(prefix: string, batchNo: string): number {
  let hash = 0
  const text = `${prefix}:${batchNo}`
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0
  }
  return -Math.abs(hash)
}

function nowText(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function parseNumber(text: string): number | null {
  const value = Number.parseFloat(text.trim())
  return text.trim() !== '' && Number.isFinite(value) ? value : null
}

function isValidDate(text: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(text.trim()) && !Number.isNaN(new Date(text.trim()).getTime())
}

/** 简易 CSV 解析：支持引号包裹与逗号转义，返回表头 + 行数组。 */
export function parseCsv(content: string): { headers: string[]; rows: string[][] } {
  const records: string[][] = []
  let field = ''
  let row: string[] = []
  let quoted = false
  const src = content.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"'
        i += 1
      } else if (ch === '"') {
        quoted = false
      } else {
        field += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1
      row.push(field)
      if (row.some((cell) => cell.trim() !== '')) records.push(row)
      row = []
      field = ''
    } else {
      field += ch
    }
  }
  row.push(field)
  if (row.some((cell) => cell.trim() !== '')) records.push(row)
  if (records.length === 0) {
    return { headers: [], rows: [] }
  }
  const headers = records[0].map((cell) => cell.trim())
  return { headers, rows: records.slice(1) }
}

const TEMPLATE_HEADERS = ['井点编号', '井点名称', '井深', '成井日期', '地面高程', '管理单位']

export function importTemplate(): { filename: string; content: string } {
  return {
    filename: '成井档案导入模板.csv',
    content: `﻿${TEMPLATE_HEADERS.join(',')}\nGW-003,河湾观3井,25.00,2026-04-01,45.10,河湾水文站\n`,
  }
}

type ParsedRow = Omit<ExchangeItem, 'id' | 'status' | '失败原因'>

function toItems(headers: string[], rows: string[][]): ParsedRow[] {
  const idx = (name: string) => headers.indexOf(name)
  const col = {
    井点编号: idx('井点编号'),
    井点名称: idx('井点名称'),
    井深: idx('井深'),
    成井日期: idx('成井日期'),
    地面高程: idx('地面高程'),
    管理单位: idx('管理单位'),
  }
  const pick = (cells: string[], index: number) => (index >= 0 ? (cells[index] ?? '').trim() : '')
  return rows.map((cells) => ({
    井点编号: pick(cells, col.井点编号),
    井点名称: pick(cells, col.井点名称),
    井深: pick(cells, col.井深),
    成井日期: pick(cells, col.成井日期),
    地面高程: pick(cells, col.地面高程),
    管理单位: pick(cells, col.管理单位),
  }))
}

/** 单行校验：必填、格式、同批次内井点编号去重。 */
function validateItems(parsed: ParsedRow[]): ExchangeItem[] {
  const seen = new Map<string, number>()
  return parsed.map((row, index) => {
    const reasons: string[] = []
    if (!row.井点编号) reasons.push('井点编号为空')
    if (row.井点编号 && seen.has(row.井点编号)) {
      reasons.push(`与第 ${seen.get(row.井点编号)} 行井点编号重复`)
    } else if (row.井点编号) {
      seen.set(row.井点编号, index + 1)
    }
    if (row.井深 !== '' && (parseNumber(row.井深) === null || Number(row.井深) <= 0)) {
      reasons.push('井深必须为正数（米），缺失请留空')
    }
    if (!row.成井日期) reasons.push('成井日期为空')
    else if (!isValidDate(row.成井日期)) reasons.push('成井日期格式应为 YYYY-MM-DD')
    if (row.地面高程 !== '' && parseNumber(row.地面高程) === null) {
      reasons.push('地面高程必须为数值')
    }
    return {
      ...row,
      id: index + 1,
      status: reasons.length ? '失败' : '通过',
      失败原因: reasons.join('；'),
    }
  })
}

function nextBatchId(): number {
  return listBatches().reduce((max, item) => Math.max(max, item.id), 0) + 1
}

/**
 * 导入交换文件：只校验、不落库。
 * - 批次号已存在且未落库 → 视为失败项重试，仅用新文件行替换同井点编号的失败行，已通过行保留；
 * - 批次号已落库 → 拒绝；
 * - 新批次号 → 建新批次。
 */
export function importBatch(
  batchNo: string,
  fileName: string,
  content: string,
): { ok: boolean; message: string; batch?: ImportBatch } {
  const code = batchNo.trim()
  if (!code) {
    return { ok: false, message: '批次号不能为空' }
  }
  const { headers, rows } = parseCsv(content)
  if (!headers.includes('井点编号')) {
    return { ok: false, message: '文件缺少「井点编号」列，请使用标准导入模板' }
  }
  const parsed = toItems(headers, rows)
  if (parsed.length === 0) {
    return { ok: false, message: '文件里没有可导入的数据行' }
  }

  const batches = listBatches()
  const existing = batches.find((item) => item.batchNo === code)
  if (existing && existing.status === '已落库') {
    return { ok: false, message: `批次 ${code} 已整包落库，结果只保留一份，无需重复导入` }
  }

  const incoming = validateItems(parsed)
  let batchId: number
  let merged: ExchangeItem[]

  if (existing) {
    batchId = existing.id
    const old = listItems(batchId)
    // 重试只替换新文件里带到的失败井点；已通过的行原样保留。
    const replaced = new Set(incoming.map((item) => item.井点编号))
    const kept = old.filter(
      (item) => !(item.status === '失败' && replaced.has(item.井点编号)),
    )
    const reindex = (items: ExchangeItem[]): ExchangeItem[] =>
      items.map((item, index) => ({ ...item, id: index + 1 }))
    merged = reindex([...kept, ...incoming])
  } else {
    batchId = nextBatchId()
    merged = incoming
  }

  const passed = merged.filter((item) => item.status === '通过').length
  const failed = merged.length - passed
  const status: ImportBatch['status'] = failed > 0 ? '待重试' : '待落库'
  const stamp = nowText()
  const batch: ImportBatch = existing
    ? {
        ...existing,
        fileName,
        status,
        total: merged.length,
        passed,
        failed,
        updatedAt: stamp,
      }
    : {
        id: batchId,
        batchNo: code,
        fileName,
        status,
        total: merged.length,
        passed,
        failed,
        backfilled: 0,
        resultKey: `RESULT-${code}`,
        createdAt: stamp,
        updatedAt: stamp,
      }

  const nextBatches = existing
    ? batches.map((item) => (item.id === batch.id ? batch : item))
    : [...batches, batch]
  saveBatches(nextBatches)
  saveItems(batchId, merged)

  const prefix = existing ? '重试已接收' : '文件已接收'
  return {
    ok: true,
    batch,
    message:
      failed > 0
        ? `${prefix}：${passed} 项通过、${failed} 项失败，原档案未改动，请修正失败项后重试`
        : `${prefix}：${passed} 项全部通过，可整包确认落库`,
  }
}

export function listBatchDetails(): BatchDetail[] {
  return listBatches()
    .slice()
    .sort((a, b) => b.id - a.id)
    .map((batch) => ({ batch, items: listItems(batch.id) }))
}

/** 取该井点首次观测日期的埋深值：旧资料缺井深时据此回填。 */
export function firstObservationDepth(wellNo: string): { date: string; depth: string } | null {
  const records = listRows('groundwater')
    .filter((row) => String(row.井点编号 ?? '') === wellNo)
    .map((row) => ({
      date: String(row.观测日期 ?? ''),
      depth: String(row.埋深值 ?? '').trim(),
    }))
    .filter((row) => row.date && /^\d{4}-\d{2}-\d{2}$/.test(row.date))
    .sort((a, b) => a.date.localeCompare(b.date))
  const first = records[0]
  if (!first) return null
  const depth = parseNumber(first.depth)
  return depth === null ? null : { date: first.date, depth: depth.toFixed(2) }
}

function appendOnce(rows: EntryRow[], candidate: EntryRow): EntryRow[] {
  if (rows.some((row) => Number(row.id) === Number(candidate.id))) {
    return rows
  }
  return [...rows, candidate]
}

const LOCK_TTL_MS = 60_000

/**
 * 确认整包落库：任一项失败或已被其他终端处理，则档案库保持原样并返回首次结果。
 * 全部门槛通过后才在同一写入周期内更新档案库、批次状态和两份核对清单。
 */
export function commitBatch(batchId: number): CommitResult {
  const batches = listBatches()
  const batch = batches.find((item) => item.id === batchId)
  if (!batch) {
    return { ok: false, message: '没有找到该交换批次', batch: undefined as unknown as ImportBatch }
  }
  if (batch.status === '已落库') {
    // 多终端同批次只出一份结果：后到的确认直接拿到首次结论。
    return { ok: false, message: `批次 ${batch.batchNo} 已在其他终端落库，结果唯一不重复生成`, batch }
  }

  const items = listItems(batchId)
  if (items.some((item) => item.status === '失败')) {
    return {
      ok: false,
      message: '批次仍有失败井点，按整包规则保留原档案，请从失败项重试',
      batch: { ...batch, status: '待重试' },
    }
  }

  const lockKey = `hydrology-monitor-station:batch-lock:${batch.batchNo}`
  const lock = readLock(lockKey)
  const terminal = terminalId()
  const stamp = Date.now()
  if (lock && lock.terminal !== terminal && stamp - lock.at < LOCK_TTL_MS) {
    return { ok: false, message: '批次正由另一终端处理，已为你保留首次结果，请勿重复确认', batch }
  }
  writeLock(lockKey, { terminal, at: stamp })

  try {
    const archives = listArchives()
    const nextArchives = archives.map((item) => ({ ...item }))
    let backfilled = 0
    const backfilledWells: string[] = []

    for (const item of items) {
      const index = nextArchives.findIndex((row) => row.井点编号 === item.井点编号)
      if (index < 0) {
        // 新井点：以新文件建档；文件缺井深时再按首次观测日期回填。
        const archive: WellArchive = {
          井点编号: item.井点编号,
          井点名称: item.井点名称,
          井深: item.井深,
          回填标记: item.井深 ? '文件' : '',
          成井日期: item.成井日期,
          地面高程: item.地面高程,
          管理单位: item.管理单位,
          档案来源: `交换批次 ${batch.batchNo}`,
        }
        if (!archive.井深) {
          const first = firstObservationDepth(item.井点编号)
          if (first) {
            archive.井深 = first.depth
            archive.回填标记 = '首次观测回填'
            backfilled += 1
            backfilledWells.push(`${item.井点编号}(首次观测${first.date})`)
          }
        }
        nextArchives.push(archive)
        continue
      }

      // 重复井点：以已有档案为准，新文件只补齐空缺字段，已有非空值一律不覆盖。
      const current = nextArchives[index]
      const fill = (key: '井点名称' | '成井日期' | '地面高程' | '管理单位', value: string) => {
        if (!current[key] && value) current[key] = value
      }
      fill('井点名称', item.井点名称)
      fill('成井日期', item.成井日期)
      fill('地面高程', item.地面高程)
      fill('管理单位', item.管理单位)

      // 旧资料缺井深：无论新文件是否带井深，都按首次观测日期回填。
      if (!current.井深) {
        const first = firstObservationDepth(item.井点编号)
        if (first) {
          current.井深 = first.depth
          current.回填标记 = '首次观测回填'
          backfilled += 1
          backfilledWells.push(`${item.井点编号}(首次观测${first.date})`)
        } else if (item.井深) {
          current.井深 = item.井深
          current.回填标记 = '文件'
        }
      }
    }

    const updated: ImportBatch = {
      ...batch,
      status: '已落库',
      passed: items.length,
      failed: 0,
      backfilled,
      updatedAt: nowText(),
    }

    // 核对项各一条：水位监测异常清单 + 巡检待办，确定性编号保证只生成一份。
    const title = checkTitle(batch.batchNo)
    const waterRows = listRows('waterlevel').map((row) => ({ ...row }))
    const waterRow: EntryRow = {
      id: stableId('waterlevel', batch.batchNo),
      status: '异常值',
      pending: true,
      abnormal: true,
      记录编号: `WATE-GAP-${batch.batchNo}`,
      站点编号: '—',
      观测时间: new Date().toISOString().slice(0, 10),
      当前水位: '—',
      警戒水位: '—',
      保证水位: '—',
      水位变幅: '—',
      核对项: title,
      记录状态: title,
    }
    saveRows('waterlevel', appendOnce(waterRows, waterRow))

    const inspectionRows = listRows('inspection').map((row) => ({ ...row }))
    const inspectionRow: EntryRow = {
      id: stableId('inspection', batch.batchNo),
      status: '待巡检',
      pending: true,
      abnormal: false,
      记录编号: `INSP-GAP-${batch.batchNo}`,
      站点编号: '成井档案交换',
      巡检日期: new Date().toISOString().slice(0, 10),
      巡检人员: terminal,
      检查项目: `${GAP_CHECK_ITEM}（${title}）`,
      发现问题: '',
      处理措施: '',
      巡检状态: '待巡检',
    }
    saveRows('inspection', appendOnce(inspectionRows, inspectionRow))

    // 档案库与批次状态放在最后落盘：前面任一步抛错都不会走到这里，原档案完整保留。
    saveArchives(nextArchives)
    saveBatches(batches.map((item) => (item.id === batchId ? updated : item)))

    const tail = backfilled > 0 ? `，井深回填 ${backfilled} 口：${backfilledWells.join('、')}` : ''
    return {
      ok: true,
      batch: updated,
      message: `批次 ${batch.batchNo} 整包落库 ${items.length} 口井点，已在异常清单和巡检待办各生成一条${GAP_CHECK_ITEM}${tail}`,
    }
  } finally {
    writeLock(lockKey, null)
  }
}

/** 其它入口登记巡检待办时的检查项目：统一带上观测缺口核查。 */
export function defaultInspectionCheckItems(extra: string[] = []): string {
  return [...extra, GAP_CHECK_ITEM].join('；')
}

/** 其它入口直接登记一条巡检待办（巡检页「登记巡检记录」等）。 */
export function createInspectionTodo(input: {
  stationNo: string
  inspector: string
  extraItems?: string[]
}): EntryRow {
  const rows = listRows('inspection')
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const today = new Date().toISOString().slice(0, 10)
  const row: EntryRow = {
    id,
    status: '待巡检',
    pending: true,
    abnormal: false,
    记录编号: `INSP-${String(id).padStart(4, '0')}`,
    站点编号: input.stationNo || '未指定站点',
    巡检日期: today,
    巡检人员: input.inspector,
    检查项目: defaultInspectionCheckItems(input.extraItems),
    发现问题: '',
    处理措施: '',
    巡检状态: '待巡检',
  }
  saveRows('inspection', [...rows, row])
  return row
}

function monthKey(dateText: string): string {
  return dateText.slice(0, 7)
}

function monthsBetween(start: string, end: string): string[] {
  const result: string[] = []
  const cursor = new Date(`${start.slice(0, 7)}-01T00:00:00`)
  const stop = new Date(`${end.slice(0, 7)}-01T00:00:00`)
  while (cursor <= stop) {
    result.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`)
    cursor.setMonth(cursor.getMonth() + 1)
  }
  return result
}

/**
 * 观测缺口报告：成井当月起每月应观测 1 次，与地下水观测记录按月比对；
 * 另外列出「有观测但无成井档案」的井点。
 */
export function buildGapReport(): GapReport {
  const archives = listArchives()
  const observations = listRows('groundwater')
  const observedByWell = new Map<string, Set<string>>()
  for (const row of observations) {
    const wellNo = String(row.井点编号 ?? '').trim()
    const month = monthKey(String(row.观测日期 ?? ''))
    if (!wellNo || !/^\d{4}-\d{2}$/.test(month)) continue
    const set = observedByWell.get(wellNo) ?? new Set<string>()
    set.add(month)
    observedByWell.set(wellNo, set)
  }

  const today = new Date().toISOString()
  const rows: GapRow[] = []
  for (const archive of archives) {
    const start = isValidDate(archive.成井日期) ? archive.成井日期 : today.slice(0, 10)
    const months = monthsBetween(start, today)
    const observed = observedByWell.get(archive.井点编号) ?? new Set<string>()
    const missing = months.filter((month) => !observed.has(month))
    const notes: string[] = []
    if (!archive.井深) notes.push('档案缺井深（待首次观测回填或交换补齐）')
    if (observed.size === 0) notes.push('暂无任何观测记录')
    rows.push({
      井点编号: archive.井点编号,
      井点名称: archive.井点名称,
      成井日期: archive.成井日期,
      档案井深: archive.井深 ? `${archive.井深}${archive.回填标记 === '首次观测回填' ? '（回填）' : ''}` : '',
      应测次数: months.length,
      实测次数: months.filter((month) => observed.has(month)).length,
      缺口次数: missing.length,
      缺口月份: missing.join('、'),
      备注: notes.join('；'),
    })
  }

  const archived = new Set(archives.map((item) => item.井点编号))
  for (const wellNo of observedByWell.keys()) {
    if (archived.has(wellNo)) continue
    rows.push({
      井点编号: wellNo,
      井点名称: '—',
      成井日期: '—',
      档案井深: '—',
      应测次数: 0,
      实测次数: observedByWell.get(wellNo)?.size ?? 0,
      缺口次数: 0,
      缺口月份: '',
      备注: '有观测记录但缺少成井档案',
    })
  }

  return { generatedAt: nowText(), rows }
}

function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function downloadGapReport(): void {
  const report = buildGapReport()
  const header = ['井点编号', '井点名称', '成井日期', '档案井深', '应测次数', '实测次数', '缺口次数', '缺口月份', '备注']
  const lines = [
    `# 成井观测缺口报告 生成时间：${report.generatedAt}`,
    header.join(','),
    ...report.rows.map((row) => header.map((key) => csvCell(row[key as keyof GapRow])).join(',')),
  ]
  const blob = new Blob([`﻿${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `成井观测缺口报告-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
