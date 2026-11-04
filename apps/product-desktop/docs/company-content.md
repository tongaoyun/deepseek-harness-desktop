# 专家、技能与专家团

个人内容在桌面“扩展能力 → 我的”管理，公司审核内容在“市场”使用。技能、专家和专家团分别使用标准 Skill 包、AgentSpec 包和 Team JSON；执行复用 Harness 原生 Skill Provider、Subagent、Agent Team、MCP 与审批。

## 技能包

```text
skills/orders/
├── SKILL.md
├── scripts/
├── references/
└── assets/
```

`SKILL.md` 的 frontmatter 包含非空 `name`、`description`，名称与目录一致，正文非空。脚本、资料和二进制模板随包保留，加载及调用规则由原生 Skill Provider 决定。公司技能发布到 Nacos Skill Registry。

可选的 `metadata.category` 保存不超过 24 字符的分类名称，例如 `文档办公`、`数据分析`。桌面 AI 创建技能时选择分类；导入和市场同步读取包内分类，未声明时显示“未分类”。个人分类可调整，提交发布时将当前分类写入导出包，原生加载与调用权限保持独立。

## 专家包

```text
experts/order-expert/
├── manifest.json
├── config/
│   ├── SOUL.md
│   └── AGENTS.md
├── references/
└── assets/
```

最小 `manifest.json`：

```json
{
  "worker": { "suggested_name": "order-expert" },
  "description": "核对订单异常并提供处理建议"
}
```

包标识取自 `worker.suggested_name`，使用小写字母、数字和连字符，最多 80 字符。产品创建的包必须包含非空 `config/SOUL.md`；`config/AGENTS.md`、参考资料和模板可选。AgentSpec 的其他字段原样保留。展示名称、分类和头像由产品目录元数据管理，不写入 AgentSpec 私有字段。

编辑器支持目录或 ZIP 导入、完整 ZIP 导出、两份说明编辑与附件增删。专家说明作为字面量提示词传入原生子代理，提示词提供固定版本的资源根目录；模型通过原生文件工具按需阅读资料。包内 Dockerfile、安装声明和定时任务不会被执行，也不启动 HiClaw Worker。说明可以指导模型使用技能、MCP 和知识库，实际权限与写操作审批仍由宿主决定。

## 专家团

个人和公司团队使用同一份版本化文档，根字段为 `schemaVersion: 1`、`id`、`team`。`team` 包含名称、简介、标签、目标、约束、交付要求、主理人规则、任务示例和 2～8 位不同专家的分工。每个成员包含 `expertSlug`、`expertVersion`、`expertSha256`、`duty` 和 `instructions`；不嵌入专家正文。

保存团队时固定成员版本。专家更新后，编辑并重新保存或发布团队才能升级成员。发布公司团队前，成员必须是已发布的公司专家，且精确版本可读取；依赖缺失时拒绝发布。团队文件为 `teams/<id>.json`，最多 2 MiB，控制中心提供格式示例。执行沿用当前会话可用的原生 Agent Team 或子代理，不新增调度引擎。

## 个人内容

专家文件保存在按员工隔离、按摘要寻址的本地不可变目录。官方 Settings 保存资源引用、展示信息、启用状态和团队文档。保存先完整写入文件，再以原生修订号原子更新引用；并发冲突保留编辑草稿，不覆盖其他窗口的修改。

首次读取个人内容时转换已有专家和团队。个人专家正文转成 AgentSpec 文件，公司成员引用失效时显示需要重新选择，不自动替换。切换员工使用独立目录和 Settings 投影。升级操作见[内容协议升级说明](../../../docs/upgrade-guide/v0.2.2-alpha.3/company-content-agentspec/guide.zh.md)。

## 提交与审核

员工在技能、个人专家或团队条目点击“提交发布”，使用当前员工认证提交完整资源。提交、拒绝不改变本地内容；修改后可提交新的内容版本。管理员在控制中心“技能／专家套件 → 员工提交”查看说明、附件和团队固定成员引用，通过后发布到市场；拒绝须填写原因。

管理员也可直接导入单项资源，检查预览及差异后发布。每次只更新或下架一个完整资源，其他资源保留。包最多 2,048 文件、32 MiB，入口说明最多 128 KiB；不接受链接、路径穿越、文件与目录冲突或大小写别名。员工令牌、Nacos 凭据与连接器私密配置不属于内容包。

## 同步与存储

Nacos 专用命名空间为 `deepseek-harness-content`：Skill Registry 存技能，AgentSpec 存专家，Config 的 `DEEPSEEK_HARNESS_CONTENT` Group 存不可变团队文档。PostgreSQL 保存审核草稿、归属、目录投影、版本引用与发布索引。既有 MCP 注册和发现链路独立运行。

发布先完成 Nacos 写入和读回校验，再用短数据库事务检查目标资源基线并切换索引。网络失败、依赖缺失或并发冲突不会更新正式目录；超时只读核实实际结果，不盲目重复发布。

桌面读取协议版本 2 的资源索引，只下载变化的精确版本，校验完整后原子激活。取消同步、文件损坏或员工切换不能安装部分版本。新会话固定发布索引和资源摘要，子会话继承；已开始的会话不随同步切换版本。旧协议桌面须更新，历史会话仍可查看。

<a id="ai-publishing"></a>
## AI 发布工具

[公司内容发布技能](../skills/harness-company-publish/SKILL.md)随仓库维护，安装后只需要 Node.js 22.19+，不需要桌面源码或重新打包客户端。

```sh
node apps/product-desktop/scripts/install-company-content-skill.mjs --client codex
node apps/product-desktop/scripts/install-company-content-skill.mjs --client claude
```

更新时追加 `--replace`。本机私有配置为 `~/.config/deepseek-harness/company-content-publisher.json`，字段是 `COMPANY_CONTENT_SERVER_URL` 和 `COMPANY_CONTENT_PUBLISHER_TOKEN`，也可使用成对环境变量或显式 `--config` 文件。POSIX 文件权限为 600；凭据不得进入内容包、Git 或对话。

发布流程为 `check → plan → publish`；修改现有资源先 `current`、`export`，保留导出的 `.publication.json` 基线和目录元数据。工具只读取目标资源版本，按 `expectedRevision` 检查内容与展示信息，发布后读回索引核实。完整命令和异常处理见技能说明。

开发与验收见[专家模块](../../../packages/deepseek-harness-product/experts/README.md)、[技能模块](../../../packages/deepseek-harness-product/skills/README.md)和[验收入口](acceptance.md)。
