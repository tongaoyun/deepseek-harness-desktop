---
name: harness-company-publish
description: 创建、修改、校验并发布公司 DeepSeek Harness 专家套件和技能，让全公司桌面同步使用。适用于要求将原生专家或 SKILL.md 发布到公司的任务；不负责发布桌面软件、插件代码、连接器或知识库。
---

# 公司专家与技能发布

使用本技能的 `scripts/publish-company-content.mjs`，下文 `TOOL` 表示该文件的实际绝对路径。安装包只需 Node.js 22.19+；不需要 Harness 桌面源码、构建工具或 Python。当前内容发布到公司服务端，不提交到公开桌面仓库，也不重新打包客户端。

技能维护在公司 `deepseek-harness-desktop` 仓库的 `apps/product-desktop/skills/harness-company-publish/`，完整安装及更新说明位于同仓库 `apps/product-desktop/docs/company-content.md`。用户要求更新技能时，从可信的仓库 `main` 获取最新目录，使用其安装器更新当前客户端；保留自行修改的文件，不把更新工具扩大为发布公司内容。

用户明确要求发布即授权本次指定内容的发布。先展示本次差异，再在已有授权范围内执行；只要求编写、检查或预览时不要发布。删除或替换范围不明确时先澄清，不因发布一个资源而删除其他资源。

## 本机接入

默认私有配置是 `~/.config/deepseek-harness/company-content-publisher.json`（Windows 使用当前用户目录）。字段为 `COMPANY_CONTENT_SERVER_URL`（包括产品入口前缀）和 `COMPANY_CONTENT_PUBLISHER_TOKEN`。也接受成对的同名环境变量，或 `--config <受控配置文件>`；显式文件优先。不从另一个来源补齐缺失的地址或凭据。

服务端必须已开通独立的公司内容发布凭据。员工登录、Gitea 账号、Codex／Claude 订阅不授予公司发布权限。不要读取并回显配置文件、向对话索要令牌、把令牌写进命令参数、内容目录或 Git；脚本自行读取配置。POSIX 文件归当前用户且权限为 600，Windows 通过用户 ACL 保护。没有接入时先完成内容校验，报告缺少发布配置，不自行扩大权限。

## 编写与修改

内容目录只放本次涉及的资源，原生格式如下：

```text
release.json                      # {"version":"1.0.1"}
experts/operations/orders.md
skills/orders/SKILL.md
skills/orders/references/policy.md
```

专家 Markdown 与 SKILL.md 具有 `---` frontmatter，`name`、`description` 为非空单行字符串，正文非空。技能 name 与目录名一致；专家文件名在分类间唯一。无需 company- 前缀。技能必须带齐其资源文件，脚本按整个技能目录替换，省略的旧资源会删除并出现在差异里。内容总量最多 2048 文件、32 MiB，入口 Markdown 最多 128 KiB；不接受链接或非法路径。

技能元数据按 YAML 1.2 解析，简介中的布尔值、数字等必须加引号；不接受重复字段、未知标签或别名。调用控制使用原生 `disable-model-invocation`、`user-invocable` 布尔字段，不使用驼峰旧字段。校验失败应修改源文件，不跳过校验或自动改写内容。

修改已有资源先查询并导出。工具不会把公司全部正文输出到终端：

```sh
node TOOL current
node TOOL export skills/orders --out /private/work/new-edit-directory
```

专家使用 `export experts/operations/orders.md`。导出到尚不存在的目录；包含当前完整资源及 release.json 的 `baseResources` 摘要。读取需要的导出文件再编辑，保留摘要，并将 version 改成未使用的新内容版本。编辑期间该资源变化会报 EDIT_CONFLICT；其他无关资源的新版本可正常合并。不要删除来源摘要来绕过冲突。

新增资源直接创建上述目录。遇到 RESOURCE_EXISTS 时先导出当前资源，确认确实要修改它；不要把重名创建当作覆盖授权。版本是公司内容版本，不是桌面软件版本，可从 current 的版本递增选取；历史版本不可复用。

## 校验、预览和发布

```sh
node TOOL check /private/work/content
node TOOL plan /private/work/content --out /private/work/new-plan.json
```

`plan` 只读取服务端，不写入公司目录；保留无关专家与技能，输出新增、修改、移除和未变化文件数、基线版本及 confirmation。计划包含完整候选内容，存于私有目录，不提交 Git或贴到对话；不存在凭据。结合用户要求检查差异，特别是技能旧资源移除项。

明确下架时追加 `--remove skills/orders` 或 `--remove experts/operations/orders.md`。删除资源使用仅含新版本 release.json 的目录；不支持通配符或单独删除 SKILL.md。空目录不会自动清空全公司内容。

已有发布授权且差异与请求一致后，使用这次 plan 输出的完整摘要：

```sh
node TOOL publish /private/work/new-plan.json --confirm <confirmation>
```

发布前再次比对服务端版本与哈希，使用 expectedVersion 条件写入；摘要校验阻止计划内容被替换。发布后重新读取生效版本，只有版本与哈希一致才报告成功。任务结束清理本次临时导出与计划，不删除用户的源码。

## 冲突与结果

- PUBLICATION_CONFLICT：别人先发布了内容，没有覆盖。重新生成计划、检查新增差异；涉及同一资源时重新导出并合并。最多自动重新规划一次，再次冲突则停止并说明，不能循环发布。
- EDIT_CONFLICT：本次编辑基于的资源已变化，保留编辑文件；重新导出比较后合并，不能直接换摘要。
- REQUEST_UNCONFIRMED：写入可能已成功，工具只读取核实、不重试写入。使用 current 查询；当前版本和哈希等于计划才算已生效，其他结果不能宣称失败回滚或重新发布。
- VERSION_NOT_CURRENT：回执不能证明当前生效，不重新激活旧版本；查询并说明实际状态。
- PUBLICATION_DENIED：停止需要此权限的操作，报告配置或权限问题，不借用员工令牌、其他服务凭据或浏览器会话。

交付说明内容版本、改动资源和服务端核实结果。员工打开专家套件或技能页面后自动同步，成功检查间隔默认 60 秒；现有会话继续使用原固定版本，新会话使用更新后的内容。不要声称所有设备已同步，除非有相应设备证据。
