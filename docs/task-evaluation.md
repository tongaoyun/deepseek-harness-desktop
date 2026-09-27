# 真实任务评测

使用生产 Harness 和真实模型，在独立临时目录执行固定任务。模型的完成声明、工具调用记录和模型之外的文件验证共同决定结果。

| 任务 | 验证 |
| --- | --- |
| 代码修复与恢复 | 加载 unit-testing、复现失败、修复中位数、4 项测试通过、原测试未变、重启运行时后同一会话续跑 |
| 写入后退出、崩溃与断网 | 独立 Host 进程执行真实模型任务；MCP 写入后断开桌面管道、强制终止进程组或断开连接，核对持久化记录，新进程先只读查询，订单仅创建一次，补齐 Markdown 回执 |
| 表格核算与追加修改 | 读取 CSV、保留公式、实际重算 XLSX、总额 50 变为 60、原交付文件和 CSV 保留 |
| 制度文档 | DOCX 包含源文指定的金额、期限、凭证与审批人，源文件未变 |
| 资料不足 | 询问价格和数量，结果为 needs_input，不修改或创建工作文件 |

## 运行

```bash
pnpm --dir harness-host build
pnpm evaluation:list
pnpm evaluation:run
pnpm evaluation:run --case=interrupted-write
pnpm evaluation:run --case=crash-write --case=network-write
```

环境要求：`DEEPSEEK_API_KEY`；按需设置 `DEEPSEEK_BASE_URL`、`DSH_MODEL`。`XIAOYIN_ACCEPTANCE_SKILL_DIRS` 为技能目录的 JSON 数组，需包含 unit-testing。表格评测使用安装包内的官方 Primary Runtime 和 LibreOffice Kit。凭据通过进程环境注入，不写入报告。

`--case=<任务ID>` 可重复指定，只运行所选任务。技能目录仅代码评测需要。中断评测使用真实模型和本机受控 MCP 服务，不向真实业务系统创建订单。

`XIAOYIN_EVAL_REPEATS` 设置每个场景重复次数，范围 1 至 10，默认 1。顺序执行，每个场景最多 10 分钟，超时终止进程树。`XIAOYIN_EVAL_REPORT_DIR` 指定输出目录，默认 `output/evaluation-<时间>/`。

## 报告

`summary.json` 持续保存通过率、耗时、首个活动耗时、工具调用数、提供方 Token 用量及各场景报告路径。同一轮次和步骤的重复用量回执只计一次。程序自动执行，人工介入为 0；合理澄清单独记录，不算失败。

费用需要同时设置 `XIAOYIN_EVAL_INPUT_PER_MILLION`、`XIAOYIN_EVAL_OUTPUT_PER_MILLION`、`XIAOYIN_EVAL_CACHE_READ_PER_MILLION`、`XIAOYIN_EVAL_CACHE_WRITE_PER_MILLION`。币种由 `XIAOYIN_EVAL_CURRENCY` 指定，默认 CNY。缺少单价或提供方用量时，费用为 null，不估造账单。

全部场景通过才返回成功退出码。成功场景清理临时工作目录，失败场景保留现场。单次通过仅代表本轮样本通过，不代表生产成功率；发布前对相同模型和版本重复运行。文档检查不等同于全面事实核查或版面验收，当前评测也不代替原生 GUI 和 ERP 业务验收。

## 连接器授权验收

构建 Harness 后运行 `node scripts/acceptance-connector-oauth.mjs`，使用隔离的本地开发身份和本机 OAuth/MCP 服务，验证浏览器 PKCE、系统钥匙串、并发刷新、401 不重放、断开授权、任务检查点跨重启保留和账号隔离。测试不读取或转发 ERP Cookie，不访问真实业务账户；报告路径可由 `XIAOYIN_ACCEPTANCE_REPORT` 指定。
