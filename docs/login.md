# 登录与会话

小胤桌面端使用钉钉官方 OAuth 登录。启动时服务端生成一次性授权状态，桌面端打开钉钉官方授权页面；如果本机钉钉已经登录，钉钉直接返回授权结果，不显示小胤二维码。服务端回调向钉钉确认员工身份并签发带过期时间的随机不透明会话令牌。桌面端只保存小胤会话，不保存钉钉密码或 ERP Cookie。

## 请求链路

1. 桌面端请求 `POST /api/v1/dingtalk-auth/authorization-requests` 获取一次性 state 和钉钉授权地址。
2. 桌面端通过系统打开官方授权地址，不创建内嵌窗口、不展示二维码。
3. 钉钉回调 `GET /api/v1/dingtalk-auth/callback`，服务端用授权码向钉钉确认员工身份并暂存一次性结果。
4. 桌面端轮询 `GET /api/v1/dingtalk-auth/authorization-requests/{state}`，取得 `sessionToken`、有效期和员工身份。
5. 后续控制中心请求使用 `Authorization: Bearer <sessionToken>`，同时携带 `X-Xiaoyin-Employee-Id`；所有非 GET/HEAD 请求还必须携带 `X-Requested-With: XMLHttpRequest`。

服务端只信任 Bearer 会话解析出的员工身份，不信任客户端注入的员工、用户或团队身份头。管理端额外校验服务端配置的管理员白名单。生产配置必须关闭 `allow-local-development`。

## 会话状态

| 状态 | 行为 |
| --- | --- |
| 没有会话 | 主窗口自动打开钉钉官方授权页面，已登录钉钉的账号直接确认 |
| 会话过期、401 或 403 | 清除本地会话并重新打开钉钉官方授权 |
| 身份服务超时或 5xx | 在短暂有效的已验证缓存期内保留工作台，随后暂停需要身份的操作 |
| 员工身份不一致 | 拒绝请求，不回退到客户端身份头或匿名身份 |
| 授权页面或回调异常 | 主窗口保留错误状态，用户可重新打开钉钉授权 |

登录、退出和身份切换都会使旧 Harness、IM 和本地命令会话失效。原生命令在读写任务、记忆、连接器凭据、文件和扩展前重新核对当前员工。

## 本地开发

浏览器预览使用固定的 `local-development` 身份。桌面开发可在未提交的 `.env.local` 中设置 `VITE_SKIP_DINGTALK_LOGIN=true`；仅本地开发构建接受该设置，正式构建始终走钉钉登录。

本地验收使用独立的应用标识和数据目录。需要验证真实会话时，使用服务端签发的随机会话令牌，不要注入 ERP Cookie、Cookie 文件或身份请求头。生产环境的 `DINGTALK_CALLBACK_URL` 必须配置为外部可访问的 `/api/v1/dingtalk-auth/callback` 地址，并加入钉钉应用的登录回调白名单。

## 连接器认证

连接器使用 OAuth、员工 Bearer Token、服务端托管凭据或无认证模式。旧的 `erp-cookie` 连接器认证会被桌面端拒绝，不再读取或转发 ERP Cookie；连接器需要 ERP 数据时，应通过服务端托管的 `erp-mcp` 连接器访问。

## 诊断

登录诊断保存在系统日志目录的 `dingtalk-session.json`，仅记录时间、运行标识、版本、系统、架构、构建类型、HTTP 状态和诊断码，不记录 Token、授权码、Cookie、账号、URL 或响应正文。

- macOS：`~/Library/Logs/com.instudio.xiaoyin.desktop/dingtalk-session.json`
- Windows：`%LOCALAPPDATA%\com.instudio.xiaoyin.desktop\logs\dingtalk-session.json`

## 验收

执行 `pnpm typecheck`、`pnpm test -- --run`、`cargo check` 和 `node --test scripts/acceptance-auth.test.mjs`。真实验收需要在已登录钉钉的桌面环境完成一次自动授权、重启应用、退出登录和重新登录，确认全程不出现小胤二维码窗口，并确认员工身份、任务数据和本地权限按账号隔离。
