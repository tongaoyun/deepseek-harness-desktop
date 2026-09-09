use super::{erp_cookie_url, erp_user_url, resolve_identity};
use crate::harness_connectors::RuntimeConnector;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::Manager;

// Odd epochs revoke access; successful login advances to an even epoch.
static SESSION_EPOCH: AtomicU64 = AtomicU64::new(0);

pub(crate) fn session_epoch() -> u64 {
    SESSION_EPOCH.load(Ordering::SeqCst)
}

pub(super) fn revoke_session() {
    let _ = SESSION_EPOCH.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |epoch| {
        Some((epoch + 2) | 1)
    });
}

pub(super) fn activate_session(epoch: u64) {
    if epoch % 2 == 1 {
        let _ =
            SESSION_EPOCH.compare_exchange(epoch, epoch + 1, Ordering::SeqCst, Ordering::SeqCst);
    }
}

fn session_revoked(epoch: u64) -> bool {
    epoch % 2 == 1 || epoch != session_epoch()
}

fn http_url(value: &str) -> Result<reqwest::Url, ()> {
    let url = reqwest::Url::parse(value).map_err(|_| ())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(());
    }
    Ok(url)
}

fn allowed_target(endpoint: &str, target: &str, cookie_url: &str, extra_origins: &str) -> bool {
    let (Ok(endpoint), Ok(target), Ok(cookie_url)) =
        (http_url(endpoint), http_url(target), http_url(cookie_url))
    else {
        return false;
    };
    if endpoint.origin() != target.origin() {
        return false;
    }
    target.origin() == cookie_url.origin()
        || extra_origins.split(',').any(|value| {
            http_url(value.trim()).is_ok_and(|origin| {
                origin.path() == "/"
                    && origin.query().is_none()
                    && origin.origin() == target.origin()
            })
        })
}

pub(crate) async fn cookie_result(
    app: &tauri::AppHandle,
    connector: Option<&RuntimeConnector>,
    target: &str,
    employee_id: &str,
    epoch: u64,
) -> Value {
    let rejected = || json!({"status": 401, "error": "ERP 登录已失效，请重新扫码登录"});
    if session_revoked(epoch) {
        return rejected();
    }
    let Some(connector) = connector.filter(|value| {
        value.auth_mode == "erp-cookie"
            && matches!(value.transport.as_str(), "streamable-http" | "sse")
    }) else {
        return json!({"status": 403, "error": "连接器未启用 ERP 扫码会话"});
    };
    let extra_origins = std::env::var("XIAOYIN_ERP_MCP_ALLOWED_ORIGINS").unwrap_or_default();
    if !allowed_target(&connector.url, target, &erp_cookie_url(), &extra_origins) {
        return json!({"status": 403, "error": "ERP MCP 来源未授权"});
    }
    let Some(webview) = app
        .get_webview_window("erp-login")
        .or_else(|| app.get_webview_window("main"))
    else {
        return rejected();
    };
    let Ok(cookie_url) = erp_cookie_url().parse() else {
        return json!({"status": 503, "error": "ERP 会话配置无效"});
    };
    let cookies =
        tauri::async_runtime::spawn_blocking(move || webview.cookies_for_url(cookie_url)).await;
    let Ok(Ok(cookies)) = cookies else {
        return json!({"status": 503, "error": "无法读取 ERP 扫码会话"});
    };
    let cookie = cookies
        .iter()
        .map(|value| format!("{}={}", value.name(), value.value()))
        .collect::<Vec<_>>()
        .join("; ");
    if cookie.is_empty() {
        return rejected();
    }
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        return json!({"status": 503, "error": "无法核实 ERP 登录状态"});
    };
    let identity = resolve_identity(&client, &erp_user_url(), &cookie, cookies.len()).await;
    if session_revoked(epoch) {
        return rejected();
    }
    match identity {
        Ok((Some(user), _)) if employee_id.is_empty() || user.user_id == employee_id => {
            json!({"cookie": cookie})
        }
        Ok((Some(_), _)) => json!({"status": 403, "error": "当前登录账号与任务不一致"}),
        Ok((None, _)) => rejected(),
        Err(_) => json!({"status": 503, "error": "无法核实 ERP 登录状态，请重试"}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logout_revokes_old_runtimes_and_late_identity_checks_cannot_restore_them() {
        let original = session_epoch();
        assert!(!session_revoked(original));
        revoke_session();
        let logged_out = session_epoch();
        assert!(session_revoked(original));
        assert!(session_revoked(logged_out));
        activate_session(original);
        assert!(session_revoked(session_epoch()));
        activate_session(logged_out);
        assert!(!session_revoked(session_epoch()));
        assert!(session_revoked(original));
        assert!(session_revoked(logged_out));
    }

    #[test]
    fn cookie_targets_require_both_connector_origin_and_desktop_trust() {
        let erp = "https://erp.example/eshop/";
        assert!(allowed_target(
            "https://erp.example/mcp",
            "https://erp.example/messages?session=1",
            erp,
            ""
        ));
        assert!(!allowed_target(
            "https://other.example/mcp",
            "https://other.example/mcp",
            erp,
            ""
        ));
        assert!(allowed_target(
            "http://192.168.2.66:8090/mcp",
            "http://192.168.2.66:8090/mcp",
            erp,
            "http://192.168.2.66:8090"
        ));
        for target in [
            "http://erp.example/mcp",
            "https://erp.example:8443/mcp",
            "https://erp.example.evil/mcp",
            "https://user@erp.example/mcp",
        ] {
            assert!(!allowed_target(
                "https://erp.example/mcp",
                target,
                erp,
                target
            ));
        }
        assert!(!allowed_target(
            "https://other.example/mcp",
            "https://other.example/mcp",
            erp,
            "https://other.example/path"
        ));
        assert!(!allowed_target(
            "https://erp.example/mcp",
            "https://other.example/mcp",
            erp,
            "https://other.example"
        ));
    }
}
