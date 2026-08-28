use crate::{
    expert_kits,
    harness::{HarnessProcess, RuntimeFingerprint},
};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::Manager;

const KEYRING_SERVICE: &str = "com.instudio.xiaoyin.im.dingtalk";
const KEYRING_ACCOUNT: &str = "client-secret";

#[derive(Clone, Default)]
pub struct LocalImManager {
    process: Arc<Mutex<Option<HarnessProcess>>>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredDingTalkConfiguration {
    client_id: String,
    enabled: bool,
    access_policy: AccessPolicy,
    #[serde(default)]
    paired_conversations: Vec<String>,
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum AccessPolicy {
    Open,
    Pairing,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessContext {
    litellm_base_url: String,
    erp_mcp_url: String,
    model: String,
    access_token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureDingTalkRequest {
    client_id: String,
    client_secret: String,
    enabled: bool,
    access_policy: AccessPolicy,
    harness: HarnessContext,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingRequest {
    conversation_key: String,
    conversation_type: String,
    conversation_title: String,
    sender_nick: String,
    requested_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalImStatus {
    provider: String,
    configured: bool,
    enabled: bool,
    connected: bool,
    state: String,
    client_id: String,
    secret_configured: bool,
    access_policy: AccessPolicy,
    pending_pairings: Vec<PairingRequest>,
    last_error: Option<String>,
}

#[tauri::command]
pub async fn configure_local_dingtalk(
    app: tauri::AppHandle,
    manager: tauri::State<'_, LocalImManager>,
    request: ConfigureDingTalkRequest,
) -> Result<LocalImStatus, String> {
    validate_client_id(&request.client_id)?;
    validate_client_secret(&request.client_secret)?;
    validate_harness_context(&request.harness)?;
    let stored = StoredDingTalkConfiguration {
        client_id: request.client_id.trim().to_string(),
        enabled: request.enabled,
        access_policy: request.access_policy,
        paired_conversations: Vec::new(),
    };
    store_secret(&request.client_secret)?;
    save_configuration(&app, &stored)?;
    if !stored.enabled {
        manager.stop()?;
        return Ok(stopped_status(Some(&stored), true));
    }
    manager.start(&app, &stored, request.client_secret, request.harness)
}

#[tauri::command]
pub async fn start_local_im(
    app: tauri::AppHandle,
    manager: tauri::State<'_, LocalImManager>,
    harness: HarnessContext,
) -> Result<LocalImStatus, String> {
    validate_harness_context(&harness)?;
    let Some(stored) = load_configuration(&app)? else {
        return Ok(stopped_status(None, false));
    };
    if !stored.enabled {
        return Ok(stopped_status(Some(&stored), secret_exists()));
    }
    let secret = load_secret()?;
    manager.start(&app, &stored, secret, harness)
}

#[tauri::command]
pub async fn set_local_im_enabled(
    app: tauri::AppHandle,
    manager: tauri::State<'_, LocalImManager>,
    enabled: bool,
    harness: HarnessContext,
) -> Result<LocalImStatus, String> {
    validate_harness_context(&harness)?;
    let mut stored = load_configuration(&app)?.ok_or_else(|| "尚未配置钉钉频道".to_string())?;
    stored.enabled = enabled;
    save_configuration(&app, &stored)?;
    if !enabled {
        manager.stop()?;
        return Ok(stopped_status(Some(&stored), secret_exists()));
    }
    let secret = load_secret()?;
    manager.start(&app, &stored, secret, harness)
}

#[tauri::command]
pub fn local_im_status(
    app: tauri::AppHandle,
    manager: tauri::State<'_, LocalImManager>,
) -> Result<LocalImStatus, String> {
    if let Some(status) = manager.status()? {
        return Ok(status);
    }
    let stored = load_configuration(&app)?;
    Ok(stopped_status(stored.as_ref(), secret_exists()))
}

#[tauri::command]
pub fn allow_local_im_pairing(
    app: tauri::AppHandle,
    manager: tauri::State<'_, LocalImManager>,
    conversation_key: String,
) -> Result<LocalImStatus, String> {
    if conversation_key.trim().is_empty() || conversation_key.len() > 1_024 {
        return Err("IM 会话标识无效".to_string());
    }
    let mut stored = load_configuration(&app)?.ok_or_else(|| "尚未配置钉钉频道".to_string())?;
    if !stored.paired_conversations.contains(&conversation_key) {
        stored.paired_conversations.push(conversation_key.clone());
        save_configuration(&app, &stored)?;
    }
    manager
        .allow_pairing(&conversation_key)?
        .ok_or_else(|| "钉钉频道当前未运行".to_string())
}

#[tauri::command]
pub fn stop_local_im_runtime(manager: tauri::State<'_, LocalImManager>) -> Result<(), String> {
    manager.stop()
}

#[tauri::command]
pub fn remove_local_dingtalk(
    app: tauri::AppHandle,
    manager: tauri::State<'_, LocalImManager>,
) -> Result<LocalImStatus, String> {
    manager.stop()?;
    let path = configuration_path(&app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| format!("无法删除本地钉钉配置：{error}"))?;
    }
    delete_secret()?;
    Ok(stopped_status(None, false))
}

impl LocalImManager {
    fn start(
        &self,
        app: &tauri::AppHandle,
        configuration: &StoredDingTalkConfiguration,
        client_secret: String,
        context: HarnessContext,
    ) -> Result<LocalImStatus, String> {
        let profile = expert_kits::harness_profile(app, None, "")?;
        let fingerprint = RuntimeFingerprint {
            skill_directories: profile.skill_directories,
            allowed_erp_tools: Vec::new(),
            required_erp_tools: Vec::new(),
            local_file_roots: Vec::new(),
            allow_local_files: false,
            allow_shell: false,
            allow_erp_write: false,
            litellm_base_url: context.litellm_base_url,
            erp_mcp_url: context.erp_mcp_url,
            model: context.model,
            credential_digest: format!("{:x}", Sha256::digest(context.access_token.as_bytes())),
        };
        let mut guard = self
            .process
            .lock()
            .map_err(|_| "本地 IM 状态不可用".to_string())?;
        if guard
            .as_ref()
            .is_some_and(|process| process.fingerprint != fingerprint)
            && let Some(mut process) = guard.take()
        {
            process.shutdown();
        }
        if guard.is_none() {
            *guard = Some(HarnessProcess::start(
                app,
                fingerprint,
                context.access_token,
            )?);
        }
        let result = guard.as_mut().expect("IM Harness process was initialized").request(
            "im.configure",
            Some(json!({
                "clientId": configuration.client_id,
                "clientSecret": client_secret,
                "accessPolicy": match configuration.access_policy { AccessPolicy::Open => "open", AccessPolicy::Pairing => "pairing" },
                "pairedConversations": configuration.paired_conversations,
            })),
            None,
        )?;
        parse_runtime_status(result, configuration.enabled, true)
    }

    fn status(&self) -> Result<Option<LocalImStatus>, String> {
        let mut guard = self
            .process
            .lock()
            .map_err(|_| "本地 IM 状态不可用".to_string())?;
        let Some(process) = guard.as_mut() else {
            return Ok(None);
        };
        match process.request("im.status", None, None) {
            Ok(value) => parse_runtime_status(value, true, true).map(Some),
            Err(error) => {
                process.shutdown();
                *guard = None;
                Err(error)
            }
        }
    }

    fn allow_pairing(&self, conversation_key: &str) -> Result<Option<LocalImStatus>, String> {
        let mut guard = self
            .process
            .lock()
            .map_err(|_| "本地 IM 状态不可用".to_string())?;
        let Some(process) = guard.as_mut() else {
            return Ok(None);
        };
        let value = process.request(
            "im.allow-pairing",
            Some(json!({ "conversationKey": conversation_key })),
            None,
        )?;
        parse_runtime_status(value, true, true).map(Some)
    }

    fn stop(&self) -> Result<(), String> {
        let mut guard = self
            .process
            .lock()
            .map_err(|_| "本地 IM 状态不可用".to_string())?;
        if let Some(mut process) = guard.take() {
            let _ = process.request("im.stop", None, None);
            process.shutdown();
        }
        Ok(())
    }
}

fn parse_runtime_status(
    value: Value,
    enabled: bool,
    secret_configured: bool,
) -> Result<LocalImStatus, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RuntimeStatus {
        provider: String,
        configured: bool,
        connected: bool,
        state: String,
        client_id: String,
        access_policy: AccessPolicy,
        #[serde(default)]
        pending_pairings: Vec<PairingRequest>,
        last_error: Option<String>,
    }
    let status: RuntimeStatus =
        serde_json::from_value(value).map_err(|error| format!("本地 IM 状态无效：{error}"))?;
    Ok(LocalImStatus {
        provider: status.provider,
        configured: status.configured,
        enabled,
        connected: status.connected,
        state: status.state,
        client_id: status.client_id,
        secret_configured,
        access_policy: status.access_policy,
        pending_pairings: status.pending_pairings,
        last_error: status.last_error,
    })
}

fn stopped_status(
    configuration: Option<&StoredDingTalkConfiguration>,
    secret_configured: bool,
) -> LocalImStatus {
    LocalImStatus {
        provider: "DINGTALK".to_string(),
        configured: configuration.is_some(),
        enabled: configuration.is_some_and(|value| value.enabled),
        connected: false,
        state: "DISABLED".to_string(),
        client_id: configuration
            .map(|value| value.client_id.clone())
            .unwrap_or_default(),
        secret_configured,
        access_policy: configuration
            .map(|value| value.access_policy.clone())
            .unwrap_or(AccessPolicy::Pairing),
        pending_pairings: Vec::new(),
        last_error: None,
    }
}

fn configuration_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|root| root.join("im-channels/dingtalk.json"))
        .map_err(|error| format!("无法确定本地 IM 配置目录：{error}"))
}

fn load_configuration(
    app: &tauri::AppHandle,
) -> Result<Option<StoredDingTalkConfiguration>, String> {
    let path = configuration_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&path).map_err(|error| format!("无法读取本地钉钉配置：{error}"))?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| format!("本地钉钉配置无效：{error}"))
}

fn save_configuration(
    app: &tauri::AppHandle,
    value: &StoredDingTalkConfiguration,
) -> Result<(), String> {
    let path = configuration_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "本地 IM 配置路径无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建本地 IM 配置目录：{error}"))?;
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("无法生成本地钉钉配置：{error}"))?;
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("无法保存本地钉钉配置：{error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("无法保存本地钉钉配置：{error}"))?;
    fs::rename(temporary, path).map_err(|error| format!("无法提交本地钉钉配置：{error}"))
}

fn keyring_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|error| format!("无法访问系统凭据库：{error}"))
}

fn store_secret(secret: &str) -> Result<(), String> {
    keyring_entry()?
        .set_password(secret.trim())
        .map_err(|error| format!("无法保存钉钉 Client Secret：{error}"))
}

fn load_secret() -> Result<String, String> {
    keyring_entry()?
        .get_password()
        .map_err(|error| format!("无法读取钉钉 Client Secret：{error}"))
}

fn secret_exists() -> bool {
    keyring_entry()
        .and_then(|entry| entry.get_password().map_err(|error| error.to_string()))
        .is_ok()
}

fn delete_secret() -> Result<(), String> {
    match keyring_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("无法删除钉钉 Client Secret：{error}")),
    }
}

fn validate_client_id(value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        Err("钉钉 Client ID 无效".to_string())
    } else {
        Ok(())
    }
}

fn validate_client_secret(value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > 1_024 || value.chars().any(char::is_control) {
        Err("钉钉 Client Secret 无效".to_string())
    } else {
        Ok(())
    }
}

fn validate_harness_context(value: &HarnessContext) -> Result<(), String> {
    validate_http_url("LiteLLM", &value.litellm_base_url)?;
    validate_http_url("ERP MCP", &value.erp_mcp_url)?;
    if value.model.trim().is_empty() || value.model.len() > 200 {
        return Err("模型名称无效".to_string());
    }
    if value.access_token.len() > 16 * 1024 || value.access_token.chars().any(char::is_control) {
        return Err("ERP 访问凭据无效".to_string());
    }
    Ok(())
}

fn validate_http_url(name: &str, value: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(value).map_err(|error| format!("{name} 地址无效：{error}"))?;
    if matches!(url.scheme(), "http" | "https") {
        Ok(())
    } else {
        Err(format!("{name} 只允许 HTTP(S) 地址"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_im_configuration_rejects_invalid_credentials() {
        assert!(validate_client_id("").is_err());
        assert!(validate_client_secret("secret\nvalue").is_err());
        assert!(validate_client_id("ding-app").is_ok());
    }

    #[test]
    fn stopped_status_never_exposes_a_secret() {
        let config = StoredDingTalkConfiguration {
            client_id: "ding-app".to_string(),
            enabled: true,
            access_policy: AccessPolicy::Pairing,
            paired_conversations: Vec::new(),
        };
        let value = serde_json::to_value(stopped_status(Some(&config), true)).unwrap();
        assert_eq!(value["clientId"], "ding-app");
        assert_eq!(value["secretConfigured"], true);
        assert!(value.get("clientSecret").is_none());
    }
}
