# 登录与会话

桌面通过系统 WebView 完成钉钉扫码，以 ERP `/auth/user` 返回的员工身份进入工作台。ERP Cookie 保存在 WebView，不导出到配置文件。应用不会用权限接口或 Cookie 摘要生成员工身份。

## 状态处理

| 结果 | 行为 |
| --- | --- |
| 没有可用 Cookie | 打开扫码窗口 |
| 身份接口返回 401 | 清除当前内存身份，重新扫码 |
| 身份接口返回 403 | 暂停访问，提示检查账号权限 |
| 网络失败、超时、服务异常 | 每 15 秒重试，有效期内保留已验证身份 |
| 身份响应缺少员工信息 | 提示身份异常，不生成替代账号 |
| 二维码窗口打开失败 | 提示重新打开，继续检查登录结果 |

验证身份后本机有效期为 30 分钟，提前 5 分钟重新校验；这不延长 ERP Cookie 的实际有效期。过期后尚未取得有效身份时暂停访问。窗口激活、网络恢复和休眠唤醒触发到期检查；退出后忽略先前请求的迟到结果。

## 诊断

`erp-session.json` 保存最近 32 条登录状态变化，同一进程的相同状态在 15 分钟内合并。记录时间、随机启动标识、版本、系统、架构、构建类型、Cookie 数量、HTTP 状态和诊断码，不记录 Cookie 名称或值、Token、账号、URL、响应正文及请求参数。

- macOS：`~/Library/Logs/com.instudio.xiaoyin.desktop/erp-session.json`
- Windows：`%LOCALAPPDATA%\com.instudio.xiaoyin.desktop\logs\erp-session.json`

升级验收分别检查安装前、安装后和重启后的记录。`cookie_missing` 表示 WebView 没有返回可用 Cookie；`session_rejected` 表示已有 Cookie 但 ERP 返回 401；`identity_unavailable` 表示身份接口异常。诊断只用于定位原因，不代替真实登录与升级验收。

## 验收

使用正式安装包完成登录、退出重启、升级、休眠唤醒与断网恢复。核对员工身份、原任务、目录授权和文件内容，确认退出登录后不会自动恢复。损坏响应、401、403、服务异常及迟到扫码事件由回归测试覆盖。
