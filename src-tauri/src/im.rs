use crate::{
    expert_kits,
    harness::{
        CapabilitySnapshot, HarnessProcess, RuntimeFingerprint, credential_digest,
        runtime_connectors, validate_capability_snapshot,
    },
    local_files::RuntimeLocalFileRoot,
    memory,
};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::Manager;

const KEYRING_SERVICE: &str = "com.instudio.xiaoyin.im.dingtalk";

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
    notify_task_results: bool,
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
    employee_id: String,
    team_id: String,
    litellm_base_url: String,
    knowledge_endpoint: String,
    #[serde(default)]
    schedule_endpoint: String,
    capability_snapshot: CapabilitySnapshot,
    model: String,
    model_api_key: String,
    session_token: String,
    #[serde(default)]
    allow_shell: bool,
    #[serde(default)]
    allow_lsp: bool,
    #[serde(default)]
    allow_external_agents: bool,
    #[serde(default)]
    allow_hooks: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureDingTalkRequest {
    client_id: String,
    client_secret: String,
    enabled: bool,
    access_policy: AccessPolicy,
    notify_task_results: bool,
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

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImConversationSummary {
    conversation_key: String,
    conversation_type: String,
    conversation_title: String,
    sender_nick: String,
    last_message: String,
    last_response: String,
    session_id: String,
    message_count: u64,
    status: String,
    delivery_status: Option<String>,
    pending_delivery_count: Option<u64>,
    updated_at: String,
    bound_task_id: Option<String>,
    bound_task_name: Option<String>,
    #[serde(default)]
    messages: Vec<ImConversationMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    task_projection: Option<Value>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImConversationMessage {
    id: String,
    role: String,
    text: String,
    created_at: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BindableTask {
    id: String,
    name: String,
    session_id: String,
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
    notify_task_results: bool,
    pending_pairings: Vec<PairingRequest>,
    paired_conversations: Vec<String>,
    conversations: Vec<ImConversationSummary>,
    pending_event_count: usize,
    last_heartbeat_at: Option<String>,
    last_error: Option<String>,
}

#[tauri::command]
pub async fn configure_local_dingtalk(
    app: tauri::AppHandle,
    manager: tauri::State<'_, LocalImManager>,
    request: ConfigureDingTalkRequest,
) -> Result<LocalImStatus, String> {
    validate_client_id(&request.client_id)?;
    validate_harness_context(&request.harness)?;
    crate::dingtalk_auth::require_employee(&app, &request.harness.employee_id).await?;
    let employee_id = &request.harness.employee_id;
    let existing = load_configuration(&app, employee_id)?;
    let client_id = request.client_id.trim().to_string();
    let keep_secret = retain_existing_secret(
        &client_id,
        &request.client_secret,
        existing.as_ref().map(|value| value.client_id.as_str()),
    )?;
    let secret = if keep_secret {
        load_secret(employee_id)?
    } else {
        request.client_secret.clone()
    };
    validate_client_secret(&secret)?;
    let stored = StoredDingTalkConfiguration {
        paired_conversations: existing
            .filter(|value| value.client_id == client_id)
            .map(|value| value.paired_conversations)
            .unwrap_or_default(),
        client_id,
        enabled: request.enabled,
        access_policy: request.access_policy,
        notify_task_results: request.notify_task_results,
    };
    if !keep_secret {
        store_secret(employee_id, &secret)?;
    }
    save_configuration(&app, employee_id, &stored)?;
    if !stored.enabled {
        manager.stop()?;
        return Ok(stopped_status(Some(&stored), true));
    }
    manager.start(&app, &stored, secret, request.harness)
}

fn retain_existing_secret(
    client_id: &str,
    secret: &str,
    existing_id: Option<&str>,
) -> Result<bool, String> {
    if !secret.trim().is_empty() {
        return Ok(false);
    }
    if existing_id == Some(client_id) {
        return Ok(true);
    }
    Err("新应用必须填写 Client Secret".to_string())
}

#[tauri::command]
pub async fn start_local_im(
    app: tauri::AppHandle,
    manager: tauri::State<'_, LocalImManager>,
    harness: HarnessContext,
) -> Result<LocalImStatus, String> {
    validate_harness_context(&harness)?;
    crate::dingtalk_auth::require_employee(&app, &harness.employee_id).await?;
    let Some(stored) = load_configuration(&app, &harness.employee_id)? else {
        manager.stop()?;
        return Ok(stopped_status(None, false));
    };
    if !stored.enabled {
        manager.stop()?;
        return Ok(stopped_status(
            Some(&stored),
            secret_exists(&harness.employee_id),
        ));
    }
    let secret = load_secret(&harness.employee_id)?;
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
    crate::dingtalk_auth::require_employee(&app, &harness.employee_id).await?;
    let mut stored = load_configuration(&app, &harness.employee_id)?
        .ok_or_else(|| "尚未配置钉钉频道".to_string())?;
    stored.enabled = enabled;
    save_configuration(&app, &harness.employee_id, &stored)?;
    if !enabled {
        manager.stop()?;
        return Ok(stopped_status(
            Some(&stored),
            secret_exists(&harness.employee_id),
        ));
    }
    let secret = load_secret(&harness.employee_id)?;
    manager.start(&app, &stored, secret, harness)
}

#[tauri::command]
pub async fn local_im_status(
    app: tauri::AppHandle,
    manager: tauri::State<'_, LocalImManager>,
) -> Result<LocalImStatus, String> {
    let employee_id = crate::dingtalk_auth::current_employee(&app).await?;
    if let Some(status) = manager.status(&employee_id)? {
        return Ok(status);
    }
    let stored = load_configuration(&app, &employee_id)?;
    let secret_configured = stored.is_some() && secret_exists(&employee_id);
    Ok(stopped_status(stored.as_ref(), secret_configured))
}

#[tauri::command]
pub async fn allow_local_im_pairing(
    app: tauri::AppHandle,
    manager: tauri::State<'_, LocalImManager>,
    conversation_key: String,
) -> Result<LocalImStatus, String> {
    if conversation_key.trim().is_empty() || conversation_key.len() > 1_024 {
        return Err("IM 会话标识无效".to_string());
    }
    let employee_id = crate::dingtalk_auth::current_employee(&app).await?;
    let mut stored =
        load_configuration(&app, &employee_id)?.ok_or_else(|| "尚未配置钉钉频道".to_string())?;
    if !stored.paired_conversations.contains(&conversation_key) {
        stored.paired_conversations.push(conversation_key.clone());
        save_configuration(&app, &employee_id, &stored)?;
    }
    manager
        .change_pairing(&employee_id, &conversation_key, true)
        .map(|value| {
            value.unwrap_or_else(|| stopped_status(Some(&stored), secret_exists(&employee_id)))
        })
}

#[tauri::command]
pub async fn revoke_local_im_pairing(
    app: tauri::AppHandle,
    manager: tauri::State<'_, LocalImManager>,
    conversation_key: String,
) -> Result<LocalImStatus, String> {
    validate_binding_field("IM 会话标识", &conversation_key, 1_024)?;
    let employee_id = crate::dingtalk_auth::current_employee(&app).await?;
    let mut stored =
        load_configuration(&app, &employee_id)?.ok_or_else(|| "尚未配置钉钉频道".to_string())?;
    stored
        .paired_conversations
        .retain(|key| key != &conversation_key);
    save_configuration(&app, &employee_id, &stored)?;
    manager
        .change_pairing(&employee_id, &conversation_key, false)
        .map(|value| {
            value.unwrap_or_else(|| stopped_status(Some(&stored), secret_exists(&employee_id)))
        })
}

#[tauri::command]
pub async fn bind_local_im_task(
    app: tauri::AppHandle,
    manager: tauri::State<'_, LocalImManager>,
    conversation_key: String,
    task_id: String,
    task_name: String,
    session_id: String,
) -> Result<LocalImStatus, String> {
    let employee_id = crate::dingtalk_auth::current_employee(&app).await?;
    manager
        .bind_task(
            &employee_id,
            &conversation_key,
            &task_id,
            &task_name,
            &session_id,
        )?
        .ok_or_else(|| "钉钉频道当前未运行".to_string())
}

#[tauri::command]
pub async fn unbind_local_im_task(
    app: tauri::AppHandle,
    manager: tauri::State<'_, LocalImManager>,
    conversation_key: String,
) -> Result<LocalImStatus, String> {
    let employee_id = crate::dingtalk_auth::current_employee(&app).await?;
    manager
        .unbind_task(&employee_id, &conversation_key)?
        .ok_or_else(|| "钉钉频道当前未运行".to_string())
}

#[tauri::command]
pub async fn sync_local_im_tasks(
    app: tauri::AppHandle,
    manager: tauri::State<'_, LocalImManager>,
    tasks: Vec<BindableTask>,
) -> Result<Option<LocalImStatus>, String> {
    let employee_id = crate::dingtalk_auth::current_employee(&app).await?;
    manager.sync_tasks(&employee_id, tasks)
}

#[tauri::command]
pub async fn retry_local_im_delivery(
    app: tauri::AppHandle,
    manager: tauri::State<'_, LocalImManager>,
    conversation_key: String,
) -> Result<LocalImStatus, String> {
    let employee_id = crate::dingtalk_auth::current_employee(&app).await?;
    manager
        .retry_delivery(&employee_id, &conversation_key)?
        .ok_or_else(|| "钉钉频道当前未运行".to_string())
}

#[tauri::command]
pub async fn route_local_im_schedule(
    app: tauri::AppHandle,
    manager: tauri::State<'_, LocalImManager>,
    schedule_id: String,
    conversation_key: String,
) -> Result<LocalImStatus, String> {
    let employee_id = crate::dingtalk_auth::current_employee(&app).await?;
    manager
        .route_schedule(&employee_id, &schedule_id, &conversation_key)?
        .ok_or_else(|| "钉钉频道当前未运行".to_string())
}

#[tauri::command]
pub fn stop_local_im_runtime(manager: tauri::State<'_, LocalImManager>) -> Result<(), String> {
    manager.stop()
}

#[tauri::command]
pub async fn remove_local_dingtalk(
    app: tauri::AppHandle,
    manager: tauri::State<'_, LocalImManager>,
) -> Result<LocalImStatus, String> {
    let employee_id = crate::dingtalk_auth::current_employee(&app).await?;
    manager.stop()?;
    let path = configuration_path(&app, &employee_id)?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| format!("无法删除本地钉钉配置：{error}"))?;
    }
    delete_secret(&employee_id)?;
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
        let profile = expert_kits::harness_profile(
            app,
            &context.capability_snapshot.selections,
            &context.capability_snapshot.knowledge_base_refs,
            "",
            &context.capability_snapshot.artifacts,
            &context.capability_snapshot.implicit_artifacts,
            "agent",
        )?;
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("无法确定 IM 工作目录：{error}"))?;
        let im_workspace = app_data
            .join("im-workspaces")
            .join(crate::harness::employee_namespace(&context.employee_id));
        fs::create_dir_all(&im_workspace)
            .map_err(|error| format!("无法创建 IM 工作目录：{error}"))?;
        let allow_browser = context
            .capability_snapshot
            .local_tools
            .iter()
            .any(|tool| crate::harness::is_harness_browser_tool(tool));
        let connectors =
            runtime_connectors(&context.capability_snapshot.connectors, &profile, true)?;
        let fingerprint = RuntimeFingerprint {
            skill_directories: profile.skill_directories,
            connectors,
            local_file_roots: vec![RuntimeLocalFileRoot {
                id: "local-im-workspace".to_string(),
                name: "IM 工作目录".to_string(),
                path: im_workspace.to_string_lossy().into_owned(),
            }],
            allow_browser,
            allowed_computer_tools: profile
                .allowed_computer_tools
                .into_iter()
                .filter(|tool| context.capability_snapshot.local_tools.contains(tool))
                .collect(),
            execution_mode: "agent".to_string(),
            allow_shell: context.allow_shell,
            allow_lsp: context.allow_lsp,
            allow_external_agents: context.allow_external_agents,
            allow_hooks: context.allow_hooks,
            litellm_base_url: context.litellm_base_url,
            knowledge_endpoint: context.knowledge_endpoint,
            schedule_endpoint: context.schedule_endpoint,
            employee_id: context.employee_id.clone(),
            team_id: context.team_id,
            knowledge_base_refs: profile.knowledge_base_refs,
            model: context.model,
            reasoning_effort: None,
            memory_context: memory::context(app, &context.employee_id)?,
            credential_digest: credential_digest(&context.model_api_key, &context.session_token),
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
                context.model_api_key,
                context.session_token,
            )?);
        }
        let result = guard.as_mut().expect("IM Harness process was initialized").request(
            "im.configure",
            Some(json!({
                "clientId": configuration.client_id,
                "clientSecret": client_secret,
                "accessPolicy": match configuration.access_policy { AccessPolicy::Open => "open", AccessPolicy::Pairing => "pairing" },
                "pairedConversations": configuration.paired_conversations,
                "notifyTaskResults": configuration.notify_task_results,
            })),
            None,
        )?;
        parse_runtime_status(result, configuration.enabled, true)
    }

    fn status(&self, employee_id: &str) -> Result<Option<LocalImStatus>, String> {
        let mut guard = self
            .process
            .lock()
            .map_err(|_| "本地 IM 状态不可用".to_string())?;
        if guard
            .as_ref()
            .is_some_and(|process| process.fingerprint.employee_id != employee_id)
        {
            if let Some(mut process) = guard.take() {
                process.shutdown();
            }
            return Ok(None);
        }
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

    fn change_pairing(
        &self,
        employee_id: &str,
        conversation_key: &str,
        allow: bool,
    ) -> Result<Option<LocalImStatus>, String> {
        let mut guard = self
            .process
            .lock()
            .map_err(|_| "本地 IM 状态不可用".to_string())?;
        let Some(process) = authorized_process(&mut guard, employee_id)? else {
            return Ok(None);
        };
        let value = process.request(
            if allow {
                "im.allow-pairing"
            } else {
                "im.revoke-pairing"
            },
            Some(json!({ "conversationKey": conversation_key })),
            None,
        )?;
        parse_runtime_status(value, true, true).map(Some)
    }

    fn bind_task(
        &self,
        employee_id: &str,
        conversation_key: &str,
        task_id: &str,
        task_name: &str,
        session_id: &str,
    ) -> Result<Option<LocalImStatus>, String> {
        validate_binding_field("IM 会话标识", conversation_key, 1_024)?;
        validate_binding_field("任务标识", task_id, 200)?;
        validate_binding_field("任务名称", task_name, 200)?;
        validate_binding_field("Harness 会话标识", session_id, 1_024)?;
        let mut guard = self
            .process
            .lock()
            .map_err(|_| "本地 IM 状态不可用".to_string())?;
        let Some(process) = authorized_process(&mut guard, employee_id)? else {
            return Ok(None);
        };
        let value = process.request(
            "im.bind-task",
            Some(json!({
                "conversationKey": conversation_key,
                "taskId": task_id,
                "taskName": task_name,
                "sessionId": session_id,
            })),
            None,
        )?;
        parse_runtime_status(value, true, true).map(Some)
    }

    fn unbind_task(
        &self,
        employee_id: &str,
        conversation_key: &str,
    ) -> Result<Option<LocalImStatus>, String> {
        validate_binding_field("IM 会话标识", conversation_key, 1_024)?;
        let mut guard = self
            .process
            .lock()
            .map_err(|_| "本地 IM 状态不可用".to_string())?;
        let Some(process) = authorized_process(&mut guard, employee_id)? else {
            return Ok(None);
        };
        let value = process.request(
            "im.unbind-task",
            Some(json!({ "conversationKey": conversation_key })),
            None,
        )?;
        parse_runtime_status(value, true, true).map(Some)
    }

    fn retry_delivery(
        &self,
        employee_id: &str,
        conversation_key: &str,
    ) -> Result<Option<LocalImStatus>, String> {
        validate_binding_field("IM 会话标识", conversation_key, 1_024)?;
        let mut guard = self
            .process
            .lock()
            .map_err(|_| "本地 IM 状态不可用".to_string())?;
        let Some(process) = authorized_process(&mut guard, employee_id)? else {
            return Ok(None);
        };
        let value = process.request(
            "im.retry-delivery",
            Some(json!({ "conversationKey": conversation_key })),
            None,
        )?;
        parse_runtime_status(value, true, true).map(Some)
    }

    fn sync_tasks(
        &self,
        employee_id: &str,
        tasks: Vec<BindableTask>,
    ) -> Result<Option<LocalImStatus>, String> {
        let mut guard = self
            .process
            .lock()
            .map_err(|_| "本地 IM 状态不可用".to_string())?;
        let Some(process) = authorized_process(&mut guard, employee_id)? else {
            return Ok(None);
        };
        let value = process.request("im.sync-tasks", Some(json!({ "tasks": tasks })), None)?;
        parse_runtime_status(value, true, true).map(Some)
    }

    fn route_schedule(
        &self,
        employee_id: &str,
        schedule_id: &str,
        conversation_key: &str,
    ) -> Result<Option<LocalImStatus>, String> {
        validate_binding_field("定时任务标识", schedule_id, 200)?;
        validate_binding_field("IM 会话标识", conversation_key, 1_024)?;
        let mut guard = self
            .process
            .lock()
            .map_err(|_| "本地 IM 状态不可用".to_string())?;
        let Some(process) = authorized_process(&mut guard, employee_id)? else {
            return Ok(None);
        };
        let value = process.request(
            "im.route-schedule",
            Some(json!({ "scheduleId": schedule_id, "conversationKey": conversation_key })),
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

fn authorized_process<'a>(
    guard: &'a mut Option<HarnessProcess>,
    employee_id: &str,
) -> Result<Option<&'a mut HarnessProcess>, String> {
    match guard.as_mut() {
        Some(process) if process.fingerprint.employee_id != employee_id => {
            Err("当前登录账号与 IM 运行账号不一致".to_string())
        }
        process => Ok(process),
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
        notify_task_results: bool,
        #[serde(default)]
        pending_pairings: Vec<PairingRequest>,
        #[serde(default)]
        paired_conversations: Vec<String>,
        #[serde(default)]
        conversations: Vec<ImConversationSummary>,
        #[serde(default)]
        pending_event_count: usize,
        last_heartbeat_at: Option<String>,
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
        notify_task_results: status.notify_task_results,
        pending_pairings: status.pending_pairings,
        paired_conversations: status.paired_conversations,
        conversations: status.conversations,
        pending_event_count: status.pending_event_count,
        last_heartbeat_at: status.last_heartbeat_at,
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
        notify_task_results: configuration.is_some_and(|value| value.notify_task_results),
        pending_pairings: Vec::new(),
        paired_conversations: configuration
            .map(|value| value.paired_conversations.clone())
            .unwrap_or_default(),
        conversations: Vec::new(),
        pending_event_count: 0,
        last_heartbeat_at: None,
        last_error: None,
    }
}

fn configuration_path(app: &tauri::AppHandle, employee_id: &str) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|root| configuration_path_in(&root, employee_id))
        .map_err(|error| format!("无法确定本地 IM 配置目录：{error}"))
}

fn configuration_path_in(root: &Path, employee_id: &str) -> PathBuf {
    root.join("im-channels")
        .join(crate::harness::employee_namespace(employee_id))
        .join("dingtalk.json")
}

fn load_configuration(
    app: &tauri::AppHandle,
    employee_id: &str,
) -> Result<Option<StoredDingTalkConfiguration>, String> {
    let path = configuration_path(app, employee_id)?;
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
    employee_id: &str,
    value: &StoredDingTalkConfiguration,
) -> Result<(), String> {
    let path = configuration_path(app, employee_id)?;
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
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(&path).map_err(|error| format!("无法替换本地钉钉配置：{error}"))?;
    }
    fs::rename(temporary, path).map_err(|error| format!("无法提交本地钉钉配置：{error}"))
}

fn keyring_account(employee_id: &str) -> String {
    format!(
        "client-secret-{}",
        crate::harness::employee_namespace(employee_id)
    )
}

fn keyring_entry(employee_id: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, &keyring_account(employee_id))
        .map_err(|error| format!("无法访问系统凭据库：{error}"))
}

fn store_secret(employee_id: &str, secret: &str) -> Result<(), String> {
    keyring_entry(employee_id)?
        .set_password(secret.trim())
        .map_err(|error| format!("无法保存钉钉 Client Secret：{error}"))
}

fn load_secret(employee_id: &str) -> Result<String, String> {
    keyring_entry(employee_id)?
        .get_password()
        .map_err(|error| format!("无法读取钉钉 Client Secret：{error}"))
}

fn secret_exists(employee_id: &str) -> bool {
    keyring_entry(employee_id)
        .and_then(|entry| entry.get_password().map_err(|error| error.to_string()))
        .is_ok()
}

fn delete_secret(employee_id: &str) -> Result<(), String> {
    match keyring_entry(employee_id)?.delete_credential() {
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

fn validate_binding_field(name: &str, value: &str, limit: usize) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > limit || value.chars().any(char::is_control) {
        Err(format!("{name}无效"))
    } else {
        Ok(())
    }
}

fn validate_harness_context(value: &HarnessContext) -> Result<(), String> {
    if value.employee_id.trim().is_empty()
        || value.employee_id.len() > 512
        || value.employee_id.chars().any(char::is_control)
    {
        return Err("员工标识无效".to_string());
    }
    if value.team_id.len() > 512 || value.team_id.chars().any(char::is_control) {
        return Err("团队标识无效".to_string());
    }
    validate_http_url("LiteLLM", &value.litellm_base_url)?;
    validate_http_url("知识库", &value.knowledge_endpoint)?;
    validate_http_url("定时任务", &value.schedule_endpoint)?;
    validate_capability_snapshot(&value.capability_snapshot)?;
    if value.model.trim().is_empty() || value.model.len() > 200 {
        return Err("模型名称无效".to_string());
    }
    if value.model_api_key.trim().is_empty()
        || value.model_api_key.len() > 16 * 1024
        || value.model_api_key.chars().any(char::is_control)
    {
        return Err("模型访问凭据无效".to_string());
    }
    if value.session_token.len() > 16 * 1024 || value.session_token.chars().any(char::is_control) {
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
    fn dingtalk_configuration_and_keyring_are_employee_scoped() {
        let root = Path::new("/app-data");
        let first = configuration_path_in(root, "employee-1");
        let second = configuration_path_in(root, "employee-2");
        assert_ne!(first, second);
        assert_ne!(keyring_account("employee-1"), keyring_account("employee-2"));
        assert!(!first.to_string_lossy().contains("employee-1"));
        assert!(!first.ends_with("im-channels/dingtalk.json"));
        assert_eq!(first, configuration_path_in(root, "employee-1"));
    }

    #[test]
    fn im_context_without_runtime_authorizations_is_restricted() {
        let context: HarnessContext = serde_json::from_value(json!({
            "employeeId": "employee-1",
            "teamId": "team-1",
            "litellmBaseUrl": "http://litellm.internal/v1",
            "knowledgeEndpoint": "http://xiaoyin-server.internal/api/v1/knowledge-bases",
            "capabilitySnapshot": {
                "schemaVersion": 2,
                "createdAt": "2026-09-11T00:00:00Z",
                "selections": [],
                "artifacts": [],
                "implicitArtifacts": [],
                "localTools": [],
                "requestedConnectorIds": [],
                "requestedKnowledgeBaseRefs": []
            },
            "model": "deepseek-chat",
            "modelApiKey": "model-token",
            "sessionToken": "token"
        }))
        .expect("IM context should deserialize without authorization");
        assert!(!context.allow_shell);
        assert!(!context.allow_lsp);
        assert!(!context.allow_external_agents);
        assert!(!context.allow_hooks);
    }

    #[test]
    fn empty_secret_is_retained_only_for_the_same_application() {
        assert!(retain_existing_secret("old-app", "", Some("old-app")).unwrap());
        assert!(retain_existing_secret("new-app", "", Some("old-app")).is_err());
        assert!(retain_existing_secret("new-app", "", None).is_err());
        assert!(!retain_existing_secret("new-app", "new-secret", Some("old-app")).unwrap());
    }

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
            notify_task_results: true,
            paired_conversations: Vec::new(),
        };
        let value = serde_json::to_value(stopped_status(Some(&config), true)).unwrap();
        assert_eq!(value["clientId"], "ding-app");
        assert_eq!(value["secretConfigured"], true);
        assert!(value.get("clientSecret").is_none());
    }

    #[test]
    fn delivery_failure_survives_the_native_status_bridge_without_failing_execution() {
        let status = parse_runtime_status(json!({
            "provider": "DINGTALK", "configured": true, "connected": true, "state": "DEGRADED",
            "clientId": "test", "accessPolicy": "open", "notifyTaskResults": false,
            "conversations": [{ "conversationKey": "test:private:one", "conversationType": "private",
                "conversationTitle": "验收", "senderNick": "测试员工", "lastMessage": "生成文件", "lastResponse": "文件已生成",
                "sessionId": "session", "messageCount": 1, "status": "COMPLETED", "updatedAt": "now",
                "deliveryStatus": "FAILED", "pendingDeliveryCount": 1,
                "messages": [{ "id": "reply", "role": "assistant", "text": "文件已生成",
                    "createdAt": "now" }] }]
        }), true, true).unwrap();
        let value = serde_json::to_value(status).unwrap();
        assert_eq!(value["conversations"][0]["status"], "COMPLETED");
        assert_eq!(value["conversations"][0]["deliveryStatus"], "FAILED");
        assert_eq!(value["conversations"][0]["pendingDeliveryCount"], 1);
        assert!(value["conversations"][0].get("outcome").is_none());
        assert!(
            value["conversations"][0]["messages"][0]
                .get("outcome")
                .is_none()
        );
    }
}
