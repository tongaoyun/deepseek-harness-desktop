import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { resolvePrimaryRuntime } from '@deepseek-ai/dsh-tool-workspace-dependencies'
import { DeepSeekHarnessRuntime } from '../dist/runtime.js'
import { evaluationMetrics } from './evaluation-metrics.mjs'

const scenario = process.argv[2]
assert(['spreadsheet', 'document', 'clarification'].includes(scenario), 'Unknown evaluation scenario')
assert(process.env.DEEPSEEK_API_KEY, 'DEEPSEEK_API_KEY is required')
const root = await mkdtemp(join(tmpdir(), `xiaoyin-eval-${scenario}-`))
const workspace = join(root, 'project')
assert(process.env.DSH_PRIMARY_RUNTIME || process.env.DSH_BUNDLED_PRIMARY_RUNTIME, 'DSH_PRIMARY_RUNTIME is required for Office evaluation')
const primaryRuntime = resolve(process.env.DSH_PRIMARY_RUNTIME ?? process.env.DSH_BUNDLED_PRIMARY_RUNTIME)
const dependencies = await resolvePrimaryRuntime(primaryRuntime)
const officeChecker = resolve(primaryRuntime, '..', 'office-skills', 'scripts', 'check_office.py')
await mkdir(workspace)
const source = scenario === 'spreadsheet' ? 'item,quantity,unitPrice\nA,2,10\nB,1,30\n'
  : scenario === 'document' ? '# 报销制度\n单次报销上限800元。每月5日前提交上月费用，必须附发票。审批人是部门负责人。\n'
    : '# 供应商候选\nA 和 B 均已通过资质审核。价格、交期和本次采购数量尚未提供。\n'
const sourceFile = scenario === 'spreadsheet' ? 'sales.csv' : 'source.md'
await writeFile(join(workspace, sourceFile), source)
Object.assign(process.env, {
  DSH_HOME: join(root, 'home'), DSH_SESSION_ROOT: join(root, 'sessions'), DSH_CWD: workspace,
  XIAOYIN_LOCAL_FILE_ROOTS: JSON.stringify([{ id: 'project', name: '评测项目', path: workspace }]),
  XIAOYIN_MCP_CONNECTORS: '[]', XIAOYIN_COMPUTER_USE_TOOLS: '[]', XIAOYIN_ALLOW_BROWSER: 'false',
  DSH_CUSTOM_SKILL_DIRS: '[]', XIAOYIN_EXECUTION_MODE: 'agent', XIAOYIN_TURN_TIMEOUT_MS: '240000',
})
const prompts = {
  spreadsheet: '读取 sales.csv，生成 sales.xlsx 并交付。工作表名 Sales，A1:D1为item、quantity、unitPrice、amount，数据顺序与CSV一致，D2、D3分别使用公式B2*C2、B3*C3，D4使用SUM(D2:D3)。检测本机Office引擎并重算公式，交付具有实际计算结果的 sales-checked.xlsx。检查金额总计，不改CSV。不联网、不安装依赖、不委派。',
  document: '根据 source.md 生成并交付 notice.docx，标题为报销须知，清楚说明报销上限、提交期限、凭证和审批人。只依据原文，不增加规定。读取并检查生成文档的内容，保留源文件。不联网、不安装依赖、不委派。',
  clarification: '请根据 source.md 比较这两家供应商，并确定本次采购总成本最低的选择。仅分析，不创建或修改文件，不联网。缺少必需资料时先向我询问，不猜测价格和数量。',
}
let runtime = new DeepSeekHarnessRuntime()
const metrics = evaluationMetrics()
const report = { scenario, passed: false, realModel: true, model: process.env.DSH_MODEL ?? 'deepseek-v4-flash', humanInterventions: 0 }
const collect = (notification) => metrics.collect(notification)
try {
  const result = await runtime.run({ prompt: prompts[scenario] }, collect)
  if (scenario === 'spreadsheet') {
    assert.equal(result.outcome?.status, 'completed')
    const verify = async (filename, total, quantity) => {
      const path = join(workspace, filename)
      execFileSync(dependencies.python, ['-I', '-B', officeChecker, path, '--contains', 'Sales', '--count', '1'], { stdio: 'pipe' })
      execFileSync(dependencies.python, ['-I', '-B', '-c', `
import json, sys
from openpyxl import load_workbook
path, expected_total, expected_quantity = sys.argv[1], float(sys.argv[2]), int(sys.argv[3])
formulas = load_workbook(path, data_only=False)['Sales']
values = load_workbook(path, data_only=True)['Sales']
actual = {
  'A2': formulas['A2'].value, 'A3': formulas['A3'].value,
  'B2': formulas['B2'].value, 'B3': formulas['B3'].value,
  'C2': formulas['C2'].value, 'C3': formulas['C3'].value,
  'D2_formula': str(formulas['D2'].value).replace('$', '').upper(),
  'D3_formula': str(formulas['D3'].value).replace('$', '').upper(),
  'D4_formula': str(formulas['D4'].value).replace('$', '').upper(),
  'D2': values['D2'].value, 'D3': values['D3'].value, 'D4': values['D4'].value,
}
expected = {
  'A2': 'A', 'A3': 'B', 'B2': expected_quantity, 'B3': 1, 'C2': 10, 'C3': 30,
  'D2_formula': '=B2*C2', 'D3_formula': '=B3*C3', 'D4_formula': '=SUM(D2:D3)',
  'D2': expected_quantity * 10, 'D3': 30, 'D4': expected_total,
}
if actual != expected:
  raise SystemExit('spreadsheet verification failed: ' + json.dumps({'actual': actual, 'expected': expected}, ensure_ascii=False))
`, path, String(total), String(quantity)], { stdio: 'pipe' })
    }
    await verify('sales-checked.xlsx', 50, 2)
    const resumed = await runtime.run({ sessionId: result.sessionId, prompt: '追加修改：将 Sales 中商品 A 的数量从2改为3，保留所有金额公式。重新计算并将最终可核验结果交付为 sales-updated.xlsx，不改CSV，不覆盖已交付文件。' }, collect)
    assert.equal(resumed.sessionId, result.sessionId)
    assert.equal(resumed.outcome?.status, 'completed')
    await verify('sales-updated.xlsx', 60, 3)
    await verify('sales-checked.xlsx', 50, 2)
    report.turns = 2
  } else if (scenario === 'document') {
    assert.equal(result.outcome?.status, 'completed')
    const path = join(workspace, 'notice.docx')
    execFileSync(dependencies.python, ['-I', '-B', officeChecker, path,
      '--contains', '报销须知', '--contains', '800', '--contains', '每月5日前',
      '--contains', '上月费用', '--contains', '发票', '--contains', '部门负责人'], { stdio: 'pipe' })
    execFileSync(dependencies.python, ['-I', '-B', '-c', `
import sys
from docx import Document
text = '\n'.join(paragraph.text for paragraph in Document(sys.argv[1]).paragraphs)
if '500' in text:
  raise SystemExit('document contains invented reimbursement amount 500')
`, path], { stdio: 'pipe' })
    report.turns = 1
  } else {
    assert.equal(result.outcome?.status, 'needs_input')
    assert.match(result.finalResponse, /价格|报价|单价/)
    assert.match(result.finalResponse, /数量/)
    assert.deepEqual(await readdir(workspace), [sourceFile])
    report.expectedClarifications = 1
    report.turns = 1
  }
  assert.equal(await readFile(join(workspace, sourceFile), 'utf8'), source, 'Source file changed')
  report.sessionId = result.sessionId
  report.passed = true
} catch (error) { report.error = error.message; report.workspace = workspace; process.exitCode = 1 }
finally {
  await runtime.close()
  report.metrics = metrics.result()
  const reportPath = resolve(process.env.XIAOYIN_ACCEPTANCE_REPORT ?? `output/evaluation-${scenario}.json`)
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ scenario, passed: report.passed, reportPath, durationMs: report.metrics.durationMs }))
  if (report.passed) await rm(root, { recursive: true, force: true })
}
