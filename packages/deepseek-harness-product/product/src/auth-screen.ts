/** Shared presentation for startup and in-workspace employee authorization. */
export const EMPLOYEE_AUTH_COPY = {
  zh: { title: '登录 DeepSeek Harness', connecting: '正在连接钉钉', hint: '请在系统浏览器中完成授权' },
  en: { title: 'Sign in to DeepSeek Harness', connecting: 'Connecting to DingTalk', hint: 'Complete authorization in your system browser' },
} as const

/** Shared root class for startup HTML and the native authorization Modal. */
export const EMPLOYEE_AUTH_CLASS_NAME = 'product-employee-authorization'

/** Scoped full-window layout; native dialogs retain keyboard and return-focus ownership. */
export const EMPLOYEE_AUTH_CSS = `
.product-employee-authorization,
.product-employee-authorization[role="dialog"] {
  box-sizing: border-box; position: fixed; inset: var(--dsh-frame-chrome-top, 0px) 0 0;
  display: grid; place-items: center; width: 100%; max-height: none; margin: 0; padding: 32px;
  overflow: auto; border: 0; border-radius: 0; box-shadow: none;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
  color: var(--dsw-alias-label-primary, #202124); background: var(--dsw-alias-bg-base, #fff);
}
.product-employee-authorization > main { width: min(100%, 420px); margin: auto; text-align: center; }
.product-employee-authorization h1 { margin: 0 0 10px; font-size: 22px; line-height: 30px; font-weight: 500; letter-spacing: 0; }
.product-employee-authorization p { margin: 0; font-size: 14px; line-height: 22px; letter-spacing: 0; color: var(--dsw-alias-label-secondary, #777); }
[data-product-auth-mark] { box-sizing: border-box; width: 42px; height: 42px; margin: 0 auto 24px; border: 3px solid #dfe5e1; border-top-color: #1f8f5f; border-radius: 50%; corner-shape: round; }
[data-product-auth-mark="pending"] { animation: productAuthSpin .8s linear infinite; }
[data-product-auth-actions] { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 24px; }
.product-employee-authorization [data-product-auth-error] { margin-top: 16px; color: var(--dsw-alias-state-error-primary, #b42318); }
[data-product-auth-error][aria-hidden="true"] { visibility: hidden; }
@media (prefers-color-scheme: dark) {
  .product-employee-authorization { color: var(--dsw-alias-label-primary, #f2f3f5); background: var(--dsw-alias-bg-base, #171817); }
  .product-employee-authorization p { color: var(--dsw-alias-label-secondary, #aaa); }
  [data-product-auth-mark] { border-color: #343936; border-top-color: #4bc58a; }
}
@media (prefers-reduced-motion: reduce) { [data-product-auth-mark="pending"] { animation: none; } }
@keyframes productAuthSpin { to { transform: rotate(360deg); } }
`
