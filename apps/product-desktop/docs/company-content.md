# 专家与技能共享

专家套件和技能是桌面的内建产品模块，源码位于 `packages/deepseek-harness-product/experts` 和 `packages/deepseek-harness-product/skills`。左侧“扩展能力”直接进入页面，设置中不再重复展示，也不需要使用人员安装、卸载或独立更新这两个功能插件。模块代码随桌面软件统一构建更新。

专家目录只提供“我的”和“团队共享”，默认没有社区预置专家或专家团。个人内容由本人创建或导入，共享内容经服务端审核发布。专家个人内容继续使用官方 Settings 的稳定配置身份，本机技能文件、Session 历史和固定公司内容版本保持原存储；不读取历史 `settings.yaml.imported` 或恢复旧产品协议。技能发现和专家委派仍走官方扩展 API，不修改执行循环。

## 员工在桌面提交

员工自行编写或导入技能后，在技能条目点击“提交共享”；自定义专家在卡片点击同名操作。桌面读取当前内容及资源文件，确认后使用员工登录态提交，凭据留在主进程。提交、拒绝均不影响本地使用；重新打开同一内容的提交弹窗可查看待审核、已通过或拒绝原因。修改后提交新摘要，不覆盖已有提交记录。

桌面原生启动请求只使用当前 Host 的认证 Cookie，不发送浏览器中历次启动积累的 Cookie。同一员工的登录续期保留提交窗口和进行中的请求；退出或切换账号会取消旧员工的提交，旧请求结束不会解除新提交的操作锁。审核状态查询及提交回执只传输摘要，完整文件通过详情读取。

管理员进入控制中心“专家套件／技能 → 员工提交”，逐项查看正文、资源文件和提交人，通过后自动合并到团队共享目录；拒绝需要填写原因。已发布同名内容有归属限制，其他员工需使用不同名称；并发修改造成冲突时不会覆盖公司当前内容。专家团编排不在此次提交范围内。

公司资源仍按原生格式使用和同步，既有任务固定内容版本。新能力不恢复旧产品技能／套件制品，也不改变 Harness 执行循环。

## 管理员直接发布

公司内容维护在私有源码目录中，不放进公开桌面仓库。管理员也可在控制中心“专家套件”或“技能”页面上传单个原生资源并确认发布。网页上传技能目录／ZIP，专家上传 Markdown／ZIP；一次发布只更新该项内容，其他资源保留。发布工具采用同一接口和冲突规则，内容使用原生文件格式：

```text
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

`current` 查询版本和路径，不输出全文；`export <资源路径> --out <新目录>` 导出已有专家或技能供编辑，并在 `.publication.json` 保存目标资源的来源摘要。修改时保留摘要，同一资源在编辑期间变化会拒绝覆盖。新增资源遇到公司重名也要求先导出确认，不能直接覆盖。原生专家、SKILL.md 和资源文件无需增加产品元数据。

`plan <目录> --out <新计划文件>` 一次准备一个资源，保留其他专家与技能。传入的技能按完整目录替换；下架资源使用空目录并明确 `--remove skills/name` 或 `--remove experts/name`。空目录不会隐式清空公司目录。计划保存服务地址、目标资源基线摘要、候选内容及差异，权限为 600，必须放私有目录并在完成后清理。

`publish <计划文件> --confirm <plan 输出的摘要>` 每次只发布或删除一个技能或专家，使用目标资源的 `expectedSha256` 条件写入并重新读取核实。版本由资源内容摘要确定，无需维护 `release.json` 或全公司版本号。计划被改动、同一资源已变化时停止；其他资源的发布不引发冲突。写入超时只读核实，不重复写入；精确重复执行已生效计划不再写入。专家调整分类仍是同一资源，旧任务保留固定内容。本期发布不包含插件代码或专家团编排清单。

### 控制中心

控制中心分设“专家套件”和“技能”入口，每页包含公司目录与员工提交。管理员上传单个原生资源，预览后确认发布；可以查看或删除单项内容。网页与 AI 工具采用相同的资源摘要检查，服务端合并生成不可变分发快照。连接器在同一入口内分为服务目录和发布审核。

## 员工使用

钉钉登录后先从主进程读取已校验的本地目录，后台检查服务端公司内容。打开专家套件或技能页时先展示本地内容，再自动检查并更新；两页共用一次在途请求，成功检查后默认 60 秒内不重复请求。主进程 `product.json` 的 `companyContentRefreshIntervalMs` 可配置检查间隔，范围为 1 秒至 1 小时；不进行常驻定时轮询。每次检查读取完整发布包，校验 SHA-256 后原子更新本地目录指针。员工无需安装这两个插件；页面通过“团队共享”来源查看内容。专家仍按原生插件的启用、选择和委派方式使用，技能仍由原生 Skill Provider 发现和读取，连接器继续通过产品 MCP 接入。

同步成功后目录和新会话使用新版本，无需重启桌面。每个 Agent 在创建时将公司内容版本与哈希绑定到官方 Session；子会话继承父会话，已有会话继续使用原内容。绑定按员工保存在私有缓存的 `sessions` 目录中，版本和哈希也进入官方上下文快照及会话日志。旧目录保留，防止覆盖被会话引用的文件。

同步失败保留最近校验的目录，页面显示原因并支持重试，不阻塞工作区启动；从未成功同步的设备不能在未知公司目录状态下创建执行会话。取消单页等待不打断其他页面的共享同步；关闭桌面或切换员工会取消并等待该员工的同步。已有会话缺失或损坏绑定、固定内容丢失时明确阻止该会话执行，不替换成最新内容；历史仍保留，可新建对话。恢复以受控并行单次扫描读取并校验每个文件，完成后不缓存校验结果；同一会话的绑定操作串行，不同会话互不等待。扫描按内容文件数量与路径长度限制，子目录不占用文件额度；未知目录及篡改内容拒绝加载。员工令牌仅用于主进程访问产品服务端，不进入 Host 环境或内容目录。

## 维护与验证

专家不再预留社区文件名；发布仍检查资源格式、归属、摘要及实际共享目录内的重名。ID 或名称冲突只标记相关专家不可调用，其余专家和技能继续加载，不自动调用另一份同名说明。

内建模块的原始版本与来源提交见 [vendor 清单](../../../vendor/README.md)，后续产品改动由本仓库 Git 历史记录。合入社区更新时对照各模块的 `upstream.json`，保留公司来源与产品 UI，运行模块测试、公司 Loader 测试、桌面构建和 `verify:upstream`。服务端必须先于新桌面部署 `/api/v1/company-content`；目录尚未发布时返回空内容，个人内容不受影响。

专家入口文件的发布与插件读取上限统一为 128 KiB，读取元数据仍按块限量进行。插件不再包含产品预置专家，桌面与服务端无需同步社区保留 ID 清单。

发布技能的独立校验模块由产品包公开出口生成，CI 在产品构建后检查两者一致，不能手工修改生成文件。产品内容校验规则变化后运行 `node apps/product-desktop/scripts/sync-company-content-skill.mjs --write`，提交生成结果。安装器只复制仓库中的完整技能，不要求使用者执行该生成步骤。

开发热更新沿用原生插件生命周期。Remote 贡献项按顺序开始撤回，但等待依赖插件释放时不占用挂载队列；依赖插件可以撤回自己持有的贡献项，全部释放后才完成卸载。批量重建的验收包含已有会话、插件卸载与重新激活，不能只检查启动页面是否消失。
