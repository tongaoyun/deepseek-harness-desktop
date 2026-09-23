# 登录与会话

桌面通过系统 WebView 完成钉钉扫码，以 ERP `/erpMobile/erpMobile/pushController/getDbSysadmin` 返回的员工身份进入工作台。验证成功的 Cookie 保存在系统凭据库，重启时恢复到 WebView 并重新校验身份，不导出到配置文件。应用不会用权限接口或 Cookie 摘要生成员工身份。

ERP 验证成功后，桌面原生层向构建时固定的控制中心地址查询身份，不签发小胤令牌。后续 Bootstrap、知识库、记忆、反馈、设备和扩展请求通过 `X-ERP-Session` 携带 ERP SESSION，通过 `X-Xiaoyin-Employee-Id` 携带员工 ID；服务端重新核验 ERP 身份，两者不一致即拒绝。员工姓名取自 ERP 的 `oper`，不通过客户端请求头传递。普通业务接口按员工身份授权，管理后台仅对服务端配置的管理员白名单开放。当前公司控制中心使用固定的 RFC1918 内网 HTTP 地址；正式构建拒绝其他公网 HTTP 地址。

Harness 将 ERP SESSION 仅用于知识库等小胤 API；`employee-bearer` MCP 连接器使用与当前 ERP 会话绑定的独立摘要令牌，不能拿它访问控制中心。连接器需要实际 ERP Cookie 时使用 `erp-cookie`，其他第三方凭据使用 OAuth。

## 状态处理

| 结果 | 行为 |
| --- | --- |
| 没有可用 Cookie | 主窗口提示登录，员工点击后打开扫码窗口 |
| 身份接口返回 401 或业务码 601 | 清除当前身份与保存的会话，重新扫码 |
| 身份接口返回 403 | 暂停访问，提示检查账号权限 |
| 网络失败、超时、服务异常 | 每 15 秒重试，有效期内保留已验证身份 |
| 身份响应缺少员工信息 | 提示身份异常，不生成替代账号 |
| 控制中心身份核验失败 | 暂停访问，不退回 Cookie 摘要或匿名身份 |
| 二维码窗口打开失败 | 提示重新打开，继续检查登录结果 |

应用刚启动时 WebView Cookie 可能比主窗口稍晚就绪。首次检查返回无 Cookie 时先保持“正在检查登录状态”，短暂复核一次；复核仍无 Cookie 时仅在主窗口展示登录页，不自动弹出扫码窗口。员工点击“打开二维码”后才显示独立扫码窗口。ERP 明确拒绝会话、员工手动重新检查以及已登录后的会话失效不使用该宽限。

验证身份后本机有效期为 30 分钟，提前 5 分钟重新校验；这不延长 ERP Cookie 的实际有效期。过期后尚未取得有效身份时暂停访问。窗口激活、网络恢复和休眠唤醒触发到期检查；退出后忽略先前请求的迟到结果。

原生命令读取或修改员工本地任务、记忆、连接器凭据、OAuth 授权与 Harness 会话前，会核实请求员工与当前登录身份一致；运行中的任务控制也核对槽位归属。ERP 临时网络/服务故障时，仅在本地已验证身份缓存尚未过期且登录轮次未变化的情况下短时沿用已验证身份；401、403、登出或会话过期不沿用。独立的 `tauri:dev:local` debug 应用仅允许固定的 `local-development` 测试身份，正式应用不接受该例外。

Tauri AppManifest 显式登记全部原生命令，并由窗口 Capability 分配调用权限。主工作台不能调用二维码回调命令；ERP 登录窗口只能关闭自身、读取二维码配置和提交钉钉临时码，不能访问进程、更新器、Harness、扩展、文件、连接器或本地数据命令。脚本测试要求 AppManifest、`generate_handler!` 与窗口权限清单保持完整一致，新增命令未声明权限时阻止质量检查通过。

本地文件目录授权随员工切换清空，默认工作目录按员工哈希隔离。原生文件预览、打开和撤销会重新核实当前员工；切换目录授权后，先前的 HTML 预览 URL 失效。

系统凭据库按应用和 ERP 地址隔离会话；连续 7 天未验证的记录不再恢复，Cookie 自身的到期时间仍有效。网络故障保留记录用于恢复连接后重试。退出登录清除保存的会话和 WebView Cookie，停止 Harness、IM 和系统唤醒保持，迟到的身份校验不能恢复已退出的账号。

## MCP 使用扫码会话

HTTP/SSE 连接器选择认证方式“ERP 扫码会话”，或在 JSON 中配置 `"authMode": "erp-cookie"`。不填写 Cookie、Authorization 请求头，也不需要手动复制 Cookie。

每次 MCP HTTP 请求前，桌面读取 WebView 的当前 Cookie 并通过 ERP 身份接口核实账号，再通过私有进程通信提供给指定连接器。Cookie 不写入连接器配置、任务记录或环境变量。账号与任务不一致时拒绝使用；退出登录立即撤销已有运行时的会话访问，重新登录后开启新任务。

默认只允许向 `XIAOYIN_ERP_COOKIE_URL` 的同源服务发送 Cookie。同源要求协议、主机和端口全部一致。其他服务在启动桌面前配置 `XIAOYIN_ERP_MCP_ALLOWED_ORIGINS`，填写逗号分隔的完整来源，例如 `http://192.168.2.66:8090,https://mcp.example.com`，不含路径或通配符。该设置在桌面本机生效，连接器发布不能自行增加受信任来源。

请求不跟随重定向，SSE 消息地址也必须与连接器地址同源。ERP 或 MCP 返回 401 时提示重新扫码；403 时检查受信任来源、任务账号和服务权限；网络故障时暂停本次请求，不使用缓存 Cookie 重试业务操作。STDIO 连接器不支持此认证方式。

## 诊断

`erp-session.json` 保存最近 32 条登录状态变化，同一进程的相同状态在 15 分钟内合并。记录时间、随机启动标识、版本、系统、架构、构建类型、Cookie 数量、HTTP 状态和诊断码，不记录 Cookie 名称或值、Token、账号、URL、响应正文及请求参数。

- macOS：`~/Library/Logs/com.instudio.xiaoyin.desktop/erp-session.json`
- Windows：`%LOCALAPPDATA%\com.instudio.xiaoyin.desktop\logs\erp-session.json`

升级验收分别检查安装前、安装后和重启后的记录。`cookie_missing` 表示 WebView 没有返回可用 Cookie；`session_rejected` 表示已有 Cookie 但 ERP 返回 401；`identity_unavailable` 表示身份接口异常。诊断只用于定位原因，不代替真实登录与升级验收。

## 验收

本地功能测试运行 `pnpm tauri:dev:local`，自动进入 `local-development` 开发会话，无须扫码。测试窗口与正常小胤使用不同的应用标识、应用数据目录和 WebView 数据存储；端口默认自动分配。需要验证重启持久化时，可用 `XIAOYIN_LOCAL_DEV_PORT=58151 pnpm tauri:dev:local` 固定页面来源。仅绑定本机的服务端开发组合允许此身份；该会话不生成 ERP Cookie，也不能代替真实业务授权。

免扫码只在开发构建生效。正常启动 `pnpm tauri:dev` 和正式安装包继续校验 ERP 身份。

macOS 运行 `node scripts/acceptance-erp-session.mjs`，使用独立应用标识和本机模拟 ERP 验证会话 Cookie 跨进程恢复、服务异常保留会话、退出清理与 401 清理；同时验证本机草稿 SQLite 写入、跨进程读取及员工隔离。该验收调用真实 WebView 和系统凭据库，不使用业务账号。

使用正式安装包完成登录、退出重启、升级、休眠唤醒与断网恢复。核对员工身份、原任务、目录授权和文件内容，确认退出登录后不会自动恢复。损坏响应、401、403、服务异常及迟到扫码事件由回归测试覆盖。
