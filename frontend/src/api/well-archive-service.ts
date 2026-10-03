import { listRows, reloadRows, saveRows } from '@/data/local-store'
import type {
  BatchCommitResult,
  EntryRow,
  ExchangeBatch,
  GapReportRow,
  WellArchive,
} from '@/data/types'

// 成井档案交换台的本地数据键：档案、批次各一把，和业务模块共用同一个 localStorage 仓库。
const ARCHIVE_KEY = 'wellarchive'
const BATCH_KEY = 'wellarchivebatch'
// 多终端（多标签页）互斥锁：同一批次只能有一个终端在落库，其余进来时看到已落库结果。
const LOCK_NAME = 'hydrology-monitor-station:well-archive-exchange'

const ARCHIVE_STATUSES = { valid: '有效', incomplete: '待补录' } as const
const BATCH_STATUSES = { committed: '已落库', retry: '待重试' } as const

type ParsedWell = {
  序号: number
  井点编号: string
  井点名称: string
  井深: string
  成井日期: string
  井口高程: string
  位置: string
  管理单位: string
  备注: string
  rawLine: string
}

type ParseResult =
  | { ok: true; 批次号: string; items: ParsedWell[] }
  | { ok: false; message: string }

type ValidationFailure = { 序号: number; 井点: string; 原因: string }

function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function now(): string {
  const current = new Date()
  const hour = String(current.getHours()).padStart(2, '0')
  const minute = String(current.getMinutes()).padStart(2, '0')
  return `${today()} ${hour}:${minute}`
}

// 内容指纹：文件没填批次号时用它当幂等键，同一文件重复导入天然命中同一批次。
function fingerprint(text: string): string {
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0
  }
  return hash.toString(36)
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function appendNote(note: string, addition: string): string {
  return note.includes(addition) ? note : note ? `${note}；${addition}` : addition
}

async function withBatchLock<T>(task: () => T): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (locks) {
    return locks.request(LOCK_NAME, { mode: 'exclusive' }, () => task())
  }
  return task()
}

/** 解析 CSV 文本，支持引号包裹与逗号转义，返回含表头的行矩阵。 */
function parseCsvLines(text: string): string[][] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let quoted = false
  const source = text.replace(/^\uFEFF/, '')
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') {
        index += 1
      }
      row.push(field)
      field = ''
      if (row.some((cell) => cell.trim() !== '')) {
        rows.push(row)
      }
      row = []
    } else {
      field += char
    }
  }
  row.push(field)
  if (row.some((cell) => cell.trim() !== '')) {
    rows.push(row)
  }
  return rows
}

const TEMPLATE_HEADER = ['批次号', '井点编号', '井点名称', '井深', '成井日期', '井口高程', '位置', '管理单位', '备注']

export function downloadImportTemplate(): void {
  const sample = ['BATCH-2026-001', 'GROU-0005', '南岸监测井', '68.5', '2026-09-05', '44.10', '南岸堤防', '水文站三队', '示例行可删除']
  const content = `\uFEFF${TEMPLATE_HEADER.join(',')}\n${sample.join(',')}`
  downloadCsv('成井档案导入模板.csv', content)
}

function parseArchiveFile(text: string): ParseResult {
  const matrix = parseCsvLines(text)
  if (matrix.length < 2) {
    return { ok: false, message: '文件里没有数据行，请按模板填写井点基础资料' }
  }
  const header = matrix[0].map((cell) => cell.trim())
  const columnOf = (name: string) => header.indexOf(name)
  if (columnOf('井点编号') < 0) {
    return { ok: false, message: '表头缺少「井点编号」列，请使用导入模板' }
  }
  const cellAt = (row: string[], name: string) => {
    const index = columnOf(name)
    return index >= 0 ? (row[index] ?? '').trim() : ''
  }
  const batchIds = [...new Set(matrix.slice(1).map((row) => cellAt(row, '批次号')).filter((value) => value !== ''))]
  if (batchIds.length > 1) {
    return { ok: false, message: `文件内批次号不一致（${batchIds.join('、')}），同一批次请保持同一批次号` }
  }
  const 批次号 = batchIds[0] ?? `B-${fingerprint(text.trim())}`
  const items: ParsedWell[] = matrix.slice(1).map((row, index) => ({
    序号: index + 1,
    井点编号: cellAt(row, '井点编号'),
    井点名称: cellAt(row, '井点名称'),
    井深: cellAt(row, '井深'),
    成井日期: cellAt(row, '成井日期'),
    井口高程: cellAt(row, '井口高程'),
    位置: cellAt(row, '位置'),
    管理单位: cellAt(row, '管理单位'),
    备注: cellAt(row, '备注'),
    rawLine: row.join(',').trim(),
  }))
  return { ok: true, 批次号, items }
}

/** 逐项校验：start 之前的项是失败批次里已通过的，重试时直接跳过（从失败项重试）。 */
function validateItems(items: ParsedWell[], start: number): ValidationFailure | null {
  const seen = new Map<string, number>()
  for (const item of items) {
    if (item.井点编号 !== '') {
      const first = seen.get(item.井点编号)
      if (first !== undefined) {
        return { 序号: item.序号, 井点: item.井点编号, 原因: `与第${first}项井点编号重复` }
      }
      seen.set(item.井点编号, item.序号)
    }
    if (item.序号 < start) {
      continue
    }
    if (item.井点编号 === '') {
      return { 序号: item.序号, 井点: '', 原因: '缺少井点编号' }
    }
    if (item.井深 !== '' && (!Number.isFinite(Number(item.井深)) || Number(item.井深) <= 0)) {
      return { 序号: item.序号, 井点: item.井点编号, 原因: `井深「${item.井深}」不是正数` }
    }
    if (item.成井日期 !== '' && !isValidDate(item.成井日期)) {
      return { 序号: item.序号, 井点: item.井点编号, 原因: `成井日期「${item.成井日期}」不是有效日期（YYYY-MM-DD）` }
    }
  }
  return null
}

function isValidDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) {
    return false
  }
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return date.getFullYear() === Number(match[1])
    && date.getMonth() === Number(match[2]) - 1
    && date.getDate() === Number(match[3])
}

/** 重试时比对文件前缀：失败项之前的行和留档一致，才承认它们已校验过。 */
function prefixMatches(archivedText: string, items: ParsedWell[], failedAt: number): boolean {
  const archived = parseArchiveFile(archivedText)
  if (!archived.ok || archived.items.length < failedAt - 1 || items.length < failedAt - 1) {
    return false
  }
  const prefixOf = (list: ParsedWell[]) => list.slice(0, failedAt - 1).map((item) => item.rawLine).join('\n')
  return prefixOf(archived.items) === prefixOf(items)
}

// 冲突策略（本次需求拍板）：同一井点重复导入以新文件为准——新文件非空字段覆盖旧档案，
// 新文件留空的字段保留旧值；档案编号、首次观测日期不动，备注里留下批次痕迹。
function mergeArchive(current: WellArchive, item: ParsedWell, 批次号: string): WellArchive {
  const pick = (incoming: string, existing: string) => (incoming !== '' ? incoming : existing)
  return {
    ...current,
    井点名称: pick(item.井点名称, current.井点名称),
    井深: pick(item.井深, current.井深),
    成井日期: pick(item.成井日期, current.成井日期),
    井口高程: pick(item.井口高程, current.井口高程),
    位置: pick(item.位置, current.位置),
    管理单位: pick(item.管理单位, current.管理单位),
    资料来源: `批次${批次号}`,
    备注: appendNote(pick(item.备注, current.备注), `批次${批次号}更新`),
  }
}

function createArchive(item: ParsedWell, 批次号: string, id: number): WellArchive {
  return {
    id,
    status: ARCHIVE_STATUSES.valid,
    pending: false,
    abnormal: false,
    档案编号: `WARCH-${String(id).padStart(4, '0')}`,
    井点编号: item.井点编号,
    井点名称: item.井点名称,
    井深: item.井深,
    成井日期: item.成井日期,
    井口高程: item.井口高程,
    位置: item.位置,
    管理单位: item.管理单位,
    首次观测日期: '',
    资料来源: `批次${批次号}`,
    备注: item.备注,
  }
}

/** 各井点首次观测：日期最早的那条地下水观测记录。 */
function firstObservationByWell(): Map<string, { date: string; 埋深值: string }> {
  const first = new Map<string, { date: string; 埋深值: string }>()
  for (const row of listRows('groundwater')) {
    const code = String(row['井点编号'] ?? '')
    const date = String(row['观测日期'] ?? '')
    if (code === '' || !isValidDate(date)) {
      continue
    }
    const current = first.get(code)
    if (!current || date < current.date) {
      first.set(code, { date, 埋深值: String(row['埋深值'] ?? '') })
    }
  }
  return first
}

// 旧资料缺井深按首次观测日期回填：取该井点首次观测的埋深值顶井深，备注里记来源日期；
// 同时刷新每口井的首次观测日期。返回回填条数，幂等，可反复执行。
function applyObservationSync(archives: WellArchive[]): { rows: WellArchive[]; 回填数: number } {
  const first = firstObservationByWell()
  let 回填数 = 0
  const rows = archives.map((archive) => {
    const observation = first.get(archive.井点编号)
    let 井深 = archive.井深
    let 备注 = archive.备注
    if (井深 === '' && observation && observation.埋深值 !== '') {
      井深 = observation.埋深值
      备注 = appendNote(备注, `井深按首次观测日期(${observation.date})回填`)
      回填数 += 1
    }
    const status = 井深 === '' ? ARCHIVE_STATUSES.incomplete : ARCHIVE_STATUSES.valid
    return {
      ...archive,
      井深,
      备注: 井深 === '' ? appendNote(备注, '缺井深且无观测记录，待补录') : 备注,
      首次观测日期: observation?.date ?? '',
      status,
      pending: status === ARCHIVE_STATUSES.incomplete,
    }
  })
  return { rows, 回填数 }
}

/** 打开交换台时同步一次观测信息，让旧档案的井深回填不依赖导入动作。 */
export function syncArchivesWithObservations(): number {
  const archives = listRows(ARCHIVE_KEY) as WellArchive[]
  if (archives.length === 0) {
    return 0
  }
  const { rows, 回填数 } = applyObservationSync(archives)
  if (JSON.stringify(rows) !== JSON.stringify(archives)) {
    saveRows(ARCHIVE_KEY, rows)
  }
  return 回填数
}

function upsertBatch(batches: ExchangeBatch[], batch: ExchangeBatch): ExchangeBatch[] {
  const index = batches.findIndex((item) => item.批次号 === batch.批次号)
  if (index >= 0) {
    const next = [...batches]
    next[index] = batch
    return next
  }
  return [...batches, batch]
}

/** 批次落库后，水位异常清单与巡检待办各加一条核对项；按批次号幂等，重复落库不会重复加。 */
function ensureBatchCheckItems(batch: ExchangeBatch): void {
  const waterlevelRows = listRows('waterlevel')
  const waterlevelCode = `WACHK-${batch.批次号}`
  if (!waterlevelRows.some((row) => row['记录编号'] === waterlevelCode)) {
    saveRows('waterlevel', [
      ...waterlevelRows,
      {
        id: nextId(waterlevelRows),
        status: '异常值',
        pending: true,
        abnormal: true,
        记录编号: waterlevelCode,
        站点编号: batch.批次号,
        观测时间: today(),
        当前水位: `成井档案批次${batch.批次号}核对`,
        警戒水位: '',
        保证水位: '',
        水位变幅: '',
        记录状态: '待核对',
      },
    ])
  }
  const inspectionRows = listRows('inspection')
  const inspectionCode = `INCHK-${batch.批次号}`
  if (!inspectionRows.some((row) => row['记录编号'] === inspectionCode)) {
    saveRows('inspection', [
      ...inspectionRows,
      {
        id: nextId(inspectionRows),
        status: '待巡检',
        pending: true,
        abnormal: false,
        记录编号: inspectionCode,
        站点编号: batch.批次号,
        巡检日期: today(),
        巡检人员: '系统（交换台）',
        检查项目: '成井档案交换核对',
        发现问题: `批次${batch.批次号}已落库：新增${batch.新增数}、更新${batch.更新数}、井深回填${batch.回填数}，待核对`,
        处理措施: '',
        巡检状态: '待核对',
      },
    ])
  }
}

function commitParsed(filename: string, text: string, parsed: Extract<ParseResult, { ok: true }>): BatchCommitResult {
  const 批次号 = parsed.批次号
  const batches = listRows(BATCH_KEY) as ExchangeBatch[]
  const existing = batches.find((batch) => batch.批次号 === 批次号)
  if (existing && existing.status === BATCH_STATUSES.committed) {
    return {
      ok: true,
      repeated: true,
      message: `批次${批次号}已落库，多终端重复处理只保留这一份结果`,
      batch: existing,
    }
  }
  // 失败批次重试：文件前缀与留档一致才从失败项继续，否则退回整包校验。
  let start = 1
  let resumed = false
  if (existing && existing.status === BATCH_STATUSES.retry && existing.失败序号 > 1) {
    if (prefixMatches(existing.文件内容, parsed.items, existing.失败序号)) {
      start = existing.失败序号
      resumed = true
    }
  }
  const failure = validateItems(parsed.items, start)
  if (failure) {
    // 整包落库：任一井点失败就一条不写，原档案原样保留，只登记失败批次供重试。
    const failedBatch: ExchangeBatch = {
      id: existing?.id ?? nextId(batches),
      status: BATCH_STATUSES.retry,
      pending: true,
      abnormal: true,
      批次号,
      文件名: filename,
      导入时间: now(),
      总条数: parsed.items.length,
      新增数: 0,
      更新数: 0,
      回填数: 0,
      失败序号: failure.序号,
      失败井点: failure.井点,
      失败原因: failure.原因,
      文件内容: text,
      结果摘要: `第${failure.序号}项失败：${failure.原因}`,
    }
    saveRows(BATCH_KEY, upsertBatch(batches, failedBatch))
    return {
      ok: false,
      repeated: false,
      message: `第${failure.序号}项（井点${failure.井点 || '未填'}）：${failure.原因}。已保留原档案，修正后保持批次号不变重新导入，将从第${failure.序号}项重试`,
      batch: failedBatch,
    }
  }
  const archives = listRows(ARCHIVE_KEY) as WellArchive[]
  const byWell = new Map(archives.map((archive) => [archive.井点编号, archive]))
  const merged = [...archives]
  let idCursor = nextId(archives)
  let 新增数 = 0
  let 更新数 = 0
  for (const item of parsed.items) {
    const current = byWell.get(item.井点编号)
    if (current) {
      const index = merged.findIndex((archive) => archive.id === current.id)
      merged[index] = mergeArchive(current, item, 批次号)
      更新数 += 1
    } else {
      const created = createArchive(item, 批次号, idCursor)
      idCursor += 1
      merged.push(created)
      byWell.set(item.井点编号, created)
      新增数 += 1
    }
  }
  const { rows: synced, 回填数 } = applyObservationSync(merged)
  const batch: ExchangeBatch = {
    id: existing?.id ?? nextId(batches),
    status: BATCH_STATUSES.committed,
    pending: false,
    abnormal: false,
    批次号,
    文件名: filename,
    导入时间: now(),
    总条数: parsed.items.length,
    新增数,
    更新数,
    回填数,
    失败序号: 0,
    失败井点: '',
    失败原因: '',
    文件内容: text,
    结果摘要: `${resumed ? `从第${start}项重试成功，` : ''}新增${新增数}、更新${更新数}、井深回填${回填数}`,
  }
  // 整包落库：档案、批次凭证、两处核对项一次性写完，中途没有半成品状态。
  saveRows(ARCHIVE_KEY, synced)
  saveRows(BATCH_KEY, upsertBatch(batches, batch))
  ensureBatchCheckItems(batch)
  return {
    ok: true,
    repeated: false,
    message: `批次${批次号}已整包落库：新增${新增数}、更新${更新数}、井深回填${回填数}；水位异常清单与巡检待办已各增核对项`,
    batch,
  }
}

/** 导入井点基础资料：解析 → 加锁 → 幂等判断 → 校验 → 整包落库。 */
export async function commitBatchFile(filename: string, text: string): Promise<BatchCommitResult> {
  const parsed = parseArchiveFile(text)
  if (!parsed.ok) {
    return { ok: false, repeated: false, message: parsed.message, batch: null }
  }
  return withBatchLock(() => {
    reloadRows()
    return commitParsed(filename, text, parsed)
  })
}

/** 用失败批次留档的文件内容从失败项重试，不用重新选择文件。 */
export async function retryStoredBatch(批次号: string): Promise<BatchCommitResult> {
  return withBatchLock(() => {
    reloadRows()
    const batch = (listRows(BATCH_KEY) as ExchangeBatch[]).find((item) => item.批次号 === 批次号)
    if (!batch) {
      return { ok: false, repeated: false, message: `没有找到批次${批次号}`, batch: null }
    }
    if (batch.status !== BATCH_STATUSES.retry) {
      return { ok: true, repeated: true, message: `批次${批次号}已落库，无需重试`, batch }
    }
    const parsed = parseArchiveFile(batch.文件内容)
    if (!parsed.ok) {
      return { ok: false, repeated: false, message: parsed.message, batch }
    }
    return commitParsed(batch.文件名, batch.文件内容, parsed)
  })
}

export function listArchives(): WellArchive[] {
  return listRows(ARCHIVE_KEY) as WellArchive[]
}

export function listBatches(): ExchangeBatch[] {
  return [...(listRows(BATCH_KEY) as ExchangeBatch[])].sort((a, b) => b.导入时间.localeCompare(a.导入时间))
}

function monthRange(start: string, end: string): string[] {
  if (!/^\d{4}-\d{2}$/.test(start) || !/^\d{4}-\d{2}$/.test(end) || start > end) {
    return []
  }
  const months: string[] = []
  let year = Number(start.slice(0, 4))
  let month = Number(start.slice(5, 7))
  while (`${year}-${String(month).padStart(2, '0')}` <= end) {
    months.push(`${year}-${String(month).padStart(2, '0')}`)
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return months
}

function previousMonth(): string {
  const nowDate = new Date()
  const year = nowDate.getMonth() === 0 ? nowDate.getFullYear() - 1 : nowDate.getFullYear()
  const month = nowDate.getMonth() === 0 ? 12 : nowDate.getMonth()
  return `${year}-${String(month).padStart(2, '0')}`
}

/** 观测缺口：每口井从成井当月到上一自然月，逐月应有一次观测，缺测的月份就是缺口。 */
export function computeGapReport(): GapReportRow[] {
  const observedMonths = new Map<string, Set<string>>()
  for (const row of listRows('groundwater')) {
    const code = String(row['井点编号'] ?? '')
    const month = String(row['观测日期'] ?? '').slice(0, 7)
    if (code === '' || !/^\d{4}-\d{2}$/.test(month)) {
      continue
    }
    if (!observedMonths.has(code)) {
      observedMonths.set(code, new Set())
    }
    observedMonths.get(code)?.add(month)
  }
  const end = previousMonth()
  return listArchives().map((archive) => {
    const start = archive.成井日期
      ? archive.成井日期.slice(0, 7)
      : archive.首次观测日期
        ? archive.首次观测日期.slice(0, 7)
        : end
    const expected = monthRange(start, end)
    const observed = observedMonths.get(archive.井点编号) ?? new Set<string>()
    const missing = expected.filter((month) => !observed.has(month))
    return {
      井点编号: archive.井点编号,
      井点名称: archive.井点名称,
      统计起月: start,
      统计止月: end,
      应观测月数: expected.length,
      实观测月数: expected.length - missing.length,
      缺口月数: missing.length,
      缺口月份: missing.join('、'),
    }
  })
}

/** 观测缺口核查待办：其它入口（巡检页、缺口报告下载）共用这一个口子，按井点去重。 */
export async function ensureGapCheckTodos(): Promise<number> {
  return withBatchLock(() => {
    reloadRows()
    const gaps = computeGapReport().filter((row) => row.缺口月数 > 0)
    const rows = listRows('inspection')
    const openCodes = new Set(
      rows.filter((row) => row.status === '待巡检').map((row) => String(row['记录编号'])),
    )
    let idCursor = nextId(rows)
    const added: EntryRow[] = []
    for (const gap of gaps) {
      const code = `INGAP-${gap.井点编号}`
      if (openCodes.has(code)) {
        continue
      }
      added.push({
        id: idCursor,
        status: '待巡检',
        pending: true,
        abnormal: false,
        记录编号: code,
        站点编号: gap.井点编号,
        巡检日期: today(),
        巡检人员: '系统（缺口核查）',
        检查项目: '观测缺口核查',
        发现问题: `井点${gap.井点编号}观测缺口${gap.缺口月数}个月：${gap.缺口月份}`,
        处理措施: '',
        巡检状态: '待核查',
      })
      idCursor += 1
    }
    if (added.length > 0) {
      saveRows('inspection', [...rows, ...added])
    }
    return added.length
  })
}

function downloadCsv(filename: string, content: string): void {
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

/** 下载观测缺口报告，同时把缺口井点登记成巡检待办（观测缺口核查）。 */
export async function downloadGapReport(): Promise<{ wells: number; todosAdded: number }> {
  const report = computeGapReport()
  const header = ['井点编号', '井点名称', '统计起月', '统计止月', '应观测月数', '实观测月数', '缺口月数', '缺口月份']
  const lines = report.map((row) =>
    [row.井点编号, row.井点名称, row.统计起月, row.统计止月, row.应观测月数, row.实观测月数, row.缺口月数, `"${row.缺口月份}"`].join(','),
  )
  downloadCsv(`观测缺口报告-${today()}.csv`, `\uFEFF${[header.join(','), ...lines].join('\n')}`)
  const todosAdded = await ensureGapCheckTodos()
  return { wells: report.filter((row) => row.缺口月数 > 0).length, todosAdded }
}
