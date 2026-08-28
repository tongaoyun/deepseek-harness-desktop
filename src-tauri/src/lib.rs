use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde::{Deserialize, Serialize};
use std::{env, time::Duration};
use tauri::{
    Manager,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};

mod expert_kits;
mod harness;
mod im;
mod local_files;
mod memory;

const ERP_LOGIN_URL: &str = "http://www.instudio.me:6206/eshop/manager/login.jsp";
const ERP_EXCHANGE_URL: &str = "http://www.instudio.me:6206/apisix/xiaoyin-sso/api/auth/exchange";
const ERP_COOKIE_URL: &str = "http://www.instudio.me:6206/";
const ERP_DINGTALK_APP_ID: &str = "dingoa43wafbtpeg2czybj";
const ERP_DINGTALK_CALLBACK_URL: &str =
    "http://www.instudio.me:6206/eshop/login.do?method=qrcodelogin";
const DINGTALK_QR_GENERATE_URL: &str = "https://login.dingtalk.com/user/qrcode/generate";
const DINGTALK_QR_POLL_URL: &str = "https://login.dingtalk.com/login/login_with_qr";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInfo {
    app_version: &'static str,
    os: &'static str,
    arch: &'static str,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
struct ErpUser {
    user_id: String,
    display_name: String,
    department: String,
    position: String,
    data_permission: String,
    company_id: String,
    company_name: String,
    role: String,
}

#[derive(Deserialize)]
struct ExchangedSession {
    access_token: String,
    expires_at: i64,
    user: ErpUser,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErpSessionStatus {
    authenticated: bool,
    access_token: String,
    expires_at: Option<i64>,
    user: Option<ErpUser>,
    login_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErpQrLoginConfiguration {
    qr_code_content: String,
    qr_session_code: String,
    poll_interval_seconds: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErpQrLoginPollResult {
    status: String,
    error_message: Option<String>,
}

#[derive(Deserialize)]
struct DingTalkQrGenerateResponse {
    success: bool,
    result: Option<String>,
    message: Option<String>,
}

#[derive(Deserialize)]
struct DingTalkQrPollResponse {
    success: bool,
    code: Option<String>,
    data: Option<String>,
    message: Option<String>,
}

fn setting(name: &str, fallback: &str) -> String {
    env::var(name).unwrap_or_else(|_| fallback.to_string())
}

fn erp_login_url() -> String {
    setting("XIAOYIN_ERP_LOGIN_URL", ERP_LOGIN_URL)
}

fn erp_exchange_url() -> String {
    setting("XIAOYIN_ERP_EXCHANGE_URL", ERP_EXCHANGE_URL)
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

fn erp_dingtalk_qr_content(session_code: &str) -> String {
    let callback_url = setting(
        "XIAOYIN_ERP_DINGTALK_CALLBACK_URL",
        ERP_DINGTALK_CALLBACK_URL,
    );
    format!(
        "https://oapi.dingtalk.com/connect/qrcommit?showmenu=false&code={}&appid={}&redirect_uri={}",
        utf8_percent_encode(session_code, NON_ALPHANUMERIC),
        utf8_percent_encode(&dingtalk_app_id(), NON_ALPHANUMERIC),
        utf8_percent_encode(&callback_url, NON_ALPHANUMERIC),
    )
}

fn validated_qr_session_code(value: &str) -> Result<&str, String> {
    if value.is_empty() || value.len() > 1024 || value.chars().any(char::is_control) {
        return Err("钉钉二维码会话无效".to_string());
    }
    Ok(value)
}

fn login_tmp_code_from_url(value: &str) -> Result<String, String> {
    let url = value
        .parse::<tauri::Url>()
        .map_err(|error| format!("钉钉扫码结果无效：{error}"))?;
    url.query_pairs()
        .find_map(|(key, value)| (key == "loginTmpCode").then(|| value.into_owned()))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "钉钉扫码结果缺少临时授权码".to_string())
}

#[tauri::command]
fn runtime_info() -> RuntimeInfo {
    RuntimeInfo {
        app_version: env!("CARGO_PKG_VERSION"),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    }
}

#[tauri::command]
fn open_erp_login(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("erp-login")
        .ok_or_else(|| "找不到 ERP 扫码窗口".to_string())?;
    window
        .reload()
        .map_err(|error| format!("无法刷新 ERP 扫码页面：{error}"))?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
async fn erp_qr_login_configuration() -> Result<ErpQrLoginConfiguration, String> {
    let app_id = dingtalk_app_id();
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|error| format!("无法创建钉钉二维码客户端：{error}"))?
        .get(DINGTALK_QR_GENERATE_URL)
        .query(&[
            ("bizScene", "http_third_party"),
            ("sceneId", app_id.as_str()),
        ])
        .send()
        .await
        .map_err(|error| format!("获取钉钉二维码失败：{error}"))?
        .error_for_status()
        .map_err(|error| format!("获取钉钉二维码失败：{error}"))?
        .json::<DingTalkQrGenerateResponse>()
        .await
        .map_err(|error| format!("钉钉二维码响应无效：{error}"))?;
    let session_code = response
        .result
        .filter(|value| response.success && validated_qr_session_code(value).is_ok())
        .ok_or_else(|| {
            response
                .message
                .unwrap_or_else(|| "钉钉未返回二维码会话".to_string())
        })?;
    Ok(ErpQrLoginConfiguration {
        qr_code_content: erp_dingtalk_qr_content(&session_code),
        qr_session_code: session_code,
        poll_interval_seconds: 2,
    })
}

fn navigate_erp_qr_login(app: &tauri::AppHandle, login_tmp_code: &str) -> Result<(), String> {
    if login_tmp_code.is_empty()
        || login_tmp_code.len() > 1024
        || login_tmp_code.chars().any(char::is_control)
    {
        return Err("钉钉扫码凭据无效".to_string());
    }
    let target = format!(
        "{}&loginTmpCode={}",
        erp_dingtalk_auth_url(),
        utf8_percent_encode(login_tmp_code, NON_ALPHANUMERIC),
    );
    let url = target
        .parse()
        .map_err(|error| format!("钉钉授权地址无效：{error}"))?;
    app.get_webview_window("erp-login")
        .ok_or_else(|| "找不到 ERP 扫码窗口".to_string())?
        .navigate(url)
        .map_err(|error| format!("无法进入 ERP 授权确认页：{error}"))
}

#[tauri::command]
async fn poll_erp_qr_login(
    app: tauri::AppHandle,
    qr_session_code: String,
) -> Result<ErpQrLoginPollResult, String> {
    let qr_session_code = validated_qr_session_code(&qr_session_code)?;
    let app_id = dingtalk_app_id();
    let goto = erp_dingtalk_auth_url();
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|error| format!("无法创建钉钉扫码状态客户端：{error}"))?
        .post(DINGTALK_QR_POLL_URL)
        .form(&[
            ("qrCode", qr_session_code),
            ("goto", goto.as_str()),
            ("pdmToken", ""),
            ("bizScene", "http_third_party"),
            ("sceneId", app_id.as_str()),
        ])
        .send()
        .await
        .map_err(|error| format!("查询钉钉扫码状态失败：{error}"))?
        .error_for_status()
        .map_err(|error| format!("查询钉钉扫码状态失败：{error}"))?
        .json::<DingTalkQrPollResponse>()
        .await
        .map_err(|error| format!("钉钉扫码状态响应无效：{error}"))?;

    if response.success {
        let login_tmp_code = response
            .data
            .as_deref()
            .ok_or_else(|| "钉钉扫码成功但未返回授权结果".to_string())
            .and_then(login_tmp_code_from_url)?;
        navigate_erp_qr_login(&app, &login_tmp_code)?;
        return Ok(ErpQrLoginPollResult {
            status: "confirmed".to_string(),
            error_message: None,
        });
    }
    let status = match response.code.as_deref() {
        Some("11021") => "waiting",
        Some("11041") => "scanned",
        Some("11019") => "expired",
        _ => "error",
    };
    Ok(ErpQrLoginPollResult {
        status: status.to_string(),
        error_message: (status == "error").then(|| {
            response
                .message
                .unwrap_or_else(|| "钉钉扫码状态异常".to_string())
        }),
    })
}

#[tauri::command]
async fn erp_session(app: tauri::AppHandle) -> Result<ErpSessionStatus, String> {
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

    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("无法创建 ERP 会话客户端：{error}"))?
        .post(erp_exchange_url())
        .header("Accept", "application/json")
        .header("X-Requested-With", "XMLHttpRequest")
        .header("Cookie", cookie_header)
        .send()
        .await
        .map_err(|error| format!("ERP 登录状态检查失败：{error}"))?;

    if response.status() == reqwest::StatusCode::UNAUTHORIZED || response.status().is_redirection()
    {
        return Ok(ErpSessionStatus {
            authenticated: false,
            access_token: String::new(),
            expires_at: None,
            user: None,
            login_url: erp_login_url(),
        });
    }
    if !response.status().is_success() {
        return Err(format!("ERP 会话交换失败：HTTP {}", response.status()));
    }
    let session: ExchangedSession = response
        .json()
        .await
        .map_err(|error| format!("ERP 会话响应无效：{error}"))?;
    if let Some(window) = app.get_webview_window("erp-login") {
        let _ = window.close();
    }
    Ok(ErpSessionStatus {
        authenticated: true,
        access_token: session.access_token,
        expires_at: Some(session.expires_at),
        user: Some(session.user),
        login_url: erp_login_url(),
    })
}

#[tauri::command]
async fn clear_erp_session(app: tauri::AppHandle) -> Result<(), String> {
    let webview = app
        .get_webview_window("main")
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(harness::HarnessManager::default())
        .manage(im::LocalImManager::default())
        .manage(local_files::LocalFileAuthorizations::default())
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "打开小胤", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出小胤", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::with_id("xiaoyin")
                .menu(&menu)
                .tooltip("小胤")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(event, tauri::tray::TrayIconEvent::DoubleClick { .. }) {
                        show_main_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "erp-login"
                && let tauri::WindowEvent::CloseRequested { api, .. } = event
            {
                api.prevent_close();
                let _ = window.hide();
            } else if window.label() == "main"
                && let tauri::WindowEvent::CloseRequested { api, .. } = event
            {
                api.prevent_close();
                let _ = window.hide();
                if let Some(login_window) = window.app_handle().get_webview_window("erp-login") {
                    let _ = login_window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            runtime_info,
            erp_session,
            clear_erp_session,
            open_erp_login,
            erp_qr_login_configuration,
            poll_erp_qr_login,
            expert_kits::list_installed_expert_kits,
            expert_kits::install_expert_kit,
            local_files::authorize_local_directory,
            local_files::revoke_local_directory,
            local_files::clear_local_directories,
            harness::run_harness,
            harness::shutdown_harness,
            im::configure_local_dingtalk,
            im::start_local_im,
            im::set_local_im_enabled,
            im::local_im_status,
            im::allow_local_im_pairing,
            im::stop_local_im_runtime,
            im::remove_local_dingtalk,
            memory::load_memory_profile,
            memory::save_memory_profile
        ])
        .run(tauri::generate_context!())
        .expect("error while running Xiaoyin desktop");
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qr_session_code_is_validated() {
        assert_eq!(validated_qr_session_code("session-123"), Ok("session-123"));
        assert!(validated_qr_session_code("").is_err());
        assert!(validated_qr_session_code("session\n123").is_err());
        assert!(validated_qr_session_code(&"a".repeat(1025)).is_err());
    }

    #[test]
    fn login_tmp_code_is_extracted_and_decoded() {
        assert_eq!(
            login_tmp_code_from_url(
                "https://erp.example/callback?loginTmpCode=code%2Bwith%2Fsymbols"
            )
            .unwrap(),
            "code+with/symbols",
        );
    }
}
