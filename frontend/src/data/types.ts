/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 成井档案：交换台导入的井点基础资料，按井点编号唯一，存在本地库的 wellarchive 键下。 */
export type WellArchive = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  档案编号: string
  井点编号: string
  井点名称: string
  井深: string
  成井日期: string
  井口高程: string
  位置: string
  管理单位: string
  首次观测日期: string
  资料来源: string
  备注: string
  [field: string]: string | number | boolean
}

/** 交换批次：一次导入的落库凭证，批次号是幂等键，多终端重复处理只认第一份结果。 */
export type ExchangeBatch = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  批次号: string
  文件名: string
  导入时间: string
  总条数: number
  新增数: number
  更新数: number
  回填数: number
  失败序号: number
  失败井点: string
  失败原因: string
  文件内容: string
  结果摘要: string
  [field: string]: string | number | boolean
}

export type BatchCommitResult = {
  ok: boolean
  /** true 表示该批次此前已落库，本次直接返回原结果，没有重复写入。 */
  repeated: boolean
  message: string
  batch: ExchangeBatch | null
}

export type GapReportRow = {
  井点编号: string
  井点名称: string
  统计起月: string
  统计止月: string
  应观测月数: number
  实观测月数: number
  缺口月数: number
  缺口月份: string
}
