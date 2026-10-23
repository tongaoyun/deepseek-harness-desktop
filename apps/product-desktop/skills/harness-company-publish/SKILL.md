---
name: harness-company-publish
description: 创建、修改、校验并发布公司 DeepSeek Harness 专家、专家团和技能，让全公司桌面同步使用。适用于要求将原生专家、完整专家团或 SKILL.md 发布到公司的任务；不负责发布桌面软件、插件代码、连接器或知识库。
---

# 公司专家与技能发布

使用本技能的 `scripts/publish-company-content.mjs`，下文 `TOOL` 表示该文件的实际绝对路径。安装包只需 Node.js 22.19+；不需要 Harness 桌面源码、构建工具或 Python。当前内容发布到公司服务端，不提交到公开桌面仓库，也不重新打包客户端。

技能维护在公司 `deepseek-harness-desktop` 仓库的 `apps/product-desktop/skills/harness-company-publish/`，完整安装及更新说明位于同仓库 `apps/product-desktop/docs/company-content.md`。用户要求更新技能时，从可信的仓库 `main` 获取最新目录，使用其安装器更新当前客户端；保留自行修改的文件，不把更新工具扩大为发布公司内容。

用户明确要求发布即授权本次指定内容的发布。先展示本次差异，再在已有授权范围内执行；只要求编写、检查或预览时不要发布。删除或替换范围不明确时先澄清，不因发布一个资源而删除其他资源。

## 本机接入

默认私有配置是 `~/.config/deepseek-harness/company-content-publisher.json`（Windows 使用当前用户目录）。字段为 `COMPANY_CONTENT_SERVER_URL`（包括产品入口前缀）和 `COMPANY_CONTENT_PUBLISHER_TOKEN`。也接受成对的同名环境变量，或 `--config <受控配置文件>`；显式文件优先。不从另一个来源补齐缺失的地址或凭据。

服务端必须已开通独立的公司内容发布凭据。员工登录、Gitea 账号、Codex／Claude 订阅不授予公司发布权限。不要读取并回显配置文件、向对话索要令牌、把令牌写进命令参数、内容目录或 Git；脚本自行读取配置。POSIX 文件归当前用户且权限为 600，Windows 通过用户 ACL 保护。没有接入时先完成内容校验，报告缺少发布配置，不自行扩大权限。

## 编写与修改

每次只处理一个技能、专家或专家团，使用原生目录，不需要自定义版本清单：

```text
experts/orders/orders.md       # 专家；或下面的单项技能
skills/orders/SKILL.md
skills/orders/references/policy.md
teams/order-diagnosis.json     # 或一个完整专家团（包含全部成员说明）
```

专家 Markdown 与 SKILL.md 使用 `---` frontmatter，`name`、`description` 为非空单行字符串，正文非空。技能 name 与目录名一致；专家按文件名识别身份，分类不参与身份。优先使用桌面的跨境 ERP 场景分类，如订单 `orders`、商品 `catalog`、采购 `supply-chain`、仓储 `warehouse`、物流 `logistics`、财务 `finance`；完整目录见仓库的 `apps/product-desktop/docs/company-content.md`。技能必须带齐资源，更新完整替换该技能目录，省略的旧资源会删除并出现在差异里，其他资源不变。每项最多 2048 文件、32 MiB，入口 Markdown 最多 128 KiB；不接受链接、非法路径、目录大小写冲突。

修改已有资源先查询、导出：

```sh
node TOOL current
node TOOL export skills/orders --out /private/work/new-edit-directory
node TOOL export experts/orders --out /private/work/new-expert-directory
```

导出到尚不存在的目录，包含原生文件及 `.publication.json` 的资源基线摘要。保留这个编辑来源，不手工修改或移除摘要来绕过冲突；它不属于发布内容。专家移动分类时直接移动 Markdown 文件，无需删除旧分类。编辑期间同资源发生变化报 EDIT_CONFLICT；其他资源发布不影响本次编辑。新增资源无需来源文件；已有同名资源必须先导出再修改，不能隐式覆盖。

## 校验、预览和发布

```sh
node TOOL check /private/work/content
node TOOL plan /private/work/content --out /private/work/new-plan.json
```

`plan` 只读取服务端，输出目标资源的新增、修改、移除差异、预期摘要及 confirmation。计划只包含该项资源，保存在私有目录，不提交 Git 或贴到对话。核对技能旧资源移除项，不能把发布一个资源扩大为修改其他资源。

明确删除时对空目录生成计划，追加 `--remove skills/orders` 、`--remove experts/orders` 或 `--remove teams/order-diagnosis`。每次只删除一个完整资源，不支持通配符或单独删除 SKILL.md；空目录不会清空公司目录。删除使用资源摘要检查，历史分发快照保留。

已有发布授权且差异与请求一致后，使用这次 plan 输出的完整摘要：

```sh
node TOOL publish /private/work/new-plan.json --confirm <confirmation>
```

发布前再次比对目标资源摘要，以 expectedSha256 条件写入；摘要校验阻止计划被替换。发布后重新读取并核对该资源，其他资源同期发布不影响结果。任务结束清理本次临时导出与计划，不删除用户的源码。

## 冲突与结果

- PUBLICATION_CONFLICT：别人先发布了内容，没有覆盖。重新生成计划、检查新增差异；涉及同一资源时重新导出并合并。最多自动重新规划一次，再次冲突则停止并说明，不能循环发布。
- EDIT_CONFLICT：本次编辑基于的资源已变化，保留编辑文件；重新导出比较后合并，不能直接换摘要。
- REQUEST_UNCONFIRMED：写入可能已成功，工具只读取核实、不重试写入。使用 current 查询；目标资源摘要等于计划才算已生效，其他结果不能宣称失败回滚或重新发布。
- VERSION_NOT_CURRENT：回执不能证明该项资源仍生效，查询并说明实际内容；不重新激活旧版本。
- PUBLICATION_DENIED：停止需要此权限的操作，报告配置或权限问题，不借用员工令牌、其他服务凭据或浏览器会话。

交付说明资源标识、内容摘要和服务端核实结果。员工打开专家套件或技能页面后自动同步，成功检查间隔默认 60 秒；现有会话继续使用原固定版本，新会话使用更新后的内容。不要声称所有设备已同步，除非有相应设备证据。

### 专家团

`teams/<稳定标识>.json` 包含 `team` 和 `experts`，不带本机团队 ID。`team` 的 `members[].expertSlug` 使用包内键 `member-1`～`member-8`；`experts` 每项包含 `key`、`name`、`description`、`division`、`emoji`、`prompt`。必须包含 2～8 位不同成员及其完整说明，禁止只引用发布者本机专家。主理人字段与桌面团队编辑器一致；模板版本固定为 1，使用自定义模式时须提供主理人正文。完整示例从控制中心“专家套件 → 专家团 → 下载示例”获取。文件上限 2 MiB，更新与删除整个团队原子进行，保留旧会话的固定内容。
