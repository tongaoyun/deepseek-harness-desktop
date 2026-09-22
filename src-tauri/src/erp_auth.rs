use crate::show_main_window;
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    env,
    net::IpAddr,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
mod diagnostics;
pub(crate) mod mcp;
mod persistence;
use diagnostics::{Code, Diagnostic};

// Serialize restoration, validation and logout so a late check cannot re-save a revoked session.
static SESSION_RESTORED: futures_util::lock::Mutex<bool> = futures_util::lock::Mutex::new(false);
static EMPLOYEE_CHECK: futures_util::lock::Mutex<()> = futures_util::lock::Mutex::new(());
static VERIFIED_EMPLOYEE: Mutex<Option<(u64, String, Instant)>> = Mutex::new(None);
static OFFLINE_EMPLOYEE: Mutex<Option<(u64, String, Instant)>> = Mutex::new(None);
static CONNECTOR_TOKEN: Mutex<Option<ConnectorToken>> = Mutex::new(None);
// The desktop session is renewed five minutes before its 30-minute expiry.
// Keep local commands on that verified session instead of putting ERP DNS on
// the critical path for every task or draft write.
const EMPLOYEE_CACHE_AGE: Duration = Duration::from_secs(30 * 60);
const OFFLINE_EMPLOYEE_CACHE_AGE: Duration = Duration::from_secs(30);
const CREDENTIAL_STORE_TIMEOUT: Duration = Duration::from_secs(2);

struct ConnectorToken {
    epoch: u64,
    employee_id: String,
    control_token: String,
    connector_token: String,
    expires_at: i64,
}

impl ConnectorToken {
    fn for_session(&self, employee_id: &str, access_token: &str, epoch: u64, now: i64) -> &str {
        if self.epoch == epoch
            && epoch.is_multiple_of(2)
            && self.employee_id == employee_id
            && self.control_token == access_token
            && now < self.expires_at
        {
            &self.connector_token
        } else {
            ""
        }
    }
}

pub(crate) fn connector_bearer_token(employee_id: &str, access_token: &str) -> String {
    let Ok(guard) = CONNECTOR_TOKEN.lock() else {
        return String::new();
    };
    let Ok(now) = SystemTime::now().duration_since(UNIX_EPOCH) else {
        return String::new();
    };
    guard
        .as_ref()
        .map_or("", |session| {
            session.for_session(
                employee_id,
                access_token,
                mcp::session_epoch(),
                now.as_secs() as i64,
            )
        })
        .to_string()
}

fn clear_connector_token() {
    if let Ok(mut guard) = CONNECTOR_TOKEN.lock() {
        *guard = None;
    }
    clear_offline_employee();
}

fn clear_offline_employee() {
    if let Ok(mut guard) = OFFLINE_EMPLOYEE.lock() {
        *guard = None;
    }
}

fn offline_identity_from_token(token: &ConnectorToken, epoch: u64, now: i64) -> Option<&str> {
    (epoch.is_multiple_of(2)
        && token.epoch == epoch
        && token.expires_at > now
        && !token.control_token.is_empty()
        && !token.connector_token.is_empty())
    .then_some(token.employee_id.as_str())
}

fn offline_employee(refresh: bool) -> Option<String> {
    let epoch = mcp::session_epoch();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs() as i64;
    let employee_id = {
        let token = CONNECTOR_TOKEN.lock().ok()?;
        offline_identity_from_token(token.as_ref()?, epoch, now)?.to_string()
    };
    let mut cache = OFFLINE_EMPLOYEE.lock().ok()?;
    if !refresh
        && !cache
            .as_ref()
            .is_some_and(|(cached_epoch, cached_id, checked_at)| {
                *cached_epoch == epoch
                    && cached_id == &employee_id
                    && checked_at.elapsed() < OFFLINE_EMPLOYEE_CACHE_AGE
            })
    {
        return None;
    }
    if refresh {
        *cache = Some((epoch, employee_id.clone(), Instant::now()));
    }
    Some(employee_id)
}

fn transient_session_error(diagnostic: &Diagnostic) -> bool {
    matches!(diagnostic.code, Code::NetworkError | Code::RequestTimeout)
        || matches!(
            diagnostic.code,
            Code::IdentityUnavailable | Code::ControlPlaneAuthFailed
        ) && diagnostic
            .http_status
            .is_none_or(|status| status == 429 || status >= 500)
}

fn remember_employee(session: Option<&ErpSessionStatus>) {
    if let Ok(mut verified) = VERIFIED_EMPLOYEE.lock() {
        let epoch = mcp::session_epoch();
        *verified = session.and_then(|status| {
            (status.authenticated && epoch.is_multiple_of(2))
                .then_some(status.user.as_ref())
                .flatten()
                .map(|user| (epoch, user.user_id.clone(), Instant::now()))
        });
    }
}

const ERP_LOGIN_URL: &str = "http://www.instudio.me:6206/eshop/manager/login.jsp";
const ERP_USER_URL: &str =
    "http://www.instudio.me:6206/erpMobile/erpMobile/pushController/getDbSysadmin";
const ERP_COOKIE_URL: &str = "http://www.instudio.me:6206/eshop/";
const ERP_DINGTALK_APP_ID: &str = "dingoa43wafbtpeg2czybj";
const ERP_DINGTALK_CALLBACK_URL: &str =
    "http://www.instudio.me:6206/eshop/login.do?method=qrcodelogin";
const DINGTALK_QR_LOGIN_URL: &str = "https://login.dingtalk.com/login/qrcode.htm";
const MAX_ERP_IDENTITY_BYTES: usize = 32 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
struct ErpUser {
    user_id: String,
    display_name: String,
    department: String,
    team_id: String,
    position: String,
    data_permission: String,
    company_id: String,
    company_name: String,
    role: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ErpIdentity {
    oper_id: String,
    oper: String,
    #[serde(default)]
    depart: String,
    group_company_id: Option<i64>,
    department_id: Option<i64>,
    #[serde(default)]
    data_permission: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ErpSessionStatus {
    authenticated: bool,
    access_token: String,
    expires_at: Option<i64>,
    user: Option<ErpUser>,
    login_url: String,
    diagnostic: Diagnostic,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ControlPlaneIdentity {
    employee_id: String,
    team_id: String,
}

#[derive(Deserialize)]
struct ControlPlaneEnvelope {
    success: bool,
    data: Option<ControlPlaneIdentity>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ErpQrLoginConfiguration {
    login_url: String,
}

fn setting(name: &str, fallback: &str) -> String {
    env::var(name).unwrap_or_else(|_| fallback.to_string())
}

fn erp_login_url() -> String {
    setting("XIAOYIN_ERP_LOGIN_URL", ERP_LOGIN_URL)
}

fn erp_user_url() -> String {
    setting("XIAOYIN_ERP_USER_URL", ERP_USER_URL)
}

fn erp_cookie_url() -> String {
    setting("XIAOYIN_ERP_COOKIE_URL", ERP_COOKIE_URL)
}

fn dingtalk_app_id() -> String {
    setting("XIAOYIN_ERP_DINGTALK_APP_ID", ERP_DINGTALK_APP_ID)
}

fn erp_dingtalk_auth_url() -> String {
    let callback_url = setting(
        "XIAOYIN_ERP_DINGTALK_CALLBACK_URL",
        ERP_DINGTALK_CALLBACK_URL,
    );
    format!(
        "https://oapi.dingtalk.com/connect/oauth2/sns_authorize?appid={}&response_type=code&scope=snsapi_login&state=STATE&redirect_uri={}",
        utf8_percent_encode(&dingtalk_app_id(), NON_ALPHANUMERIC),
        utf8_percent_encode(&callback_url, NON_ALPHANUMERIC),
    )
}

fn erp_dingtalk_qr_login_url() -> String {
    let goto = erp_dingtalk_auth_url();
    format!(
        "{}?goto={}&style={}",
        DINGTALK_QR_LOGIN_URL,
        utf8_percent_encode(&goto, NON_ALPHANUMERIC),
        utf8_percent_encode("border:none;background-color:#FFFFFF;", NON_ALPHANUMERIC),
    )
}

fn validated_login_tmp_code(value: &str) -> Result<&str, String> {
    if value.is_empty() || value.len() > 1024 || value.chars().any(char::is_control) {
        return Err("钉钉扫码凭据无效".to_string());
    }
    Ok(value)
}

#[tauri::command]
pub(crate) fn open_erp_login(app: tauri::AppHandle, focus: Option<bool>) -> Result<(), String> {
    let login_url = erp_login_window_url(&app)?;
    let window = app
        .get_webview_window("erp-login")
        .ok_or_else(|| "找不到 ERP 扫码窗口".to_string())?;
    if window.url().ok().as_ref() == Some(&login_url) {
        window
            .reload()
            .map_err(|error| format!("无法刷新 ERP 扫码页面：{error}"))?;
    } else {
        window
            .navigate(login_url)
            .map_err(|error| format!("无法重置 ERP 扫码页面：{error}"))?;
    }
    window.show().map_err(|error| error.to_string())?;
    if focus.unwrap_or(true) {
        window.set_focus().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn erp_login_window_url(app: &tauri::AppHandle) -> Result<tauri::Url, String> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到小胤工作台".to_string())?;
    main.url()
        .map(login_window_url_from_main_url)
        .map_err(|error| format!("无法确定 ERP 扫码页面：{error}"))
}

fn login_window_url_from_main_url(mut url: tauri::Url) -> tauri::Url {
    url.set_query(Some("window=erp-login"));
    url.set_fragment(None);
    url
}

#[tauri::command]
pub(crate) fn erp_qr_login_configuration() -> ErpQrLoginConfiguration {
    ErpQrLoginConfiguration {
        login_url: erp_dingtalk_qr_login_url(),
    }
}

#[tauri::command]
pub(crate) fn complete_erp_qr_login(
    app: tauri::AppHandle,
    login_tmp_code: String,
) -> Result<(), String> {
    let login_tmp_code = validated_login_tmp_code(&login_tmp_code)?;
    remember_employee(None);
    clear_connector_token();
    let target = format!(
        "{}&loginTmpCode={}",
        erp_dingtalk_auth_url(),
        utf8_percent_encode(login_tmp_code, NON_ALPHANUMERIC),
    );
    let url = target
        .parse()
        .map_err(|error| format!("钉钉授权地址无效：{error}"))?;
    let window = app
        .get_webview_window("erp-login")
        .ok_or_else(|| "找不到 ERP 扫码窗口".to_string())?;
    window
        .navigate(url)
        .map_err(|error| format!("无法完成 ERP 授权：{error}"))?;
    let _ = app.emit_to("main", "erp-login-progress", "authorizing");
    show_main_window(&app);
    window
        .hide()
        .map_err(|error| format!("无法收起 ERP 扫码窗口：{error}"))
}

#[tauri::command]
pub(crate) async fn erp_session(app: tauri::AppHandle) -> Result<ErpSessionStatus, Diagnostic> {
    let control_plane_url = option_env!("VITE_XIAOYIN_SERVER_URL")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| Diagnostic::new(Code::ConfigurationInvalid, None, None))?;
    // Session checks also run from the background expiry/visibility timers.
    // They must not bring Xiaoyin to the foreground when a renewal succeeds;
    // the explicit QR completion flow is responsible for returning focus to
    // the app after a user-initiated login.
    let result = resolve_session(&app, false, Some(control_plane_url)).await;
    remember_employee(result.as_ref().ok());
    if !result.as_ref().err().is_some_and(transient_session_error) {
        clear_offline_employee();
    }
    let diagnostic = match &result {
        Ok(session) => &session.diagnostic,
        Err(diagnostic) => diagnostic,
    };
    if let Ok(directory) = app.path().app_log_dir() {
        let path = directory.join("erp-session.json");
        let diagnostic = diagnostic.clone();
        let _ =
            tauri::async_runtime::spawn_blocking(move || diagnostics::record(&path, &diagnostic))
                .await;
    }
    result
}

pub(crate) async fn require_employee(
    app: &tauri::AppHandle,
    employee_id: &str,
) -> Result<(), String> {
    employee_matches(&current_employee(app).await?, employee_id)
}

pub(crate) async fn current_employee(app: &tauri::AppHandle) -> Result<String, String> {
    if local_development_identity(
        &app.config().identifier,
        std::env::var("XIAOYIN_LOCAL_DEV_WEBVIEW_ISOLATION")
            .ok()
            .as_deref(),
    ) {
        return Ok("local-development".to_string());
    }
    let _guard = EMPLOYEE_CHECK.lock().await;
    if let Ok(verified) = VERIFIED_EMPLOYEE.lock()
        && let Some(user_id) = cached_employee(verified.as_ref(), mcp::session_epoch())
    {
        return Ok(user_id.to_string());
    }
    if let Some(employee_id) = offline_employee(false) {
        return Ok(employee_id);
    }
    let session = match resolve_session(app, false, None).await {
        Ok(session) => session,
        Err(diagnostic) => {
            if transient_session_error(&diagnostic)
                && let Some(employee_id) = offline_employee(true)
            {
                return Ok(employee_id);
            }
            clear_offline_employee();
            return Err("无法核实当前登录账号，请重试".to_string());
        }
    };
    clear_offline_employee();
    if mcp::session_epoch() % 2 == 1 {
        return Err("当前登录账号已失效".to_string());
    }
    remember_employee(Some(&session));
    let user_id = session
        .user
        .as_ref()
        .filter(|_| session.authenticated)
        .map_or("", |user| &user.user_id);
    if user_id.is_empty() {
        return Err("当前登录账号已失效".to_string());
    }
    Ok(user_id.to_string())
}

fn cached_employee(verified: Option<&(u64, String, Instant)>, session_epoch: u64) -> Option<&str> {
    let (epoch, user_id, checked_at) = verified?;
    (*epoch == session_epoch
        && epoch.is_multiple_of(2)
        && checked_at.elapsed() < EMPLOYEE_CACHE_AGE)
        .then_some(user_id.as_str())
}

fn local_development_identity(identifier: &str, isolation: Option<&str>) -> bool {
    cfg!(debug_assertions)
        && identifier == "com.instudio.xiaoyin.desktop.local-test"
        && isolation == Some("true")
        && env::var("XIAOYIN_LOCAL_DEV_REAL_SESSION").ok().as_deref() != Some("true")
}

fn employee_matches(actual: &str, requested: &str) -> Result<(), String> {
    if !actual.is_empty() && actual == requested {
        Ok(())
    } else {
        Err("当前登录账号与请求的员工不一致".into())
    }
}

async fn resolve_session(
    app: &tauri::AppHandle,
    show_window: bool,
    control_plane_url: Option<&str>,
) -> Result<ErpSessionStatus, Diagnostic> {
    let mut restored = SESSION_RESTORED.lock().await;
    let session_epoch = mcp::session_epoch();
    let webview = app
        .get_webview_window("erp-login")
        .or_else(|| app.get_webview_window("main"))
        .ok_or_else(|| Diagnostic::new(Code::CookieReadFailed, None, None))?;
    let cookie_url = erp_cookie_url()
        .parse()
        .map_err(|_| Diagnostic::new(Code::ConfigurationInvalid, None, None))?;
    let restore = !*restored;
    let saved_cookies = if restore {
        let store = session_store(app)?;
        match tokio::time::timeout(
            CREDENTIAL_STORE_TIMEOUT,
            tauri::async_runtime::spawn_blocking(move || store.load()),
        )
        .await
        {
            Ok(result) => result
                .map_err(|_| Diagnostic::new(Code::CookieStoreFailed, None, None))?
                .map_err(|_| Diagnostic::new(Code::CookieStoreFailed, None, None))?,
            // A rebuilt development app can lose access to its previous
            // Keychain ACL. Existing WebView cookies remain authoritative for
            // the current login and must not leave the whole UI checking forever.
            Err(_) => Vec::new(),
        }
    } else {
        Vec::new()
    };
    let cookies = tauri::async_runtime::spawn_blocking(move || {
        for cookie in saved_cookies {
            webview
                .set_cookie(cookie)
                .map_err(|_| Code::CookieReadFailed)?;
        }
        webview
            .cookies_for_url(cookie_url)
            .map_err(|_| Code::CookieReadFailed)
    })
    .await
    .map_err(|_| Diagnostic::new(Code::CookieReadFailed, None, None))?
    .map_err(|code| Diagnostic::new(code, None, None))?;
    *restored = true;
    let cookie_header = cookies
        .iter()
        .filter(|cookie| cookie.name() == "SESSION")
        .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
        .collect::<Vec<_>>()
        .join("; ");

    if cookie_header.is_empty() {
        clear_connector_token();
        mcp::revoke_session();
        return Ok(unauthenticated_erp_session(Diagnostic::new(
            Code::CookieMissing,
            Some(0),
            None,
        )));
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| Diagnostic::new(Code::ConfigurationInvalid, Some(cookies.len()), None))?;
    let (user, diagnostic) =
        resolve_identity(&client, &erp_user_url(), &cookie_header, cookies.len()).await?;
    let Some(user) = user else {
        clear_connector_token();
        mcp::revoke_session();
        clear_saved_session(app).await?;
        return Ok(unauthenticated_erp_session(diagnostic));
    };
    if session_epoch != mcp::session_epoch() {
        return Ok(unauthenticated_erp_session(Diagnostic::new(
            Code::SessionRejected,
            None,
            None,
        )));
    }
    let control_plane_identity = match control_plane_url {
        Some(url) => Some(
            verify_control_plane_identity(
                &client,
                url,
                &cookie_header,
                &user.user_id,
                &user.team_id,
            )
            .await
            .map_err(|status| {
                Diagnostic::new(Code::ControlPlaneAuthFailed, Some(cookies.len()), status)
            })?,
        ),
        None => None,
    };
    if session_epoch != mcp::session_epoch() {
        return Ok(unauthenticated_erp_session(Diagnostic::new(
            Code::SessionRejected,
            None,
            None,
        )));
    }
    let store = session_store(app)?;
    if let Ok(result) = tokio::time::timeout(
        CREDENTIAL_STORE_TIMEOUT,
        tauri::async_runtime::spawn_blocking(move || store.save(&cookies)),
    )
    .await
    {
        result
            .map_err(|_| Diagnostic::new(Code::CookieStoreFailed, None, None))?
            .map_err(|_| Diagnostic::new(Code::CookieStoreFailed, None, None))?;
    }
    let access_token = cookie_header
        .strip_prefix("SESSION=")
        .unwrap_or_default()
        .to_string();
    let expires_at = trusted_session_expiry();
    mcp::activate_session(session_epoch);
    if let Ok(mut guard) = CONNECTOR_TOKEN.lock() {
        if control_plane_identity.is_some() {
            *guard = Some(ConnectorToken {
                epoch: mcp::session_epoch(),
                employee_id: user.user_id.clone(),
                control_token: access_token.clone(),
                connector_token: trusted_internal_token(&cookie_header),
                expires_at: expires_at.unwrap_or_default(),
            });
        } else if guard.as_ref().is_some_and(|old| {
            old.employee_id != user.user_id
                || old.connector_token != trusted_internal_token(&cookie_header)
        }) {
            *guard = None;
        }
    }
    if show_window {
        if let Some(window) = app.get_webview_window("erp-login") {
            let _ = window.hide();
            if let Ok(url) = erp_login_window_url(app) {
                let _ = window.navigate(url);
            }
        }
        show_main_window(app);
    }
    Ok(ErpSessionStatus {
        authenticated: true,
        access_token,
        expires_at,
        user: Some(user),
        login_url: erp_login_url(),
        diagnostic,
    })
}

async fn verify_control_plane_identity(
    client: &reqwest::Client,
    base_url: &str,
    cookie_header: &str,
    expected_employee_id: &str,
    expected_team_id: &str,
) -> Result<ControlPlaneIdentity, Option<u16>> {
    let mut url = reqwest::Url::parse(base_url).map_err(|_| None)?;
    if !control_plane_transport_allowed(&url)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(None);
    }
    url.set_path("/api/v1/employee-auth/identity");
    url.set_query(None);
    url.set_fragment(None);
    let mut response = client
        .get(url)
        .header("Accept", "application/json")
        .header(
            "X-ERP-Session",
            cookie_header.strip_prefix("SESSION=").ok_or(None)?,
        )
        .send()
        .await
        .map_err(|_| None)?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(Some(status));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Some(status))? {
        if body.len().saturating_add(chunk.len()) > MAX_ERP_IDENTITY_BYTES {
            return Err(Some(status));
        }
        body.extend_from_slice(&chunk);
    }
    let envelope: ControlPlaneEnvelope = serde_json::from_slice(&body).map_err(|_| Some(status))?;
    let session = envelope
        .data
        .filter(|_| envelope.success)
        .ok_or(Some(status))?;
    if session.employee_id != expected_employee_id || session.team_id != expected_team_id {
        return Err(Some(status));
    }
    Ok(session)
}

fn control_plane_transport_allowed(url: &reqwest::Url) -> bool {
    if url.scheme() == "https" {
        return true;
    }
    if url.scheme() != "http" {
        return false;
    }
    match url.host_str() {
        Some("localhost") => true,
        Some(host) => host.parse::<IpAddr>().is_ok_and(|address| match address {
            IpAddr::V4(address) => address.is_private() || address.is_loopback(),
            IpAddr::V6(address) => address.is_unique_local() || address.is_loopback(),
        }),
        None => false,
    }
}

async fn resolve_identity(
    client: &reqwest::Client,
    url: &str,
    cookie_header: &str,
    cookie_count: usize,
) -> Result<(Option<ErpUser>, Diagnostic), Diagnostic> {
    let failure = |code, status| Diagnostic::new(code, Some(cookie_count), status);
    let mut response = client
        .get(url)
        .header("Accept", "application/json")
        .header("X-Requested-With", "XMLHttpRequest")
        .header("Cookie", cookie_header)
        .send()
        .await
        .map_err(|error| {
            failure(
                if error.is_timeout() {
                    Code::RequestTimeout
                } else if error.is_builder() {
                    Code::ConfigurationInvalid
                } else {
                    Code::NetworkError
                },
                None,
            )
        })?;
    let status = response.status().as_u16();
    match status {
        401 => return Ok((None, failure(Code::SessionRejected, Some(status)))),
        403 => return Err(failure(Code::AccessDenied, Some(status))),
        200 => {}
        _ => return Err(failure(Code::IdentityUnavailable, Some(status))),
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        failure(
            if error.is_timeout() {
                Code::RequestTimeout
            } else {
                Code::IdentityInvalid
            },
            Some(status),
        )
    })? {
        if body.len().saturating_add(chunk.len()) > MAX_ERP_IDENTITY_BYTES {
            return Err(failure(Code::IdentityInvalid, Some(status)));
        }
        body.extend_from_slice(&chunk);
    }
    let value: serde_json::Value =
        serde_json::from_slice(&body).map_err(|_| failure(Code::IdentityInvalid, Some(status)))?;
    if value.get("code").and_then(serde_json::Value::as_i64) == Some(601) {
        return Ok((None, failure(Code::SessionRejected, Some(status))));
    }
    let identity: ErpIdentity =
        serde_json::from_value(value).map_err(|_| failure(Code::IdentityInvalid, Some(status)))?;
    let user = erp_user_from_identity(&identity)
        .map_err(|_| failure(Code::IdentityInvalid, Some(status)))?;
    Ok((Some(user), failure(Code::Authenticated, Some(status))))
}

fn unauthenticated_erp_session(diagnostic: Diagnostic) -> ErpSessionStatus {
    ErpSessionStatus {
        authenticated: false,
        access_token: String::new(),
        expires_at: None,
        user: None,
        login_url: erp_login_url(),
        diagnostic,
    }
}

fn erp_user_from_identity(identity: &ErpIdentity) -> Result<ErpUser, String> {
    if identity.oper_id.trim().is_empty() || identity.oper.trim().is_empty() {
        return Err("ERP 身份响应缺少员工信息".to_string());
    }
    let company_id = identity
        .group_company_id
        .map(|value| value.to_string())
        .unwrap_or_else(|| "internal".to_string());
    let team_id = identity
        .department_id
        .map(|value| value.to_string())
        .unwrap_or_default();
    Ok(ErpUser {
        user_id: identity.oper_id.clone(),
        display_name: identity.oper.clone(),
        department: identity.depart.clone(),
        team_id,
        position: identity
            .department_id
            .map(|value| value.to_string())
            .unwrap_or_default(),
        data_permission: identity.data_permission.clone(),
        company_id,
        company_name: "企业内部版".to_string(),
        role: if identity.depart.contains("总经办") {
            "admin".to_string()
        } else {
            "operator".to_string()
        },
    })
}

fn cookie_digest(cookie_header: &str) -> String {
    format!("{:x}", Sha256::digest(cookie_header.as_bytes()))
}

fn trusted_internal_token(cookie_header: &str) -> String {
    format!("internal-trust:{}", cookie_digest(cookie_header))
}

fn trusted_session_expiry() -> Option<i64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|value| value.as_secs() as i64 + 30 * 60)
}

#[tauri::command]
pub(crate) async fn clear_erp_session(app: tauri::AppHandle) -> Result<(), String> {
    remember_employee(None);
    clear_connector_token();
    mcp::revoke_session();
    crate::schedule_desktop::stop_keep_awake();
    let mut restored = SESSION_RESTORED.lock().await;
    *restored = true;
    clear_saved_session(&app)
        .await
        .map_err(|_| "无法清除系统凭据库中的 ERP 登录记录".to_string())?;
    let webview = app
        .get_webview_window("erp-login")
        .or_else(|| app.get_webview_window("main"))
        .ok_or_else(|| "找不到桌面 WebView".to_string())?;
    let cookie_url = erp_cookie_url()
        .parse()
        .map_err(|error| format!("ERP Cookie 地址无效：{error}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        for cookie in webview.cookies_for_url(cookie_url)? {
            webview.delete_cookie(cookie)?;
        }
        Ok::<(), tauri::Error>(())
    })
    .await
    .map_err(|error| format!("清除 ERP 登录状态失败：{error}"))?
    .map_err(|error| format!("清除 ERP Cookie 失败：{error}"))
}

fn session_store(app: &tauri::AppHandle) -> Result<persistence::SessionStore, Diagnostic> {
    let identifier = if cfg!(debug_assertions)
        && app.config().identifier == "com.instudio.xiaoyin.desktop.local-test"
        && env::var("XIAOYIN_LOCAL_DEV_REAL_SESSION").ok().as_deref() == Some("true")
    {
        // The acceptance app keeps its task data isolated but deliberately reuses the
        // production app's OS credential entry when real-session mode is requested.
        "com.instudio.xiaoyin.desktop"
    } else {
        &app.config().identifier
    };
    persistence::SessionStore::new(identifier, &erp_cookie_url(), &erp_user_url())
        .map_err(|_| Diagnostic::new(Code::CookieStoreFailed, None, None))
}

async fn clear_saved_session(app: &tauri::AppHandle) -> Result<(), Diagnostic> {
    let store = session_store(app)?;
    tauri::async_runtime::spawn_blocking(move || store.clear())
        .await
        .map_err(|_| Diagnostic::new(Code::CookieStoreFailed, None, None))?
        .map_err(|_| Diagnostic::new(Code::CookieStoreFailed, None, None))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_dev_identity_requires_the_isolated_debug_application() {
        assert_eq!(
            local_development_identity("com.instudio.xiaoyin.desktop.local-test", Some("true")),
            cfg!(debug_assertions)
        );
        assert!(!local_development_identity(
            "com.instudio.xiaoyin.desktop",
            Some("true")
        ));
        assert!(!local_development_identity(
            "com.instudio.xiaoyin.desktop.local-test",
            None
        ));
    }

    #[test]
    fn offline_identity_requires_a_live_verified_session_and_transient_failure() {
        let token = ConnectorToken {
            epoch: 2,
            employee_id: "employee-1".into(),
            control_token: "signed-session".into(),
            connector_token: "internal-trust:cookie-digest".into(),
            expires_at: 100,
        };
        assert_eq!(
            offline_identity_from_token(&token, 2, 99),
            Some("employee-1")
        );
        assert_eq!(offline_identity_from_token(&token, 4, 99), None);
        assert_eq!(offline_identity_from_token(&token, 2, 100), None);
        assert!(transient_session_error(&Diagnostic::new(
            Code::NetworkError,
            None,
            None
        )));
        assert!(transient_session_error(&Diagnostic::new(
            Code::IdentityUnavailable,
            None,
            Some(503)
        )));
        assert!(!transient_session_error(&Diagnostic::new(
            Code::AccessDenied,
            None,
            Some(403)
        )));
        assert!(!transient_session_error(&Diagnostic::new(
            Code::ControlPlaneAuthFailed,
            None,
            Some(401)
        )));
    }

    #[test]
    fn verified_employee_cache_matches_the_desktop_session_lifetime() {
        let current = (2, "employee-1".to_string(), Instant::now());
        assert_eq!(cached_employee(Some(&current), 2), Some("employee-1"));
        assert_eq!(cached_employee(Some(&current), 4), None);

        let revoked = (3, "employee-1".to_string(), Instant::now());
        assert_eq!(cached_employee(Some(&revoked), 3), None);

        let expired = (
            2,
            "employee-1".to_string(),
            Instant::now() - EMPLOYEE_CACHE_AGE - Duration::from_secs(1),
        );
        assert_eq!(cached_employee(Some(&expired), 2), None);
    }

    #[test]
    fn connector_token_cannot_be_used_as_a_control_plane_token_or_by_another_session() {
        let token = ConnectorToken {
            epoch: 2,
            employee_id: "employee-1".into(),
            control_token: "control-plane-token".into(),
            connector_token: "internal-trust:cookie-digest".into(),
            expires_at: 100,
        };
        assert_eq!(
            token.for_session("employee-1", "control-plane-token", 2, 99),
            "internal-trust:cookie-digest"
        );
        assert_eq!(
            token.for_session("employee-2", "control-plane-token", 2, 99),
            ""
        );
        assert_eq!(
            token.for_session("employee-1", "old-control-token", 2, 99),
            ""
        );
        assert_eq!(
            token.for_session("employee-1", "control-plane-token", 3, 99),
            ""
        );
        assert_eq!(
            token.for_session("employee-1", "control-plane-token", 2, 100),
            ""
        );
    }

    #[test]
    fn expired_erp_session_in_http_200_requires_login() {
        let (user, diagnostic) = identity_response(
            200,
            r#"{"success":false,"code":601,"desc":"not logged in"}"#,
        )
        .unwrap();
        assert!(user.is_none());
        assert_eq!(diagnostic.code, Code::SessionRejected);
    }

    #[test]
    fn control_plane_verifies_identity_without_issuing_tokens() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let valid = r#"{"success":true,"data":{"employeeId":"employee-1","teamId":"21","employeeName":"Test Employee"}}"#.to_string();
            let oversized = format!(
                "{{\"success\":true,\"padding\":\"{}\"}}",
                "x".repeat(MAX_ERP_IDENTITY_BYTES)
            );
            for (index, body) in [valid, oversized].into_iter().enumerate() {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 1024];
                loop {
                    let length = stream.read(&mut buffer).unwrap();
                    assert!(length > 0);
                    request.extend_from_slice(&buffer[..length]);
                    if request
                        .windows("x-erp-session: fixture".len())
                        .any(|part| part == b"x-erp-session: fixture")
                    {
                        break;
                    }
                }
                let request = String::from_utf8(request).unwrap();
                assert!(request.starts_with("GET /api/v1/employee-auth/identity HTTP/1.1"));
                let result = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                if index == 0 {
                    result.unwrap();
                }
            }
        });
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        let session = tauri::async_runtime::block_on(verify_control_plane_identity(
            &client,
            &endpoint,
            "SESSION=fixture",
            "employee-1",
            "21",
        ))
        .unwrap();
        assert_eq!(session.employee_id, "employee-1");
        assert_eq!(
            tauri::async_runtime::block_on(verify_control_plane_identity(
                &client,
                &endpoint,
                "SESSION=fixture",
                "employee-1",
                "21",
            ))
            .err(),
            Some(Some(200))
        );
        server.join().unwrap();
        assert!(control_plane_transport_allowed(
            &reqwest::Url::parse("http://192.168.2.67:30081").unwrap()
        ));
        assert!(control_plane_transport_allowed(
            &reqwest::Url::parse("http://10.20.30.40:8080").unwrap()
        ));
        assert!(!control_plane_transport_allowed(
            &reqwest::Url::parse("http://xiaoyin.example.com").unwrap()
        ));
        assert!(
            tauri::async_runtime::block_on(verify_control_plane_identity(
                &client,
                "http://xiaoyin.example.com",
                "SESSION=fixture",
                "employee-1",
                "21",
            ))
            .is_err()
        );
    }

    fn identity_response(
        status: u16,
        body: &str,
    ) -> Result<(Option<ErpUser>, Diagnostic), Diagnostic> {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/auth/user", listener.local_addr().unwrap());
        let body = body.to_string();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let length = stream.read(&mut buffer).unwrap();
                assert!(length > 0);
                request.extend_from_slice(&buffer[..length]);
            }
            write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        });
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let result = tauri::async_runtime::block_on(resolve_identity(
            &client,
            &url,
            "SESSION=private-cookie",
            1,
        ));
        server.join().unwrap();
        result
    }

    #[test]
    fn only_an_explicit_unauthorized_response_requires_login() {
        let (user, diagnostic) =
            identity_response(401, "{\"message\":\"private-cookie\"}").unwrap();
        assert!(user.is_none());
        assert_eq!(diagnostic.code, Code::SessionRejected);
        for (status, expected) in [
            (403, Code::AccessDenied),
            (302, Code::IdentityUnavailable),
            (404, Code::IdentityUnavailable),
            (429, Code::IdentityUnavailable),
            (500, Code::IdentityUnavailable),
            (503, Code::IdentityUnavailable),
        ] {
            let failure = identity_response(status, "private-cookie").err().unwrap();
            assert_eq!(failure.code, expected);
            assert_eq!(failure.http_status, Some(status));
            let report = serde_json::to_string(&failure).unwrap();
            assert!(!report.contains("private-cookie"));
            assert!(!report.contains("127.0.0.1"));
        }
    }

    #[test]
    fn identity_must_contain_a_real_employee() {
        for body in [
            "{}",
            "<html>Login</html>",
            r#"{"operId":"","oper":"Employee"}"#,
        ] {
            assert_eq!(
                identity_response(200, body).err().unwrap().code,
                Code::IdentityInvalid
            );
        }
        let (user, diagnostic) =
            identity_response(200, r#"{"operId":"1001","oper":"Employee"}"#).unwrap();
        assert_eq!(user.unwrap().user_id, "1001");
        assert_eq!(diagnostic.code, Code::Authenticated);
    }

    #[test]
    fn oversized_erp_identity_is_rejected_before_deserialization() {
        let body = format!(
            "{{\"operId\":\"1001\",\"oper\":\"Employee\",\"padding\":\"{}\"}}",
            "x".repeat(MAX_ERP_IDENTITY_BYTES)
        );
        let failure = identity_response(200, &body).err().unwrap();
        assert_eq!(failure.code, Code::IdentityInvalid);
        assert_eq!(failure.http_status, Some(200));
    }

    #[test]
    fn screenshot_identity_rejects_other_or_missing_employee() {
        assert!(employee_matches("employee-a", "employee-a").is_ok());
        assert!(employee_matches("employee-a", "employee-b").is_err());
        assert!(employee_matches("", "employee-a").is_err());
    }

    #[test]
    fn login_tmp_code_is_validated() {
        assert_eq!(validated_login_tmp_code("session-123"), Ok("session-123"));
        assert!(validated_login_tmp_code("").is_err());
        assert!(validated_login_tmp_code("session\n123").is_err());
        assert!(validated_login_tmp_code(&"a".repeat(1025)).is_err());
    }

    #[test]
    fn qr_login_uses_the_official_dingtalk_page() {
        let url = tauri::Url::parse(&erp_dingtalk_qr_login_url()).unwrap();
        assert_eq!(url.host_str(), Some("login.dingtalk.com"));
        assert_eq!(url.path(), "/login/qrcode.htm");
        let goto = url
            .query_pairs()
            .find_map(|(key, value)| (key == "goto").then(|| value.into_owned()))
            .unwrap();
        assert_eq!(goto, erp_dingtalk_auth_url());
    }

    #[test]
    fn login_window_url_always_returns_to_the_desktop_qr_page() {
        let url = login_window_url_from_main_url(
            "http://tauri.localhost/index.html?stale=1#erp"
                .parse()
                .unwrap(),
        );
        assert_eq!(
            url.as_str(),
            "http://tauri.localhost/index.html?window=erp-login"
        );
        assert!(erp_cookie_url().ends_with("/eshop/"));
        assert!(erp_user_url().ends_with("/erpMobile/erpMobile/pushController/getDbSysadmin"));
    }

    #[test]
    fn erp_identity_is_mapped_to_the_desktop_user() {
        let identity: ErpIdentity = serde_json::from_value(serde_json::json!({
            "operId": "1001",
            "oper": "测试员工",
            "depart": "跨境运营部",
            "groupCompanyId": 7,
            "departmentId": 21,
            "dataPermission": "department"
        }))
        .unwrap();
        let user = erp_user_from_identity(&identity).unwrap();
        assert_eq!(user.user_id, "1001");
        assert_eq!(user.display_name, "测试员工");
        assert_eq!(user.department, "跨境运营部");
        assert_eq!(user.team_id, "21");
        assert_eq!(user.company_id, "7");
        assert_eq!(user.role, "operator");
    }

    #[test]
    fn erp_identity_without_department_does_not_inherit_company_as_team() {
        let identity: ErpIdentity = serde_json::from_value(serde_json::json!({
            "operId": "1001", "oper": "Employee", "groupCompanyId": 7
        }))
        .unwrap();
        let user = erp_user_from_identity(&identity).unwrap();
        assert_eq!(user.company_id, "7");
        assert!(user.team_id.is_empty());

        let identity: ErpIdentity = serde_json::from_value(serde_json::json!({
            "operId": "1002", "oper": "Employee"
        }))
        .unwrap();
        assert!(
            erp_user_from_identity(&identity)
                .unwrap()
                .team_id
                .is_empty()
        );
    }

    #[test]
    fn internal_trust_token_does_not_expose_the_cookie() {
        let cookie = "SESSION=secret-session";
        let token = trusted_internal_token(cookie);
        assert!(token.starts_with("internal-trust:"));
        assert!(!token.contains(cookie));
        assert_eq!(token, trusted_internal_token(cookie));
    }
}
