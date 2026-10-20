# 公司专家与技能

专家套件、技能是两个独立 Cordis 插件，源码固定在 `vendor/dsh-agency-agents`、`vendor/dsh-skills-manager`，随产品桌面预装。公司分支保留原生目录、技能发现、专家委派及个人内容管理，移除页面 GitHub、重复反馈与插件独立更新；插件代码随软件统一更新。社区内容仓库的同步仍用于更新内容，不是软件更新。

## 发布内容

公司内容维护在私有源码目录中，不放进公开桌面仓库。内容使用原生文件格式：

```text
release.json                       # {"version":"1.0.0"}
experts/operations/company-orders.md
skills/company-orders/SKILL.md
skills/company-orders/references/policy.md
```

专家 Markdown 和 `SKILL.md` 使用 `---` 分隔的 frontmatter，`name`、`description` 必须为非空单行字符串，正文不能为空。技能 `name` 与目录名一致。公司 ID 使用 `company-` 前缀；专家文件名在所有分类中唯一。专家分类来自实际目录，不受社区内置分类限制。资源只能是普通文件，不接受符号链接、路径穿越及跨平台冲突名称。每包最多 2,048 个文件、32 MiB 解码内容；入口说明最多 128 KiB。公司内容只包含说明及技能资源，不包含插件代码、员工令牌或连接器私密配置。

仓库构建完成后，在仓库根目录校验私有目录：

```sh
node apps/product-desktop/scripts/publish-company-content.mjs /path/to/private-content --check
```

使用受控环境配置 `COMPANY_CONTENT_SERVER_URL`（包含产品入口前缀）及 `COMPANY_CONTENT_PUBLISHER_TOKEN`，把 `--check` 改为 `--publish` 完成发布。服务端配置对应的 `deepseek-harness.company-content.publisher-token`；默认关闭机器发布。发布凭据只能读公司内容和发布新版本，不能调用员工、连接器或其他管理 API。不要把凭据放进命令参数、源码或流水线日志。

发布使用当前版本作为并发检查条件。同版本同哈希重复提交返回已有结果，不改变当前版本；内容变化必须使用新版本。发布中遇到版本冲突需重新读取当前版本并确认，不自动覆盖。清空公司目录也通过发布空的新版本完成。本期发布的是专家 Markdown 与技能目录，不包含专家团编排清单。

## 员工使用

钉钉登录后的启动准备读取服务端当前完整版本，校验 SHA-256，在主进程写入按员工隔离的不可变目录，再将目录交给原生插件。员工无需安装这两个插件；页面通过“公司”来源查看内容。专家仍按原生插件的启用、选择和委派方式使用，技能仍由原生 Skill Provider 发现和读取，连接器独立授权。

更新公司内容后，下一次 Host 启动读取新版本；运行中的 Host 保持原目录。同步失败会提示重试，取消不启动工作区；损坏缓存明确报错，不静默改用其他内容。旧目录保留，防止覆盖仍被使用的文件。退出账号后新 Host 使用新员工目录。员工令牌仅用于主进程访问产品服务端，不进入 Host 环境或内容目录。

## 维护与验证

第三方版本、来源提交和完整本地修改见 [vendor 清单](../../../vendor/README.md)。升级插件时对照 `upstream.json`，重新应用公司来源与 UI 修改，运行原插件测试、公司 Loader 测试、桌面构建和 `verify:upstream`。服务端必须先于新桌面部署 `/api/v1/company-content`；目录尚未发布时返回空内容，员工个人与社区内容不受影响。
