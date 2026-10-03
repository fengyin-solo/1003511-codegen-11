// 交换台核心流程冒烟测试：node 里用内存 localStorage 模拟单/多终端。
const mem = new Map()
globalThis.window = {
  localStorage: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => void mem.set(k, v),
    removeItem: (k) => void mem.delete(k),
  },
}

const svc = await import('./bundle.mjs')
const { listArchives, listBatches, listItems, listRows } = svc

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.log(`  ✗ ${name} ${extra}`) }
}

// 1) 导入：GW-001/GW-002 不带井深，GW-003 新井带井深，第 4 行缺成井日期应失败
const csv = [
  '井点编号,井点名称,井深,成井日期,地面高程,管理单位',
  'GW-001,城北潜水观1井,,2026-01-01,48.20,城北水文站',
  'GW-002,东郊承压观2井,,2026-03-01,52.60,东郊水文站',
  'GW-003,河湾观3井,25.00,2026-04-01,45.10,河湾水文站',
  'GW-004,,30.00,,40.00,河湾水文站',
].join('\n')

let r = svc.importBatch('EXC-T1', 'wells.csv', csv)
check('导入后批次待重试', r.ok && r.batch.status === '待重试', JSON.stringify(r))
check('3 通过 1 失败', r.batch.passed === 3 && r.batch.failed === 1)
const failedItem = listItems(r.batch.id).find((i) => i.井点编号 === 'GW-004')
check('失败行带原因', failedItem.status === '失败' && /成井日期/.test(failedItem.失败原因))
check('失败时档案库保持原样（仍是2口井）', listArchives().length === 2)

// 2) 确认落库被拒（整包规则）
let c = svc.commitBatch(r.batch.id)
check('有失败项时确认被拒且原档案保留', !c.ok && listArchives().length === 2)

// 3) 从失败项重试：只传修正后的 GW-004
const retryCsv = [
  '井点编号,井点名称,井深,成井日期,地面高程,管理单位',
  'GW-004,西山观4井,30.00,2026-05-01,40.00,河湾水文站',
].join('\n')
r = svc.importBatch('EXC-T1', 'wells-fixed.csv', retryCsv)
check('重试后批次待落库', r.ok && r.batch.status === '待落库' && r.batch.failed === 0 && r.batch.total === 4)

// 4) 确认整包落库
c = svc.commitBatch(r.batch.id)
check('整包落库成功', c.ok, c.message)
const archives = listArchives()
check('档案库变为4口井', archives.length === 4)
const gw1 = archives.find((a) => a.井点编号 === 'GW-001')
const gw2 = archives.find((a) => a.井点编号 === 'GW-002')
const gw3 = archives.find((a) => a.井点编号 === 'GW-003')
check('GW-001 无观测记录，井深仍空', gw1.井深 === '')
check('GW-002 按首次观测2026-03-15埋深回填18.60', gw2.井深 === '18.60' && gw2.回填标记 === '首次观测回填')
check('GW-003 用文件井深25.00', gw3.井深 === '25.00' && gw3.回填标记 === '文件')

// 5) 多终端/重复操作幂等
const again = svc.commitBatch(r.batch.id)
check('重复确认不生成第二份结果', !again.ok && /唯一|其他终端/.test(again.message))
const dupImport = svc.importBatch('EXC-T1', 'again.csv', csv)
check('已落库批次拒绝再次导入', !dupImport.ok)
const water = listRows('waterlevel')
const insp = listRows('inspection')
check('水位异常清单恰好1条核对项', water.filter((x) => /观测缺口核对/.test(String(x.核对项 ?? ''))).length === 1)
check('巡检待办恰好1条核对项', insp.filter((x) => String(x.检查项目 ?? '').includes('观测缺口核查')).length === 1)

// 6) 缺口报告
const report = svc.buildGapReport()
const rg1 = report.rows.find((x) => x.井点编号 === 'GW-001')
const rg2 = report.rows.find((x) => x.井点编号 === 'GW-002')
check('GW-001 报告缺井深备注且全月缺口', /缺井深/.test(rg1.备注) && rg1.缺口次数 === rg1.应测次数)
check('GW-002 已回填井深，3月6月不缺、其余缺', !/缺井深/.test(rg2.备注) && rg2.缺口次数 === rg2.应测次数 - 2)

// 7) 其它入口巡检待办带观测缺口核查
const todo = svc.createInspectionTodo({ stationNo: 'GW-003', inspector: '测试员', extraItems: ['井口设施'] })
check('其它入口巡检待办含观测缺口核查', String(todo.检查项目).includes('观测缺口核查') && String(todo.检查项目).includes('井口设施'))

// 8) 重复井点已有值不被覆盖：GW-003 重新导入改名+空井深，已有井深保留
const csv2 = [
  '井点编号,井点名称,井深,成井日期,地面高程,管理单位',
  'GW-003,河湾观3井改名,99.00,2026-04-01,,河湾水文站二队',
].join('\n')
r = svc.importBatch('EXC-T2', 'wells2.csv', csv2)
svc.commitBatch(r.batch.id)
const gw3b = listArchives().find((a) => a.井点编号 === 'GW-003')
check('重复井点以已有档案为准（井深25保留、名称保留）', gw3b.井深 === '25.00' && gw3b.井点名称 === '河湾观3井')
check('空缺字段由新文件补齐（管理单位原已有，不变；高程不变）', gw3b.地面高程 === '45.10')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
