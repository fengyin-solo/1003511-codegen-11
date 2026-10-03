import type { ImportBatch, ExchangeItem, WellArchive } from './exchange-types'

// 交换台本地持久化：与条目库分开存，批次失败回滚时不会污染原有键值。
const ARCHIVE_KEY = 'hydrology-monitor-station:well-archives'
const BATCH_KEY = 'hydrology-monitor-station:import-batches'
const ITEM_KEY = 'hydrology-monitor-station:import-items'
const TERMINAL_KEY = 'hydrology-monitor-station:terminal-id'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 首次打开播种两口井：GW-001 档案缺井深且无观测记录，GW-002 档案缺井深但已有观测，
// 导入文件不填井深时即可演示「按首次观测日期回填」。
const SEED_ARCHIVES: WellArchive[] = [
  {
    井点编号: 'GW-001',
    井点名称: '城北潜水观1井',
    井深: '',
    回填标记: '',
    成井日期: '2026-01-01',
    地面高程: '48.20',
    管理单位: '城北水文站',
    档案来源: '历史档案',
  },
  {
    井点编号: 'GW-002',
    井点名称: '东郊承压观2井',
    井深: '',
    回填标记: '',
    成井日期: '2026-03-01',
    地面高程: '52.60',
    管理单位: '东郊水文站',
    档案来源: '历史档案',
  },
]

function readKey<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined' || !window.localStorage) {
    return clone(fallback)
  }
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    window.localStorage.setItem(key, JSON.stringify(fallback))
    return clone(fallback)
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    window.localStorage.setItem(key, JSON.stringify(fallback))
    return clone(fallback)
  }
}

function writeKey<T>(key: string, value: T): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(key, JSON.stringify(value))
  }
}

let archiveCache: WellArchive[] | null = null
let batchCache: ImportBatch[] | null = null
let itemCache: Record<number, ExchangeItem[]> | null = null

export function listArchives(): WellArchive[] {
  if (archiveCache === null) {
    archiveCache = readKey<WellArchive[]>(ARCHIVE_KEY, SEED_ARCHIVES)
  }
  return archiveCache
}

export function saveArchives(rows: WellArchive[]): void {
  archiveCache = clone(rows)
  writeKey(ARCHIVE_KEY, archiveCache)
}

export function listBatches(): ImportBatch[] {
  if (batchCache === null) {
    batchCache = readKey<ImportBatch[]>(BATCH_KEY, [])
  }
  return batchCache
}

export function saveBatches(rows: ImportBatch[]): void {
  batchCache = clone(rows)
  writeKey(BATCH_KEY, batchCache)
}

export function listItems(batchId: number): ExchangeItem[] {
  if (itemCache === null) {
    itemCache = readKey<Record<number, ExchangeItem[]>>(ITEM_KEY, {})
  }
  return itemCache[batchId] ?? []
}

export function allItems(): Record<number, ExchangeItem[]> {
  if (itemCache === null) {
    itemCache = readKey<Record<number, ExchangeItem[]>>(ITEM_KEY, {})
  }
  return itemCache
}

export function saveItems(batchId: number, items: ExchangeItem[]): void {
  const next = { ...allItems(), [batchId]: clone(items) }
  itemCache = next
  writeKey(ITEM_KEY, next)
}

// 处理锁也走 localStorage：多个浏览器终端确认同一批次时，只有抢到锁的一份会执行落库。
export function readLock(key: string): { terminal: string; at: number } | null {
  return readKey<{ terminal: string; at: number } | null>(key, null)
}

export function writeLock(key: string, value: { terminal: string; at: number } | null): void {
  writeKey(key, value)
}

export function terminalId(): string {
  let id = readKey<string>(TERMINAL_KEY, '')
  if (!id) {
    id = `T-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    writeKey(TERMINAL_KEY, id)
  }
  return id
}
