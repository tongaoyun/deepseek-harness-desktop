use crate::show_main_window;
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    env,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
mod diagnostics;
use diagnostics::{Code, Diagnostic};

const ERP_LOGIN_URL: &str = "http://www.instudio.me:6206/eshop/manager/login.jsp";
const ERP_USER_URL: &str =
    "http://www.instudio.me:6206/gateway/tiktok-product-publish-service/auth/user";
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
pub(crate) async fn erp_session(app: tauri::AppHandle) -> Result<ErpSessionStatus, Diagnostic> {
    let result = resolve_session(&app).await;
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

async fn resolve_session(app: &tauri::AppHandle) -> Result<ErpSessionStatus, Diagnostic> {
    let webview = app
        .get_webview_window("erp-login")
        .or_else(|| app.get_webview_window("main"))
        .ok_or_else(|| Diagnostic::new(Code::CookieReadFailed, None, None))?;
    let cookie_url = erp_cookie_url()
        .parse()
        .map_err(|_| Diagnostic::new(Code::ConfigurationInvalid, None, None))?;
    let cookies = tauri::async_runtime::spawn_blocking(move || webview.cookies_for_url(cookie_url))
        .await
        .map_err(|_| Diagnostic::new(Code::CookieReadFailed, None, None))?
        .map_err(|_| Diagnostic::new(Code::CookieReadFailed, None, None))?;
    let cookie_header = cookies
        .iter()
        .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
        .collect::<Vec<_>>()
        .join("; ");

    if cookie_header.is_empty() {
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
        return Ok(unauthenticated_erp_session(diagnostic));
    };
    let access_token = trusted_internal_token(&cookie_header);
    if let Some(window) = app.get_webview_window("erp-login") {
        let _ = window.hide();
        if let Ok(url) = erp_login_window_url(app) {
            let _ = window.navigate(url);
        }
    }
    show_main_window(app);
    Ok(ErpSessionStatus {
        authenticated: true,
        access_token,
        expires_at: trusted_session_expiry(),
        user: Some(user),
        login_url: erp_login_url(),
        diagnostic,
    })
}

async fn resolve_identity(
    client: &reqwest::Client,
    url: &str,
    cookie_header: &str,
    cookie_count: usize,
) -> Result<(Option<ErpUser>, Diagnostic), Diagnostic> {
    let failure = |code, status| Diagnostic::new(code, Some(cookie_count), status);
    let response = client
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
    let identity: ErpIdentity = response.json().await.map_err(|error| {
        failure(
            if error.is_timeout() {
                Code::RequestTimeout
            } else {
                Code::IdentityInvalid
            },
            Some(status),
        )
    })?;
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
    }
}
