# 公司专家与技能

专家套件、技能是两个独立 Cordis 插件，源码固定在 `vendor/dsh-agency-agents`、`vendor/dsh-skills-manager`，随产品桌面预装。公司分支保留原生目录、技能发现、专家委派及个人内容管理，移除页面 GitHub、重复反馈与插件独立更新；插件代码随软件统一更新。社区内容仓库的同步仍用于更新内容，不是软件更新。

产品启动通过通用 profile `replace` 补丁固定这两个插件及专家远程服务的模块来源；已有同名 npm 安装不参与执行，原条目 ID、配置及停用状态保留。缺失条目通过 `defaults` 插入到用户配置之前，用户修改保存稳定包名，重启和软件升级继续生效。补丁仅作用于本次 Host 启动，不覆盖其他插件。

## 发布内容

公司内容维护在私有源码目录中，不放进公开桌面仓库。内容使用原生文件格式：

```text
release.json                       # {"version":"1.0.0"}
experts/operations/orders.md
skills/orders/SKILL.md
skills/orders/references/policy.md
```

专家 Markdown 和 `SKILL.md` 使用 `---` 分隔的 frontmatter，`name`、`description` 必须为非空单行字符串，正文不能为空。技能 `name` 与目录名一致。专家与技能保留原名，不要求公司前缀；公司来源由加载配置标识。专家文件名在所有分类中唯一。专家分类来自实际目录，不受社区内置分类限制。资源只能是普通文件，不接受符号链接、路径穿越及跨平台冲突名称。每包最多 2,048 个文件、32 MiB 解码内容；入口说明最多 128 KiB。公司内容只包含说明及技能资源，不包含插件代码、员工令牌或连接器私密配置。

<a id="ai-publishing"></a>
### Codex／Claude 发布

安装共用的[公司内容发布技能](../skills/harness-company-publish/SKILL.md)后，可直接要求 AI：“将这个专家套件发布到公司”或“修改公司订单技能后发布”。普通使用人员无需安装发布技能或取得发布权限。安装后的技能只依赖 Node.js 22.19+，不依赖桌面源码及构建工具；内容只发布到服务端，无需提交桌面仓库或重新打包软件。

完整技能及安装器随 `deepseek-harness-desktop` 仓库维护，不需要手工分发 ZIP。给同事仓库地址，让其使用的 Codex 或 Claude 执行：

> 从 http://192.168.2.66:3300/instudio/deepseek-harness-desktop 安装公司内容发布技能，按 apps/product-desktop/docs/company-content.md 的“仓库安装与更新”操作，安装到我当前使用的工具。

#### 仓库安装与更新

前提是可以读取公司 Gitea 仓库，并已安装 Node.js 22.19+。全新检出即可安装，不需要 pnpm、桌面依赖或构建产物。AI 可使用浅层稀疏检出，只下载发布工具及文档：

```sh
git clone --depth 1 --filter=blob:none --sparse http://192.168.2.66:3300/instudio/deepseek-harness-desktop.git harness-company-tools
cd harness-company-tools
git sparse-checkout set apps/product-desktop/scripts apps/product-desktop/skills apps/product-desktop/docs
node apps/product-desktop/scripts/install-company-content-skill.mjs --client codex
```

Claude Code 使用 `--client claude`，两者都用则为 `--client both`。安装到当前用户的技能目录；已有 Codex 自定义 `CODEX_HOME` 时沿用该配置。Windows 同样执行 Node 命令，无需 WSL。安装完成后在工具的新对话中使用该技能。

更新时告诉 AI“从桌面仓库更新公司发布技能”。它在干净的工具检出中拉取 `main` 并重新安装；检出或本地技能存在自行修改时先保留并核对，不直接覆盖：

```sh
git pull --ff-only origin main
node apps/product-desktop/scripts/install-company-content-skill.mjs --client codex --replace
```

技能源码和依赖完整位于 `apps/product-desktop/skills/harness-company-publish/`，支持直接按该路径从仓库安装。维护者修改后通过正常 PR 和 CI 合并到 `main`，同事从同一仓库更新；不向安装包或技能目录写入公司正文、用户数据或凭据。普通桌面使用人员无需安装此发布工具。

发布人员的受控配置位于 `~/.config/deepseek-harness/company-content-publisher.json`，字段为 `COMPANY_CONTENT_SERVER_URL`（包括产品入口前缀）和 `COMPANY_CONTENT_PUBLISHER_TOKEN`。可使用成对同名环境变量或显式 `--config` 文件，不混用不同来源的地址与凭据。POSIX 配置归当前用户且权限为 600，Windows 由用户 ACL 保护；令牌不进入模型上下文、命令参数、内容、计划或日志。服务端配置独立的 `deepseek-harness.company-content.publisher-token`，默认关闭机器发布；只开放公司内容读取和发布，不授予员工或其他管理接口权限。

源码及安装后的工具均位于技能的 `scripts/publish-company-content.mjs`。完整操作示例见技能；在仓库中校验私有目录：

```sh
node apps/product-desktop/skills/harness-company-publish/scripts/publish-company-content.mjs check /path/to/private-content
```

`current` 查询版本和路径，不输出全文；`export <资源路径> --out <新目录>` 导出已有专家或技能供编辑，并在 release.json 保存来源摘要。修改时保留摘要并使用新版本，同一资源在编辑期间变化会拒绝覆盖。新增资源遇到公司重名也要求先导出确认，不能直接覆盖。原生专家、SKILL.md 和资源文件无需增加产品元数据。

`plan <目录> --out <新计划文件>` 读取当前完整内容并合并本次资源，保留其他专家与技能。传入的技能按完整目录替换，省略的旧资源出现在移除差异里；下架整个资源必须明确 `--remove skills/name` 或专家 Markdown 路径。空内容目录不会隐式清空公司目录。计划保存服务地址、基线版本和哈希、完整候选内容及差异，权限为 600，必须放私有目录并在完成后清理。

`publish <计划文件> --confirm <plan 输出的摘要>` 只提交该预览内容，使用 expectedVersion 条件写入并重新查询生效版本。计划被改动、编辑资源已变化或其他发布者抢先发布时停止，不自动覆盖；写入超时只读核实，不重复写入。精确重复执行已生效计划不再 POST；旧版本的幂等回执不能被误报为当前已生效。本期发布不包含插件代码或专家团编排清单。

### 控制中心

管理员也可在控制中心“公司内容”上传目录或 ZIP，校验预览后发布。网页发布的是完整集合，适合统一维护整份目录；AI 工具先增量合并，再通过同一服务端发布完整集合，两者使用相同的并发检查和不可变版本规则。

## 员工使用

钉钉登录后先从主进程读取已校验的本地目录，后台检查服务端公司内容。打开专家套件或技能页时先展示本地内容，再自动检查并更新；两页共用一次在途请求，成功检查后默认 60 秒内不重复请求。主进程 `product.json` 的 `companyContentRefreshIntervalMs` 可配置检查间隔，范围为 1 秒至 1 小时；不进行常驻定时轮询。每次检查读取完整发布包，校验 SHA-256 后原子更新本地目录指针。员工无需安装这两个插件；页面通过“公司”来源查看内容。专家仍按原生插件的启用、选择和委派方式使用，技能仍由原生 Skill Provider 发现和读取，连接器独立授权。

同步成功后目录和新会话使用新版本，无需重启桌面。每个 Agent 在创建时将公司内容版本与哈希绑定到官方 Session；子会话继承父会话，已有会话继续使用原内容。绑定按员工保存在私有缓存的 `sessions` 目录中，版本和哈希也进入官方上下文快照及会话日志。旧目录保留，防止覆盖被会话引用的文件。

同步失败保留最近校验的目录，页面显示原因并支持重试，不阻塞工作区启动；从未成功同步的设备不能在未知公司目录状态下创建执行会话。取消单页等待不打断其他页面的共享同步；关闭桌面或切换员工会取消并等待该员工的同步。已有会话缺失或损坏绑定、固定内容丢失时明确阻止该会话执行，不替换成最新内容；历史仍保留，可新建对话。员工令牌仅用于主进程访问产品服务端，不进入 Host 环境或内容目录。

## 维护与验证

第三方版本、来源提交和完整本地修改见 [vendor 清单](../../../vendor/README.md)。升级插件时对照 `upstream.json`，重新应用公司来源与 UI 修改，运行原插件测试、公司 Loader 测试、桌面构建和 `verify:upstream`。服务端必须先于新桌面部署 `/api/v1/company-content`；目录尚未发布时返回空内容，员工个人与社区内容不受影响。

发布技能的独立校验模块由产品包公开出口生成，CI 在产品构建后检查两者一致，不能手工修改生成文件。产品内容校验规则变化后运行 `node apps/product-desktop/scripts/sync-company-content-skill.mjs --write`，提交生成结果。安装器只复制仓库中的完整技能，不要求使用者执行该生成步骤。

开发热更新沿用原生插件生命周期。Remote 贡献项按顺序开始撤回，但等待依赖插件释放时不占用挂载队列；依赖插件可以撤回自己持有的贡献项，全部释放后才完成卸载。批量重建的验收包含已有会话、插件卸载与重新激活，不能只检查启动页面是否消失。
