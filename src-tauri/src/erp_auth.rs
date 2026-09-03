use crate::show_main_window;
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    env,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};

const ERP_LOGIN_URL: &str = "http://www.instudio.me:6206/eshop/manager/login.jsp";
const ERP_USER_URL: &str =
    "http://www.instudio.me:6206/gateway/tiktok-product-publish-service/auth/user";
const ERP_PERMISSION_URL: &str =
    "http://www.instudio.me:6206/erpaccount/erpaccount/dashboard/managerstats";
const ERP_COOKIE_URL: &str = "http://www.instudio.me:6206/eshop/";
const ERP_DINGTALK_APP_ID: &str = "dingoa43wafbtpeg2czybj";
const ERP_DINGTALK_CALLBACK_URL: &str =
    "http://www.instudio.me:6206/eshop/login.do?method=qrcodelogin";
const DINGTALK_QR_LOGIN_URL: &str = "https://login.dingtalk.com/login/qrcode.htm";

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

#[derive(Deserialize)]
struct ErpPermission {
    code: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ErpSessionStatus {
    authenticated: bool,
    access_token: String,
    expires_at: Option<i64>,
    user: Option<ErpUser>,
    login_url: String,
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

fn erp_permission_url() -> String {
    setting("XIAOYIN_ERP_PERMISSION_URL", ERP_PERMISSION_URL)
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
pub(crate) fn open_erp_login(app: tauri::AppHandle) -> Result<(), String> {
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
    window.set_focus().map_err(|error| error.to_string())
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
pub(crate) async fn erp_session(app: tauri::AppHandle) -> Result<ErpSessionStatus, String> {
    let webview = app
        .get_webview_window("erp-login")
        .or_else(|| app.get_webview_window("main"))
        .ok_or_else(|| "找不到桌面 WebView".to_string())?;
    let cookie_url = erp_cookie_url()
        .parse()
        .map_err(|error| format!("ERP Cookie 地址无效：{error}"))?;
    let cookies = tauri::async_runtime::spawn_blocking(move || webview.cookies_for_url(cookie_url))
        .await
        .map_err(|error| format!("读取 ERP 登录状态失败：{error}"))?
        .map_err(|error| format!("读取 ERP Cookie 失败：{error}"))?;
    let cookie_header = cookies
        .iter()
        .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
        .collect::<Vec<_>>()
        .join("; ");

    if cookie_header.is_empty() {
        return Ok(unauthenticated_erp_session());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("无法创建 ERP 会话客户端：{error}"))?;
    let response = client
        .get(erp_user_url())
        .header("Accept", "application/json")
        .header("X-Requested-With", "XMLHttpRequest")
        .header("Cookie", &cookie_header)
        .send()
        .await
        .map_err(|error| format!("ERP 登录状态检查失败：{error}"))?;

    let user = if response.status().is_success() {
        let identity: ErpIdentity = response
            .json()
            .await
            .map_err(|error| format!("ERP 身份响应无效：{error}"))?;
        erp_user_from_identity(&identity)?
    } else {
        match legacy_erp_user(&client, &cookie_header).await? {
            Some(user) => user,
            None => return Ok(unauthenticated_erp_session()),
        }
    };
    let access_token = trusted_internal_token(&cookie_header);
    if let Some(window) = app.get_webview_window("erp-login") {
        let _ = window.hide();
        if let Ok(url) = erp_login_window_url(&app) {
            let _ = window.navigate(url);
        }
    }
    show_main_window(&app);
    Ok(ErpSessionStatus {
        authenticated: true,
        access_token,
        expires_at: trusted_session_expiry(),
        user: Some(user),
        login_url: erp_login_url(),
    })
}

async fn legacy_erp_user(
    client: &reqwest::Client,
    cookie_header: &str,
) -> Result<Option<ErpUser>, String> {
    let response = client
        .post(erp_permission_url())
        .header("Accept", "application/json")
        .header("X-Requested-With", "XMLHttpRequest")
        .header("Cookie", cookie_header)
        .send()
        .await
        .map_err(|error| format!("ERP 权限校验失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("ERP 权限校验失败：HTTP {}", response.status()));
    }
    let permission: ErpPermission = response
        .json()
        .await
        .map_err(|error| format!("ERP 权限响应无效：{error}"))?;
    Ok((permission.code == Some(200)).then(|| trusted_erp_user(cookie_header)))
}

fn unauthenticated_erp_session() -> ErpSessionStatus {
    ErpSessionStatus {
        authenticated: false,
        access_token: String::new(),
        expires_at: None,
        user: None,
        login_url: erp_login_url(),
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
        .unwrap_or_else(|| company_id.clone());
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

fn trusted_erp_user(cookie_header: &str) -> ErpUser {
    let digest = cookie_digest(cookie_header);
    ErpUser {
        user_id: format!("erp-{}", &digest[..16]),
        display_name: "ERP 员工".to_string(),
        department: "企业内部".to_string(),
        team_id: "internal".to_string(),
        position: String::new(),
        data_permission: "erp-manager".to_string(),
        company_id: "internal".to_string(),
        company_name: "企业内部版".to_string(),
        role: "admin".to_string(),
    }
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

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(erp_user_url().ends_with("/auth/user"));
        assert!(erp_permission_url().ends_with("/dashboard/managerstats"));
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
    fn internal_trust_token_does_not_expose_the_cookie() {
        let cookie = "SESSION=secret-session";
        let token = trusted_internal_token(cookie);
        assert!(token.starts_with("internal-trust:"));
        assert!(!token.contains(cookie));
        assert_eq!(token, trusted_internal_token(cookie));
        let user = trusted_erp_user(cookie);
        assert!(user.user_id.starts_with("erp-"));
        assert!(!user.user_id.contains("secret-session"));
        assert_eq!(user.role, "admin");
    }
}
