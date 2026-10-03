/** 成井档案交换台的领域类型：纯前端数据层结构，换回后端时与接口返回保持一致。 */

export type BatchStatus = '待重试' | '待落库' | '已落库'

export type ItemStatus = '失败' | '通过'

export type DepthBackfillSource = '文件' | '首次观测回填' | ''

/** 井点基础资料（成井档案） */
export type WellArchive = {
  井点编号: string
  井点名称: string
  井深: string
  回填标记: DepthBackfillSource
  成井日期: string
  地面高程: string
  管理单位: string
  档案来源: string
}

/** 交换批次里的单个井点行（导入解析 + 校验结果） */
export type ExchangeItem = {
  id: number
  井点编号: string
  井点名称: string
  井深: string
  成井日期: string
  地面高程: string
  管理单位: string
  status: ItemStatus
  失败原因: string
}

/** 交换批次：整包校验、整包落库的最小单位，批次号全局唯一，保证多终端只落一份结果 */
export type ImportBatch = {
  id: number
  batchNo: string
  fileName: string
  status: BatchStatus
  total: number
  passed: number
  failed: number
  backfilled: number
  resultKey: string
  createdAt: string
  updatedAt: string
}

/** 观测缺口报告的一行 */
export type GapRow = {
  井点编号: string
  井点名称: string
  成井日期: string
  档案井深: string
  应测次数: number
  实测次数: number
  缺口次数: number
  缺口月份: string
  备注: string
}

export type GapReport = {
  generatedAt: string
  rows: GapRow[]
}

export type CommitResult = {
  ok: boolean
  message: string
  batch: ImportBatch
}

export type BatchDetail = {
  batch: ImportBatch
  items: ExchangeItem[]
}
