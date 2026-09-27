use serde::{Deserialize, Serialize};
use std::{
    env,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
mod diagnostics;
pub(crate) mod mcp;
mod persistence;
use diagnostics::{Code, Diagnostic};
use persistence::{AccessTokenSnapshot, AccessTokenStore};

static EMPLOYEE_CHECK: futures_util::lock::Mutex<()> = futures_util::lock::Mutex::new(());
static VERIFIED_EMPLOYEE: Mutex<Option<(u64, String, Instant)>> = Mutex::new(None);
static OFFLINE_EMPLOYEE: Mutex<Option<(u64, String, Instant)>> = Mutex::new(None);
static CONNECTOR_TOKEN: Mutex<Option<ConnectorToken>> = Mutex::new(None);
const EMPLOYEE_CACHE_AGE: Duration = Duration::from_secs(30 * 60);
const OFFLINE_EMPLOYEE_CACHE_AGE: Duration = Duration::from_secs(30);
static PENDING_AUTHORIZATION: Mutex<Option<(String, Instant)>> = Mutex::new(None);

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
    if let Ok(mut guard) = OFFLINE_EMPLOYEE.lock() {
        *guard = None;
    }
}

fn offline_employee(refresh: bool) -> Option<String> {
    let epoch = mcp::session_epoch();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs() as i64;
    let employee_id = {
        let token = CONNECTOR_TOKEN.lock().ok()?;
        let token = token.as_ref()?;
        (epoch.is_multiple_of(2)
            && token.epoch == epoch
            && token.expires_at > now
            && !token.control_token.is_empty()
            && !token.connector_token.is_empty())
        .then(|| token.employee_id.clone())?
    };
    let mut cache = OFFLINE_EMPLOYEE.lock().ok()?;
    if !refresh
        && cache
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

fn remember_employee(session: Option<&DingTalkSessionStatus>) {
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

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
struct DingTalkUser {
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DingTalkSessionStatus {
    authenticated: bool,
    session_token: String,
    expires_at: Option<i64>,
    user: Option<DingTalkUser>,
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
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DingTalkRefreshEnvelope {
    success: bool,
    data: Option<DingTalkSessionData>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DingTalkConfigurationEnvelope {
    success: bool,
    data: Option<DingTalkConfigurationData>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DingTalkConfigurationData {
    authorization_url: String,
    state: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DingTalkAuthorizationPollEnvelope {
    success: bool,
    data: Option<DingTalkAuthorizationPollData>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DingTalkSessionData {
    #[serde(rename = "sessionToken")]
    session_token: String,
    expires_at: i64,
    employee: DingTalkEmployeeData,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DingTalkAuthorizationPollData {
    status: String,
    session: Option<DingTalkSessionData>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DingTalkEmployeeData {
    employee_id: String,
    team_id: String,
    employee_name: String,
}

fn control_plane_url() -> Result<String, String> {
    option_env!("VITE_XIAOYIN_SERVER_URL")
        .filter(|value| !value.is_empty())
        .map(|value| value.trim_end_matches('/').to_string())
        .ok_or_else(|| "小胤服务端地址未配置".to_string())
}
fn access_token_store(app: &tauri::AppHandle) -> Result<AccessTokenStore, String> {
    AccessTokenStore::new(&app.config().identifier)
        .map_err(|_| "无法访问系统凭据库中的小胤登录记录".to_string())
}
#[tauri::command]
pub(crate) async fn open_dingtalk_login(app: tauri::AppHandle) -> Result<(), String> {
    let base = control_plane_url()?;
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|_| "无法连接小胤服务端".to_string())?
        .post(format!(
            "{base}/api/v1/dingtalk-auth/authorization-requests"
        ))
        .header("Content-Type", "application/json")
        .body("{}")
        .send()
        .await
        .map_err(|_| "无法连接钉钉登录服务".to_string())?;
    if !response.status().is_success() {
        return Err("钉钉登录服务不可用".to_string());
    }
    let envelope: DingTalkConfigurationEnvelope = response
        .json()
        .await
        .map_err(|_| "钉钉登录配置无效".to_string())?;
    let data = envelope
        .data
        .filter(|_| envelope.success)
        .ok_or_else(|| "钉钉登录配置未启用".to_string())?;
    if data.state.is_empty() || data.authorization_url.is_empty() {
        return Err("钉钉登录配置缺少授权信息".to_string());
    }
    if let Ok(mut pending) = PENDING_AUTHORIZATION.lock() {
        *pending = Some((data.state, Instant::now() + Duration::from_secs(300)));
    }
    app.opener()
        .open_url(&data.authorization_url, None::<&str>)
        .map_err(|_| "无法打开钉钉授权页面".to_string())?;
    let _ = app.emit_to("main", "dingtalk-login-progress", "authorizing");
    Ok(())
}

#[tauri::command]
pub(crate) async fn dingtalk_session(
    app: tauri::AppHandle,
) -> Result<DingTalkSessionStatus, Diagnostic> {
    let base =
        control_plane_url().map_err(|_| Diagnostic::new(Code::ConfigurationInvalid, None, None))?;
    let result = resolve_xiaoyin_session(&app, &base).await;
    remember_employee(result.as_ref().ok());
    if !result.as_ref().err().is_some_and(transient_session_error)
        && let Ok(mut cache) = OFFLINE_EMPLOYEE.lock()
    {
        *cache = None;
    }
    let diagnostic = match &result {
        Ok(session) => &session.diagnostic,
        Err(diagnostic) => diagnostic,
    };
    if let Ok(directory) = app.path().app_log_dir() {
        let path = directory.join("xiaoyin-session.json");
        let diagnostic = diagnostic.clone();
        let _ =
            tauri::async_runtime::spawn_blocking(move || diagnostics::record(&path, &diagnostic))
                .await;
    }
    result
}

async fn resolve_xiaoyin_session(
    app: &tauri::AppHandle,
    base: &str,
) -> Result<DingTalkSessionStatus, Diagnostic> {
    let store = access_token_store(app)
        .map_err(|_| Diagnostic::new(Code::CookieStoreFailed, None, None))?;
    let snapshot = tauri::async_runtime::spawn_blocking(move || store.load())
        .await
        .map_err(|_| Diagnostic::new(Code::CookieStoreFailed, None, None))?
        .map_err(|_| Diagnostic::new(Code::CookieStoreFailed, None, None))?;
    let mut snapshot = match snapshot {
        Some(snapshot) => snapshot,
        None => match poll_pending_authorization(app, base).await? {
            Some(snapshot) => snapshot,
            None => {
                return Ok(unauthenticated(Diagnostic::new(
                    Code::CookieMissing,
                    Some(0),
                    None,
                )));
            }
        },
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |value| value.as_secs() as i64);
    if snapshot.expires_at <= now {
        return Ok(unauthenticated(Diagnostic::new(
            Code::SessionRejected,
            Some(401),
            None,
        )));
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| Diagnostic::new(Code::ConfigurationInvalid, None, None))?;
    if snapshot.expires_at - now <= 5 * 60 {
        let response = client
            .post(format!("{base}/api/v1/employee-auth/session/refresh"))
            .header("Authorization", format!("Bearer {}", snapshot.access_token))
            .header("X-Requested-With", "XMLHttpRequest")
            .send()
            .await
            .map_err(|error| {
                Diagnostic::new(
                    if error.is_timeout() {
                        Code::RequestTimeout
                    } else {
                        Code::NetworkError
                    },
                    None,
                    None,
                )
            })?;
        let refresh_status = response.status().as_u16();
        if refresh_status == 401 || refresh_status == 403 {
            let store = access_token_store(app)
                .map_err(|_| Diagnostic::new(Code::CookieStoreFailed, None, None))?;
            let _ = tauri::async_runtime::spawn_blocking(move || store.clear()).await;
            return Ok(unauthenticated(Diagnostic::new(
                Code::SessionRejected,
                Some(0),
                Some(refresh_status),
            )));
        }
        if !response.status().is_success() {
            return Err(Diagnostic::new(
                if refresh_status >= 500 || refresh_status == 429 {
                    Code::IdentityUnavailable
                } else {
                    Code::IdentityInvalid
                },
                Some(0),
                Some(refresh_status),
            ));
        }
        let envelope: DingTalkRefreshEnvelope = response
            .json()
            .await
            .map_err(|_| Diagnostic::new(Code::IdentityInvalid, Some(0), Some(refresh_status)))?;
        if !envelope.success {
            return Err(Diagnostic::new(
                Code::IdentityInvalid,
                Some(0),
                Some(refresh_status),
            ));
        }
        let refreshed = envelope
            .data
            .filter(|session| {
                !session.session_token.is_empty() && !session.employee.employee_id.is_empty()
            })
            .ok_or_else(|| Diagnostic::new(Code::IdentityInvalid, Some(0), Some(refresh_status)))?;
        snapshot = AccessTokenSnapshot {
            access_token: refreshed.session_token,
            expires_at: refreshed.expires_at,
            employee: refreshed.employee.employee_id,
            team_id: refreshed.employee.team_id,
            display_name: refreshed.employee.employee_name,
        };
        let store = access_token_store(app)
            .map_err(|_| Diagnostic::new(Code::CookieStoreFailed, None, None))?;
        let saved = snapshot.clone();
        tauri::async_runtime::spawn_blocking(move || store.save(&saved))
            .await
            .map_err(|_| Diagnostic::new(Code::CookieStoreFailed, None, None))?
            .map_err(|_| Diagnostic::new(Code::CookieStoreFailed, None, None))?;
        if let Ok(mut guard) = CONNECTOR_TOKEN.lock() {
            *guard = Some(ConnectorToken {
                epoch: mcp::session_epoch(),
                employee_id: snapshot.employee.clone(),
                control_token: snapshot.access_token.clone(),
                connector_token: snapshot.access_token.clone(),
                expires_at: snapshot.expires_at,
            });
        }
    }
    let response = client
        .get(format!("{base}/api/v1/employee-auth/identity"))
        .header("Authorization", format!("Bearer {}", snapshot.access_token))
        .send()
        .await
        .map_err(|error| {
            Diagnostic::new(
                if error.is_timeout() {
                    Code::RequestTimeout
                } else {
                    Code::NetworkError
                },
                None,
                None,
            )
        })?;
    let status = response.status().as_u16();
    if status == 401 || status == 403 {
        let store = access_token_store(app)
            .map_err(|_| Diagnostic::new(Code::CookieStoreFailed, None, None))?;
        let _ = tauri::async_runtime::spawn_blocking(move || store.clear()).await;
        return Ok(unauthenticated(Diagnostic::new(
            Code::SessionRejected,
            Some(0),
            Some(status),
        )));
    }
    if !response.status().is_success() {
        return Err(Diagnostic::new(
            if status >= 500 || status == 429 {
                Code::IdentityUnavailable
            } else {
                Code::IdentityInvalid
            },
            Some(0),
            Some(status),
        ));
    }
    let envelope: ControlPlaneEnvelope = response
        .json()
        .await
        .map_err(|_| Diagnostic::new(Code::IdentityInvalid, Some(0), Some(status)))?;
    let identity = envelope
        .data
        .filter(|_| envelope.success)
        .ok_or_else(|| Diagnostic::new(Code::IdentityInvalid, Some(0), Some(status)))?;
    if identity.employee_id != snapshot.employee || identity.team_id != snapshot.team_id {
        return Err(Diagnostic::new(
            Code::IdentityInvalid,
            Some(0),
            Some(status),
        ));
    }
    mcp::activate_session(mcp::session_epoch());
    Ok(DingTalkSessionStatus {
        authenticated: true,
        session_token: snapshot.access_token,
        expires_at: Some(snapshot.expires_at),
        user: Some(DingTalkUser {
            user_id: identity.employee_id,
            display_name: snapshot.display_name,
            department: String::new(),
            team_id: identity.team_id,
            position: String::new(),
            data_permission: String::new(),
            company_id: String::new(),
            company_name: String::new(),
            role: "operator".to_string(),
        }),
        login_url: String::new(),
        diagnostic: Diagnostic::new(Code::Authenticated, Some(0), Some(status)),
    })
}

async fn poll_pending_authorization(
    app: &tauri::AppHandle,
    base: &str,
) -> Result<Option<AccessTokenSnapshot>, Diagnostic> {
    let state = {
        let pending = PENDING_AUTHORIZATION
            .lock()
            .map_err(|_| Diagnostic::new(Code::ConfigurationInvalid, None, None))?;
        let Some((state, expires_at)) = pending.as_ref() else {
            return Ok(None);
        };
        if *expires_at <= Instant::now() {
            return Ok(None);
        }
        state.clone()
    };
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| Diagnostic::new(Code::ConfigurationInvalid, None, None))?
        .get(format!(
            "{base}/api/v1/dingtalk-auth/authorization-requests/{state}"
        ))
        .send()
        .await
        .map_err(|error| {
            Diagnostic::new(
                if error.is_timeout() {
                    Code::RequestTimeout
                } else {
                    Code::NetworkError
                },
                None,
                None,
            )
        })?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        return Err(Diagnostic::new(
            Code::IdentityUnavailable,
            None,
            Some(status),
        ));
    }
    let envelope: DingTalkAuthorizationPollEnvelope = response
        .json()
        .await
        .map_err(|_| Diagnostic::new(Code::IdentityInvalid, None, Some(status)))?;
    let Some(data) = envelope.data.filter(|_| envelope.success) else {
        return Ok(None);
    };
    if data.status != "completed" {
        return Ok(None);
    }
    let Some(session) = data.session else {
        return Err(Diagnostic::new(Code::IdentityInvalid, None, Some(status)));
    };
    if session.session_token.is_empty() || session.employee.employee_id.is_empty() {
        return Err(Diagnostic::new(Code::IdentityInvalid, None, Some(status)));
    }
    let snapshot = AccessTokenSnapshot {
        access_token: session.session_token,
        expires_at: session.expires_at,
        employee: session.employee.employee_id,
        team_id: session.employee.team_id,
        display_name: session.employee.employee_name,
    };
    let store = access_token_store(app)
        .map_err(|_| Diagnostic::new(Code::CookieStoreFailed, None, None))?;
    let saved = snapshot.clone();
    tauri::async_runtime::spawn_blocking(move || store.save(&saved))
        .await
        .map_err(|_| Diagnostic::new(Code::CookieStoreFailed, None, None))?
        .map_err(|_| Diagnostic::new(Code::CookieStoreFailed, None, None))?;
    if let Ok(mut pending) = PENDING_AUTHORIZATION.lock() {
        *pending = None;
    }
    if let Ok(mut guard) = CONNECTOR_TOKEN.lock() {
        *guard = Some(ConnectorToken {
            epoch: mcp::session_epoch(),
            employee_id: snapshot.employee.clone(),
            control_token: snapshot.access_token.clone(),
            connector_token: snapshot.access_token.clone(),
            expires_at: snapshot.expires_at,
        });
    }
    mcp::activate_session(mcp::session_epoch());
    Ok(Some(snapshot))
}

fn unauthenticated(diagnostic: Diagnostic) -> DingTalkSessionStatus {
    DingTalkSessionStatus {
        authenticated: false,
        session_token: String::new(),
        expires_at: None,
        user: None,
        login_url: String::new(),
        diagnostic,
    }
}

pub(crate) async fn require_employee(
    app: &tauri::AppHandle,
    employee_id: &str,
) -> Result<(), String> {
    let actual = current_employee(app).await?;
    if !actual.is_empty() && actual == employee_id {
        Ok(())
    } else {
        Err("当前登录账号与请求的员工不一致".into())
    }
}

pub(crate) async fn current_employee(app: &tauri::AppHandle) -> Result<String, String> {
    if cfg!(debug_assertions)
        && app.config().identifier == "com.instudio.xiaoyin.desktop.local-test"
        && env::var("XIAOYIN_LOCAL_DEV_WEBVIEW_ISOLATION")
            .ok()
            .as_deref()
            == Some("true")
        && env::var("XIAOYIN_LOCAL_DEV_REAL_SESSION").ok().as_deref() != Some("true")
    {
        return Ok("local-development".to_string());
    }
    let _guard = EMPLOYEE_CHECK.lock().await;
    if let Ok(verified) = VERIFIED_EMPLOYEE.lock()
        && let Some((epoch, id, checked)) = verified.as_ref()
        && *epoch == mcp::session_epoch()
        && epoch.is_multiple_of(2)
        && checked.elapsed() < EMPLOYEE_CACHE_AGE
    {
        return Ok(id.clone());
    }
    if let Some(id) = offline_employee(false) {
        return Ok(id);
    }
    let base = control_plane_url()?;
    let session = resolve_xiaoyin_session(app, &base)
        .await
        .map_err(|_| "无法核实当前登录账号，请重试".to_string())?;
    if !session.authenticated || mcp::session_epoch() % 2 == 1 {
        return Err("当前登录账号已失效".to_string());
    }
    remember_employee(Some(&session));
    session
        .user
        .map(|user| user.user_id)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "当前登录账号已失效".to_string())
}

#[tauri::command]
pub(crate) async fn clear_dingtalk_session(app: tauri::AppHandle) -> Result<(), String> {
    remember_employee(None);
    clear_connector_token();
    mcp::revoke_session();
    if let Ok(mut pending) = PENDING_AUTHORIZATION.lock() {
        *pending = None;
    }
    crate::schedule_desktop::stop_keep_awake();
    let store = access_token_store(&app)?;
    if let Ok(Some(snapshot)) = store.load()
        && let Ok(base) = control_plane_url()
    {
        let _ = reqwest::Client::new()
            .delete(format!("{base}/api/v1/employee-auth/session"))
            .header("Authorization", format!("Bearer {}", snapshot.access_token))
            .header("X-Requested-With", "XMLHttpRequest")
            .send()
            .await;
    }
    tauri::async_runtime::spawn_blocking(move || store.clear())
        .await
        .map_err(|_| "无法清除系统凭据库中的小胤登录记录".to_string())?
        .map_err(|_| "无法清除系统凭据库中的小胤登录记录".to_string())
}
