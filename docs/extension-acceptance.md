# 扩展与任务验收

## 自动验收

构建 Harness 后，在仓库根目录执行：

```bash
node harness-host/scripts/acceptance-skill-loading.mjs
node harness-host/scripts/acceptance-session-recovery.mjs
cargo test --manifest-path src-tauri/Cargo.toml expert_kits:: --lib
```

模型桩驱动实际运行时，覆盖技能优先级、停用、卸载、会话重启、失败重试和中断恢复。CI 自动执行。

同名技能优先使用显式选择的扩展，其次为独立技能，再次为其他套件。仅将最终选中的技能目录交给运行时。JSON-RPC 通过 SDK 的 `agents.resume` 恢复持久化会话，补丁由 pnpm 锁定并随桌面运行时打包。

## 发布包验收

准备 JSON 数组，每项包含 `kind`、`id`、`version`、`sha256`、`path`。使用已核对摘要的安装包，包含升级前版本和目标 `1.0.1`；无效包通过可选 `expected_error` 声明预期错误。验收覆盖全部官方 Skills 和全栈开发专家。

```bash
XIAOYIN_EXTENSION_FIXTURES=/path/to/fixtures.json \
  cargo test --manifest-path src-tauri/Cargo.toml official_extension_lifecycle --lib -- --ignored --nocapture
```

原生安装器在临时目录验证安装、重复安装、升级、启停、技能目录及卸载，不操作员工已有扩展。

## 真实代码任务

配置 `DEEPSEEK_API_KEY` 和 `XIAOYIN_ACCEPTANCE_SKILL_DIRS`。后者为包含 `unit-testing` 的技能目录 JSON 数组。

```bash
node harness-host/scripts/acceptance-code-task.mjs
```

任务在临时 Git 项目中修复中位数函数，要求加载技能、复现失败、修改源码、通过测试并展示差异；随后重启运行时，核对原会话与文件。报告位于 `output/acceptance-code-task.json`，通过后清理临时项目，失败时保留供排查。真实模型验收按需执行，不在 CI 中消耗模型额度。
