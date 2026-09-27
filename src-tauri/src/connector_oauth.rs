use crate::harness_connectors::{
    ConnectorDefinition, RuntimeConnector, validate_connector_catalog,
};
use keyring::Entry;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

#[derive(Default)]
struct CredentialSlot {
    state: Mutex<Option<Value>>,
    generation: AtomicU64,
}

#[derive(Default)]
pub struct ConnectorOAuthManager {
    slots: Mutex<HashMap<String, Arc<CredentialSlot>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorizationRequest {
    employee_id: String,
    connector: ConnectorDefinition,
    action: String,
}

fn credential_key(employee: &str, id: &str, url: &str) -> Result<String, String> {
    if employee.trim().is_empty() || employee.len() > 200 || id.is_empty() || id.len() > 200 {
        return Err("授权身份无效".into());
    }
    let endpoint = reqwest::Url::parse(url).map_err(|_| "授权地址无效")?;
    if (endpoint.scheme() != "https"
        && !(endpoint.scheme() == "http"
            && matches!(
                endpoint.host_str(),
                Some("127.0.0.1" | "[::1]" | "localhost")
            )))
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.fragment().is_some()
    {
        return Err("OAuth 地址必须使用 HTTPS".into());
    }
    let bytes =
        serde_json::to_vec(&(employee, id, endpoint.as_str())).map_err(|_| "授权身份无效")?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

impl ConnectorOAuthManager {
    fn slot(&self, key: &str) -> Result<Arc<CredentialSlot>, String> {
        let mut slots = self.slots.lock().map_err(|_| "授权状态不可用")?;
        Ok(Arc::clone(slots.entry(key.to_owned()).or_default()))
    }
}

#[tauri::command]
pub async fn connector_authorization(
    app: tauri::AppHandle,
    request: AuthorizationRequest,
) -> Result<Value, String> {
    validate_connector_catalog(std::slice::from_ref(&request.connector))?;
    if request.connector.auth_mode != "oauth"
        || !matches!(
            request.action.as_str(),
            "status" | "authorize" | "disconnect" | "cancel"
        )
    {
        return Err("连接器授权操作无效".into());
    }
    crate::dingtalk_auth::require_employee(&app, &request.employee_id).await?;
    let key = credential_key(
        &request.employee_id,
        &request.connector.id,
        &request.connector.url,
    )?;
    let slot = app.state::<ConnectorOAuthManager>().slot(&key)?;
    // Cancellation and disconnect invalidate an in-flight browser flow before taking its lock.
    if matches!(request.action.as_str(), "cancel" | "disconnect") {
        slot.generation.fetch_add(1, Ordering::SeqCst);
    }
    if request.action == "cancel" {
        return Ok(json!({"status": "canceled"}));
    }
    let generation = slot.generation.load(Ordering::SeqCst);
    let epoch = crate::dingtalk_auth::mcp::session_epoch();
    tauri::async_runtime::spawn_blocking(move || {
        operate(
            &app,
            &slot,
            &key,
            &request.connector.url,
            &request.action,
            (generation, epoch),
        )
    })
    .await
    .map_err(|_| "连接器授权线程异常".to_string())?
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn public_status(state: &Value) -> Value {
    json!({
        "status": if state["tokens"]["access_token"].is_string() { "authorized" } else { "disconnected" },
        "scope": state["tokens"]["scope"].as_str().unwrap_or(""),
        "expiresAt": state["expiresAt"].as_u64(),
    })
}

fn operate(
    app: &tauri::AppHandle,
    slot: &CredentialSlot,
    key: &str,
    url: &str,
    action: &str,
    identity: (u64, u64),
) -> Result<Value, String> {
    let mut cache = slot.state.lock().map_err(|_| "授权状态不可用")?;
    let (generation, epoch) = identity;
    let valid = || {
        generation == slot.generation.load(Ordering::SeqCst)
            && epoch % 2 == 0
            && epoch == crate::dingtalk_auth::mcp::session_epoch()
    };
    if !valid() {
        return Err("连接器授权已取消".into());
    }
    let entry = Entry::new("com.instudio.xiaoyin.connector-oauth", key)
        .map_err(|_| "无法访问系统钥匙串")?;
    if cache.is_none() {
        *cache = Some(match entry.get_password() {
            Ok(value) => serde_json::from_str(&value).map_err(|_| "连接器授权记录损坏")?,
            Err(keyring::Error::NoEntry) => json!({}),
            Err(_) => return Err("无法读取系统钥匙串".into()),
        });
    }
    let state = cache.as_mut().ok_or("授权状态不可用")?;
    if action == "status" {
        return Ok(public_status(state));
    }
    if action == "token" && state["expiresAt"].as_u64().unwrap_or(0) > now_ms() + 30_000 {
        return Ok(json!({"token": state["tokens"]["access_token"]}));
    }
    let runtime = crate::harness::resolve_runtime_paths(app)?;
    let worker = runtime.entry.with_file_name("connector-oauth-worker.js");
    let mut command = Command::new(&runtime.node);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command
        .arg(worker)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "无法启动连接器授权服务")?;
    let result = (|| {
        let mut input = child.stdin.take().ok_or("授权通道不可用")?;
        let output = child.stdout.take().ok_or("授权通道不可用")?;
        writeln!(
            input,
            "{}",
            json!({"action": action, "url": url, "state": state})
        )
        .map_err(|_| "授权请求失败")?;
        input.flush().map_err(|_| "授权请求失败")?;
        let (sender, receiver) = mpsc::sync_channel(4);
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                if line.len() > 1_048_576 || sender.send(line).is_err() {
                    break;
                }
            }
        });
        let deadline =
            Instant::now() + Duration::from_secs(if action == "authorize" { 195 } else { 45 });
        loop {
            if !valid() {
                return Err("连接器授权已取消".into());
            }
            if Instant::now() > deadline {
                return Err("连接器授权超时，请重试".into());
            }
            let line = match receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(line) => line,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => return Err("连接器授权服务已退出".into()),
            };
            let message: Value = serde_json::from_str(&line).map_err(|_| "授权响应无效")?;
            if !valid() {
                return Err("连接器授权已取消".into());
            }
            match message["type"].as_str() {
                Some("open") if action == "authorize" => {
                    let target = message["url"].as_str().ok_or("授权地址无效")?;
                    credential_key("validation", "validation", target)?;
                    app.opener()
                        .open_url(target, None::<&str>)
                        .map_err(|_| "无法打开授权页面")?;
                }
                Some("save") => {
                    let next = &message["state"];
                    if !next.is_object() {
                        return Err("授权记录无效".into());
                    }
                    if next.as_object().is_some_and(|value| value.is_empty()) {
                        match entry.delete_credential() {
                            Ok(()) | Err(keyring::Error::NoEntry) => {}
                            Err(_) => return Err("无法移除系统钥匙串授权".into()),
                        }
                    } else {
                        entry
                            .set_password(&next.to_string())
                            .map_err(|_| "无法保存到系统钥匙串")?;
                    }
                    *state = next.clone();
                    writeln!(input, "{}", json!({"ok": true}))
                        .and_then(|_| input.flush())
                        .map_err(|_| "授权保存确认失败")?;
                }
                Some("done") => {
                    return Ok(if action == "token" {
                        json!({"token": state["tokens"]["access_token"]})
                    } else {
                        let mut result = public_status(state);
                        result["revoked"] = message["revoked"].clone();
                        result
                    });
                }
                Some("error") => {
                    return Ok(json!({"status": message["status"], "error": message["error"]}));
                }
                _ => return Err("授权响应无效".into()),
            }
        }
    })();
    let _ = child.kill();
    let _ = child.wait();
    result
}

pub(crate) fn token_result(
    app: &tauri::AppHandle,
    connector: Option<&RuntimeConnector>,
    target: &str,
    employee: &str,
    epoch: u64,
    rejected_token: Option<&str>,
) -> Value {
    let result = (|| {
        let connector = connector
            .filter(|value| value.auth_mode == "oauth")
            .ok_or("连接器未配置 OAuth 授权")?;
        let endpoint = reqwest::Url::parse(&connector.url).map_err(|_| "授权地址无效")?;
        let target = reqwest::Url::parse(target).map_err(|_| "请求地址无效")?;
        if endpoint.origin() != target.origin()
            || !target.username().is_empty()
            || target.password().is_some()
        {
            return Err("请求来源未授权".into());
        }
        let key = credential_key(employee, &connector.id, &connector.url)?;
        let slot = app.state::<ConnectorOAuthManager>().slot(&key)?;
        if let Some(token) = rejected_token {
            if epoch % 2 == 1 || epoch != crate::dingtalk_auth::mcp::session_epoch() {
                return Err("连接器会话已关闭".into());
            }
            let mut cache = slot.state.lock().map_err(|_| "授权状态不可用")?;
            if let Some(state) = cache.as_mut()
                && state["tokens"]["access_token"].as_str() == Some(token)
            {
                state["expiresAt"] = json!(0);
                Entry::new("com.instudio.xiaoyin.connector-oauth", &key)
                    .map_err(|_| "无法访问系统钥匙串")?
                    .set_password(&state.to_string())
                    .map_err(|_| "无法保存授权状态")?;
            }
            return Ok(json!({"invalidated": true}));
        }
        let generation = slot.generation.load(Ordering::SeqCst);
        operate(
            app,
            &slot,
            &key,
            &connector.url,
            "token",
            (generation, epoch),
        )
    })();
    result
        .unwrap_or_else(|_: String| json!({"status": 401, "error": "连接器授权不可用，请重新连接"}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credential_is_bound_to_employee_connector_and_endpoint() {
        let key = credential_key("alice", "calendar", "https://example.com/mcp").unwrap();
        for (employee, id, url) in [
            ("bob", "calendar", "https://example.com/mcp"),
            ("alice", "mail", "https://example.com/mcp"),
            ("alice", "calendar", "https://example.com/other"),
        ] {
            assert_ne!(key, credential_key(employee, id, url).unwrap());
        }
        assert!(credential_key("alice", "calendar", "http://example.com/mcp").is_err());
        assert!(
            credential_key("alice", "calendar", "https://user:secret@example.com/mcp").is_err()
        );
    }
    #[test]
    fn public_status_never_contains_tokens() {
        let result = public_status(
            &json!({"tokens": {"access_token": "secret", "refresh_token": "private", "scope": "read"}, "expiresAt": 100}),
        );
        assert_eq!(result["scope"], "read");
        assert!(!result.to_string().contains("secret"));
        assert!(!result.to_string().contains("private"));
    }
}
