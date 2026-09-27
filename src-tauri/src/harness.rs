pub(crate) use crate::harness_connectors::{
    ConnectorDefinition, RuntimeConnector, runtime_connectors,
};
use crate::harness_connectors::{
    diagnostic_connectors, validate_connector_catalog, validate_http_url,
};
use crate::{
    expert_kits,
    local_files::{LocalFileAuthorizations, RuntimeLocalFileRoot},
    memory,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread::JoinHandle,
    time::Duration,
};
use tauri::{Emitter, Listener, Manager};

/// A finished task keeps its harness process warm so the next turn starts quickly, but only this
/// many idle ones are worth the memory. How many tasks run at once is the employee's call, the way
/// it is when they open another terminal, so a running task is never refused a slot.
const WARM_IDLE_HARNESS_SLOTS: usize = 3;

impl HarnessManager {
    fn check_task_owner(&self, task_id: &str, employee_id: &str) -> Result<(), String> {
        let slot = self
            .slots
            .lock()
            .map_err(|_| "任务状态不可用")?
            .get(task_id)
            .cloned();
        if let Some(slot) = slot {
            slot.check_owner(employee_id)?;
        }
        Ok(())
    }

    pub(crate) fn begin_operation_review(
        &self,
        task_id: &str,
        employee_id: &str,
    ) -> Result<impl Drop + use<>, String> {
        let slot = self.slot(task_id)?;
        slot.check_owner(employee_id)?;
        slot.begin()
    }

    /// A running task holds absolute paths into the extension directories it was started with,
    /// so callers that delete installed content wait until no slot is executing.
    pub(crate) fn has_running_task(&self) -> bool {
        self.slots
            .lock()
            .map_or(true, |slots| slots.values().any(|slot| slot.is_running()))
    }
}

/// Desktop turn intents shared between a task slot and its live process.
#[derive(Clone, Default)]
pub(crate) struct TurnIntents {
    /// Employee messages to inject into the running turn. The run loop drains
    /// this at each Harness notification, which is exactly the step cadence the
    /// agent consumes steering input at.
    steer_inbox: Arc<Mutex<Vec<String>>>,
    /// Set by the desktop stop button; the run loop forwards it as one
    /// `session.interrupt` so the turn settles with its partial receipts.
    interrupt_requested: Arc<AtomicBool>,
}

#[derive(Default)]
struct HarnessSlot {
    process: Mutex<Option<HarnessProcess>>,
    active: Mutex<Option<ActiveRun>>,
    owner: Mutex<Option<String>>,
    intents: TurnIntents,
}

#[derive(Default)]
struct ActiveRun {
    pid: Option<u32>,
    canceled: bool,
}

struct ActiveRunGuard(Arc<HarnessSlot>);

impl Drop for ActiveRunGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = self.0.active.lock() {
            *active = None;
        }
    }
}

impl HarnessSlot {
    fn begin_for(self: &Arc<Self>, employee_id: &str) -> Result<ActiveRunGuard, String> {
        let mut owner = self.owner.lock().map_err(|_| "任务归属不可用")?;
        if owner.as_ref().is_some_and(|value| value != employee_id) {
            return Err("当前登录账号与任务归属不一致".to_string());
        }
        let guard = self.begin()?;
        *owner = Some(employee_id.to_string());
        Ok(guard)
    }

    fn check_owner(&self, employee_id: &str) -> Result<(), String> {
        let owner = self.owner.lock().map_err(|_| "任务归属不可用")?;
        if owner.as_ref().is_some_and(|value| value != employee_id) {
            Err("当前登录账号与任务归属不一致".to_string())
        } else {
            Ok(())
        }
    }

    fn begin(self: &Arc<Self>) -> Result<ActiveRunGuard, String> {
        let mut active = self.active.lock().map_err(|_| "任务状态不可用")?;
        if active.is_some() {
            return Err("当前任务仍在执行".to_string());
        }
        // A slot keeps its process warm between turns. Clear intents before the
        // new run becomes visible so a stop/steer arriving at the old turn's
        // boundary cannot leak into the next task.
        self.intents
            .interrupt_requested
            .store(false, Ordering::SeqCst);
        self.intents
            .steer_inbox
            .lock()
            .map_err(|_| "插话队列不可用")?
            .clear();
        *active = Some(ActiveRun::default());
        Ok(ActiveRunGuard(Arc::clone(self)))
    }

    fn queue_steer(&self, text: String) -> Result<bool, String> {
        let active = self.active.lock().map_err(|_| "任务状态不可用")?;
        if active.is_none() {
            return Ok(false);
        }
        let mut inbox = self
            .intents
            .steer_inbox
            .lock()
            .map_err(|_| "插话队列不可用")?;
        // A person typing mid-turn cannot outpace the agent; bound the queue so
        // a runaway caller cannot grow it without limit.
        if inbox.len() >= 20 {
            return Err("插话过于频繁，请等待当前步骤完成".to_string());
        }
        inbox.push(text);
        Ok(true)
    }

    fn request_interrupt(&self) -> Result<bool, String> {
        let active = self.active.lock().map_err(|_| "任务状态不可用")?;
        if active.is_none() {
            return Ok(false);
        }
        self.intents
            .interrupt_requested
            .store(true, Ordering::SeqCst);
        Ok(true)
    }

    fn is_running(&self) -> bool {
        self.active.lock().map_or(true, |active| active.is_some())
    }

    fn register_process(&self, pid: u32) -> Result<(), String> {
        let mut active = self.active.lock().map_err(|_| "任务状态不可用")?;
        let run = active.as_mut().ok_or("任务未登记")?;
        if run.canceled {
            return Err("本轮已停止".to_string());
        }
        run.pid = Some(pid);
        Ok(())
    }

    fn cancel(self: &Arc<Self>) -> Result<bool, String> {
        let mut active = self.active.lock().map_err(|_| "任务状态不可用")?;
        let Some(run) = active.as_mut() else {
            return Ok(false);
        };
        if run.canceled {
            return Ok(true);
        }
        // Serialize cancellation with process registration so startup cannot miss a stop.
        // Harness runs in an isolated process group; kill the group immediately so
        // the desktop stop action cannot remain pending on a model or connector.
        if let Some(pid) = run.pid {
            terminate_process(pid)?;
        }
        run.canceled = true;
        Ok(true)
    }
}

#[derive(Clone, Default)]
pub struct HarnessManager {
    slots: Arc<Mutex<HashMap<String, Arc<HarnessSlot>>>>,
    approvals: Arc<ApprovalBroker>,
    questions: Arc<QuestionBroker>,
}

#[derive(Default)]
struct ApprovalBroker {
    pending: Mutex<HashMap<String, PendingApproval>>,
}

struct PendingApproval {
    task_id: String,
    sender: mpsc::Sender<String>,
}

#[derive(Default)]
struct QuestionBroker {
    pending: Mutex<HashMap<(String, String), PendingQuestion>>,
}

struct PendingQuestion {
    sender: mpsc::Sender<Vec<QuestionAnswerInput>>,
}

struct InteractionBrokers {
    approval: Arc<ApprovalBroker>,
    question: Arc<QuestionBroker>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuestionAnswerInput {
    id: String,
    #[serde(default)]
    selected: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    custom: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessRunRequest {
    operation_scope: String,
    task_id: String,
    prompt: String,
    execution_mode: String,
    #[serde(default)]
    allow_shell: bool,
    #[serde(default)]
    allow_lsp: bool,
    #[serde(default)]
    allow_external_agents: bool,
    #[serde(default)]
    allow_hooks: bool,
    employee_id: String,
    team_id: String,
    session_id: Option<String>,
    capability_snapshot: CapabilitySnapshot,
    litellm_base_url: String,
    knowledge_endpoint: String,
    #[serde(default)]
    schedule_endpoint: String,
    model: String,
    #[serde(default)]
    reasoning_effort: Option<String>,
    model_api_key: String,
    session_token: String,
    #[serde(default)]
    local_file_root_ids: Vec<String>,
    #[serde(default)]
    attachments: Vec<LocalTaskAttachment>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CapabilitySnapshot {
    pub(crate) schema_version: u8,
    pub(crate) created_at: String,
    pub(crate) selections: Vec<expert_kits::CapabilitySelection>,
    pub(crate) artifacts: Vec<expert_kits::AllowedExtensionArtifact>,
    pub(crate) implicit_artifacts: Vec<expert_kits::AllowedExtensionArtifact>,
    pub(crate) local_tools: Vec<String>,
    pub(crate) requested_connector_ids: Vec<String>,
    #[serde(default)]
    pub(crate) connectors: Vec<ConnectorDefinition>,
    pub(crate) requested_knowledge_base_refs: Vec<String>,
    #[serde(default)]
    pub(crate) knowledge_base_refs: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalTaskAttachment {
    root_id: String,
    root_name: String,
    path: String,
    name: String,
    kind: String,
    media_type: Option<String>,
    #[serde(default, rename = "id")]
    _id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HarnessImageInput {
    data_base64: String,
    media_type: String,
    name: String,
}

struct HarnessTurnInput {
    operation_scope: String,
    prompt: String,
    session_id: Option<String>,
    images: Vec<HarnessImageInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorDiagnosticRequest {
    employee_id: String,
    #[serde(default)]
    connectors: Vec<ConnectorDefinition>,
    session_token: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessRunResult {
    session_id: String,
    final_response: String,
}

/// Stable error envelope returned by the Tauri command. The desktop must not
/// infer retry policy from localized text.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessCommandError {
    code: String,
    category: String,
    title: String,
    detail: String,
    infrastructure: bool,
    retryable: bool,
}

impl HarnessCommandError {
    fn from_message(message: String) -> Self {
        if let Ok(value) = serde_json::from_str::<Self>(&message)
            && value.is_valid()
        {
            return value;
        }
        Self {
            code: "XY-UNSTRUCTURED-ERROR".to_string(),
            category: "unknown".to_string(),
            title: "任务执行失败".to_string(),
            detail: message,
            infrastructure: false,
            retryable: false,
        }
    }

    fn is_valid(&self) -> bool {
        self.code.starts_with("XY-")
            && self.code.len() <= 120
            && self
                .code
                .chars()
                .all(|value| value.is_ascii_uppercase() || value.is_ascii_digit() || value == '-')
            && matches!(
                self.category.as_str(),
                "timeout"
                    | "authentication"
                    | "capacity"
                    | "permission"
                    | "connector"
                    | "local-agent"
                    | "model"
                    | "unknown"
            )
            && !self.title.is_empty()
            && !self.detail.is_empty()
    }
}

impl From<String> for HarnessCommandError {
    fn from(value: String) -> Self {
        Self::from_message(value)
    }
}

impl From<&str> for HarnessCommandError {
    fn from(value: &str) -> Self {
        Self::from_message(value.to_string())
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorDiagnosticResult {
    id: String,
    status: String,
    latency_ms: u64,
    discovered_tools: Vec<String>,
    missing_tools: Vec<String>,
    undeclared_tools: Vec<String>,
    error: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalCapabilityCheck {
    key: String,
    passed: bool,
    detail: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalCapabilitySelfTestResult {
    status: String,
    checks: Vec<LocalCapabilityCheck>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessHostHealth {
    status: String,
    runtime: String,
    version: String,
    #[serde(default)]
    capabilities: HashMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HarnessProviderCheckRequest {
    litellm_base_url: String,
    model: String,
    model_api_key: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessProviderCheckResult {
    status: String,
    latency_ms: u64,
    detail: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessSessionInspection {
    session_id: String,
    status: String,
    updated_at: String,
    #[serde(default)]
    last_event_type: Option<String>,
    pending_tools: u32,
    #[serde(default)]
    projection: Option<Value>,
    /// Durable Harness Session events consumed by the official browser
    /// Conversation assembler. Keep this separate from product projections.
    #[serde(default)]
    events: Vec<Value>,
    #[serde(default)]
    messages: Vec<Value>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessSessionSearchHit {
    session_id: String,
    excerpt: String,
    updated_at: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessSessionSearchPage {
    items: Vec<HarnessSessionSearchHit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    next_cursor: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HarnessUiNotification {
    task_id: String,
    request_id: u64,
    stream_id: String,
    sequence: u64,
    event: Value,
}

fn ui_notification(
    task_id: &str,
    request_id: u64,
    stream_id: &str,
    sequence: u64,
    event: Value,
) -> HarnessUiNotification {
    HarnessUiNotification {
        task_id: task_id.to_string(),
        request_id,
        stream_id: stream_id.to_string(),
        sequence,
        event,
    }
}

#[derive(Clone, Eq, PartialEq, Serialize)]
pub(crate) struct RuntimeFingerprint {
    pub(crate) skill_directories: Vec<String>,
    pub(crate) connectors: Vec<RuntimeConnector>,
    pub(crate) local_file_roots: Vec<RuntimeLocalFileRoot>,
    pub(crate) allow_browser: bool,
    pub(crate) allowed_computer_tools: Vec<String>,
    pub(crate) execution_mode: String,
    pub(crate) allow_shell: bool,
    pub(crate) allow_lsp: bool,
    pub(crate) allow_external_agents: bool,
    pub(crate) allow_hooks: bool,
    pub(crate) litellm_base_url: String,
    pub(crate) knowledge_endpoint: String,
    pub(crate) schedule_endpoint: String,
    pub(crate) employee_id: String,
    pub(crate) team_id: String,
    pub(crate) knowledge_base_refs: Option<Vec<String>>,
    pub(crate) model: String,
    pub(crate) reasoning_effort: Option<String>,
    pub(crate) memory_context: String,
    pub(crate) credential_digest: String,
}

pub(crate) struct HarnessProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: mpsc::Receiver<Result<String, String>>,
    stdout_reader: Option<JoinHandle<()>>,
    stderr_tail: Arc<Mutex<String>>,
    stderr_reader: Option<JoinHandle<()>>,
    next_id: u64,
    notification_task_id: String,
    approval_broker: Option<Arc<ApprovalBroker>>,
    question_broker: Option<Arc<QuestionBroker>>,
    intents: TurnIntents,
    current_session_id: Option<String>,
    pub(crate) fingerprint: RuntimeFingerprint,
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct HarnessRuntimePaths {
    pub(crate) node: PathBuf,
    pub(crate) entry: PathBuf,
    config: PathBuf,
    primary_runtime: PathBuf,
}

#[tauri::command]
pub async fn run_harness(
    app: tauri::AppHandle,
    manager: tauri::State<'_, HarnessManager>,
    local_files: tauri::State<'_, LocalFileAuthorizations>,
    request: HarnessRunRequest,
) -> Result<HarnessRunResult, HarnessCommandError> {
    validate_run_request(&request)?;
    crate::dingtalk_auth::require_employee(&app, &request.employee_id).await?;
    local_files.ensure_employee(&request.employee_id)?;
    let active_run = manager
        .slot(&request.task_id)?
        .begin_for(&request.employee_id)?;
    let (attachment_context, images) = prepare_attachments(&local_files, &request.attachments)?;
    let user_prompt = if attachment_context.is_empty() {
        request.prompt.trim().to_string()
    } else {
        format!("{}\n\n{}", request.prompt.trim(), attachment_context)
    };
    let profile = expert_kits::harness_profile(
        &app,
        &request.capability_snapshot.selections,
        &request.capability_snapshot.knowledge_base_refs,
        &user_prompt,
        &request.capability_snapshot.artifacts,
        &request.capability_snapshot.implicit_artifacts,
        &request.execution_mode,
    )?;
    // An empty selection intentionally means the official Harness filesystem:
    // it is backed by the employee-isolated session workspace. Product roots
    // are only forwarded when the user explicitly authorizes directories.
    let local_file_roots = if request.local_file_root_ids.is_empty() {
        Vec::new()
    } else {
        local_files.resolve(&request.local_file_root_ids)?
    };
    let allow_browser = request
        .capability_snapshot
        .local_tools
        .iter()
        .any(|tool| tool.starts_with("browser_"));
    let connectors = runtime_connectors(&request.capability_snapshot.connectors, &profile, true)?;
    let fingerprint = RuntimeFingerprint {
        skill_directories: profile.skill_directories,
        connectors,
        local_file_roots,
        allow_browser,
        allowed_computer_tools: profile
            .allowed_computer_tools
            .into_iter()
            .filter(|tool| request.capability_snapshot.local_tools.contains(tool))
            .collect(),
        execution_mode: request.execution_mode,
        allow_shell: request.allow_shell,
        allow_lsp: request.allow_lsp,
        allow_external_agents: request.allow_external_agents,
        allow_hooks: request.allow_hooks,
        litellm_base_url: request.litellm_base_url,
        knowledge_endpoint: request.knowledge_endpoint,
        schedule_endpoint: request.schedule_endpoint,
        employee_id: request.employee_id.clone(),
        team_id: request.team_id,
        knowledge_base_refs: profile.knowledge_base_refs,
        model: request.model,
        reasoning_effort: request.reasoning_effort,
        memory_context: memory::context(&app, &request.employee_id)?,
        credential_digest: credential_digest(&request.model_api_key, &request.session_token),
    };
    let turn = HarnessTurnInput {
        operation_scope: request.operation_scope,
        prompt: profile.prompt,
        session_id: request.session_id,
        images,
    };
    let model_api_key = request.model_api_key;
    let session_token = request.session_token;
    let task_id = request.task_id;
    let manager = manager.inner().clone();
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let _active_run = active_run;
        manager.run(
            &task_id,
            &app,
            fingerprint,
            turn,
            model_api_key,
            session_token,
        )
    })
    .await
    .map_err(|error| format!("Harness 执行线程异常：{error}"))??)
}

#[tauri::command]
pub async fn shutdown_harness(
    app: tauri::AppHandle,
    manager: tauri::State<'_, HarnessManager>,
    task_id: Option<String>,
) -> Result<(), HarnessCommandError> {
    if let Some(task_id) = task_id.as_deref() {
        let employee_id = crate::dingtalk_auth::current_employee(&app).await?;
        manager.check_task_owner(task_id, &employee_id)?;
    }
    let manager = manager.inner().clone();
    Ok(
        tauri::async_runtime::spawn_blocking(move || manager.shutdown(task_id.as_deref()))
            .await
            .map_err(|error| format!("Harness 关闭线程异常：{error}"))??,
    )
}

#[tauri::command]
pub async fn cancel_harness(
    app: tauri::AppHandle,
    manager: tauri::State<'_, HarnessManager>,
    task_id: String,
) -> Result<bool, HarnessCommandError> {
    let employee_id = crate::dingtalk_auth::current_employee(&app).await?;
    manager.check_task_owner(&task_id, &employee_id)?;
    Ok(manager.cancel(&task_id)?)
}

#[tauri::command]
pub async fn respond_harness_approval(
    app: tauri::AppHandle,
    manager: tauri::State<'_, HarnessManager>,
    task_id: String,
    approval_id: String,
    decision: String,
) -> Result<bool, HarnessCommandError> {
    let employee_id = crate::dingtalk_auth::current_employee(&app).await?;
    manager.check_task_owner(&task_id, &employee_id)?;
    Ok(manager.respond_to_approval(&task_id, &approval_id, &decision)?)
}

#[tauri::command]
pub async fn respond_harness_question(
    app: tauri::AppHandle,
    manager: tauri::State<'_, HarnessManager>,
    task_id: String,
    question_id: String,
    answers: Vec<QuestionAnswerInput>,
) -> Result<bool, HarnessCommandError> {
    let employee_id = crate::dingtalk_auth::current_employee(&app).await?;
    manager.check_task_owner(&task_id, &employee_id)?;
    Ok(manager.respond_to_question(&task_id, &question_id, answers)?)
}

#[tauri::command]
pub async fn steer_harness(
    app: tauri::AppHandle,
    manager: tauri::State<'_, HarnessManager>,
    task_id: String,
    prompt: String,
) -> Result<bool, HarnessCommandError> {
    let employee_id = crate::dingtalk_auth::current_employee(&app).await?;
    manager.check_task_owner(&task_id, &employee_id)?;
    Ok(manager.steer(&task_id, &prompt)?)
}

#[tauri::command]
pub async fn interrupt_harness(
    app: tauri::AppHandle,
    manager: tauri::State<'_, HarnessManager>,
    task_id: String,
) -> Result<bool, HarnessCommandError> {
    let employee_id = crate::dingtalk_auth::current_employee(&app).await?;
    manager.check_task_owner(&task_id, &employee_id)?;
    Ok(manager.interrupt(&task_id)?)
}

#[tauri::command]
pub async fn fork_harness(
    app: tauri::AppHandle,
    manager: tauri::State<'_, HarnessManager>,
    task_id: String,
) -> Result<String, HarnessCommandError> {
    let employee_id = crate::dingtalk_auth::current_employee(&app).await?;
    manager.check_task_owner(&task_id, &employee_id)?;
    Ok(manager.fork(&task_id)?)
}

#[tauri::command]
pub async fn diagnose_connectors(
    app: tauri::AppHandle,
    request: ConnectorDiagnosticRequest,
) -> Result<Vec<ConnectorDiagnosticResult>, HarnessCommandError> {
    validate_access_token(&request.session_token)?;
    crate::dingtalk_auth::require_employee(&app, &request.employee_id).await?;
    let connectors = diagnostic_connectors(&request.connectors)?;
    if connectors.is_empty() {
        return Ok(Vec::new());
    }
    let fingerprint = RuntimeFingerprint {
        skill_directories: Vec::new(),
        connectors,
        local_file_roots: Vec::new(),
        allow_browser: false,
        allowed_computer_tools: Vec::new(),
        execution_mode: "agent".to_string(),
        allow_shell: true,
        allow_lsp: true,
        allow_external_agents: false,
        allow_hooks: false,
        litellm_base_url: String::new(),
        knowledge_endpoint: String::new(),
        schedule_endpoint: String::new(),
        employee_id: request.employee_id,
        team_id: String::new(),
        knowledge_base_refs: Some(Vec::new()),
        model: "connector-diagnostics".to_string(),
        reasoning_effort: None,
        memory_context: String::new(),
        credential_digest: credential_digest("", &request.session_token),
    };
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let mut process = HarnessProcess::start_uninitialized(
            &app,
            fingerprint,
            String::new(),
            request.session_token,
        )?;
        let result = process.request("connectors.diagnose", None, None);
        process.shutdown();
        serde_json::from_value(result?).map_err(|error| format!("连接器诊断结果无效：{error}"))
    })
    .await
    .map_err(|error| format!("连接器诊断线程异常：{error}"))??)
}

#[tauri::command]
pub async fn self_test_local_capabilities(
    app: tauri::AppHandle,
    include_computer: Option<bool>,
) -> Result<LocalCapabilitySelfTestResult, HarnessCommandError> {
    crate::dingtalk_auth::current_employee(&app).await?;
    let fingerprint = RuntimeFingerprint {
        skill_directories: Vec::new(),
        connectors: Vec::new(),
        local_file_roots: Vec::new(),
        allow_browser: false,
        allowed_computer_tools: Vec::new(),
        execution_mode: "agent".to_string(),
        allow_shell: true,
        allow_lsp: true,
        allow_external_agents: false,
        allow_hooks: false,
        litellm_base_url: String::new(),
        knowledge_endpoint: String::new(),
        schedule_endpoint: String::new(),
        employee_id: String::new(),
        team_id: String::new(),
        knowledge_base_refs: Some(Vec::new()),
        model: "capability-self-test".to_string(),
        reasoning_effort: None,
        memory_context: String::new(),
        credential_digest: credential_digest("", ""),
    };
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let mut process =
            HarnessProcess::start_uninitialized(&app, fingerprint, String::new(), String::new())?;
        let method = if include_computer.unwrap_or(true) {
            "host.self-test"
        } else {
            "host.inventory-check"
        };
        let result = process.request(method, None, None);
        process.shutdown();
        serde_json::from_value(result?).map_err(|error| format!("本地能力自检结果无效：{error}"))
    })
    .await
    .map_err(|error| format!("本地能力自检线程异常：{error}"))??)
}

#[tauri::command]
pub async fn probe_harness_host(
    app: tauri::AppHandle,
    model_configured: Option<bool>,
    allow_shell: Option<bool>,
    allow_lsp: Option<bool>,
    allow_external_agents: Option<bool>,
    allow_hooks: Option<bool>,
) -> Result<HarnessHostHealth, HarnessCommandError> {
    crate::dingtalk_auth::current_employee(&app).await?;
    let fingerprint = RuntimeFingerprint {
        skill_directories: Vec::new(),
        connectors: Vec::new(),
        local_file_roots: Vec::new(),
        allow_browser: false,
        allowed_computer_tools: Vec::new(),
        execution_mode: "agent".to_string(),
        allow_shell: allow_shell.unwrap_or(false),
        allow_lsp: allow_lsp.unwrap_or(false),
        allow_external_agents: allow_external_agents.unwrap_or(false),
        allow_hooks: allow_hooks.unwrap_or(false),
        litellm_base_url: String::new(),
        knowledge_endpoint: String::new(),
        schedule_endpoint: String::new(),
        employee_id: String::new(),
        team_id: String::new(),
        knowledge_base_refs: Some(Vec::new()),
        model: "host-health-probe".to_string(),
        reasoning_effort: None,
        memory_context: String::new(),
        credential_digest: credential_digest("", ""),
    };
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let mut process =
            HarnessProcess::start_uninitialized(&app, fingerprint, String::new(), String::new())?;
        // A health response is only meaningful after the same initialization
        // handshake used by real task executions. Otherwise a broken plugin
        // graph can report `ready` here and fail only on the first task.
        if let Err(error) = process.request("host.initialize", None, None) {
            process.shutdown();
            return Err(format!("Harness Host 初始化失败：{error}"));
        }
        let result = process.request("host.health", None, None);
        process.shutdown();
        let mut health: HarnessHostHealth = serde_json::from_value(result?)
            .map_err(|error| format!("Harness Host 健康响应无效：{error}"))?;
        // The probe deliberately starts without credentials. Carry only the
        // already-known configuration bit from the desktop, never the secret,
        // so the UI can distinguish missing setup from provider reachability.
        health.capabilities.insert(
            "modelProvider".to_string(),
            if model_configured.unwrap_or(false) {
                "gated".to_string()
            } else {
                "unconfigured".to_string()
            },
        );
        // The probe intentionally omits secrets, so the Host cannot infer
        // whether the DeepSeek-backed web providers are configured. Preserve
        // the already-known desktop configuration bit without exposing it.
        if model_configured.unwrap_or(false) {
            for capability in ["webSearch", "webFetch"] {
                if health
                    .capabilities
                    .get(capability)
                    .is_some_and(|value| value == "unconfigured")
                {
                    health
                        .capabilities
                        .insert(capability.to_string(), "gated".to_string());
                }
            }
        }
        Ok(health)
    })
    .await
    .map_err(|error| format!("Harness Host 健康检查线程异常：{error}"))??)
}

#[tauri::command]
pub async fn check_harness_provider(
    app: tauri::AppHandle,
    request: HarnessProviderCheckRequest,
) -> Result<HarnessProviderCheckResult, HarnessCommandError> {
    crate::dingtalk_auth::current_employee(&app).await?;
    validate_http_url("模型", &request.litellm_base_url)?;
    if request.model.trim().is_empty() || request.model.len() > 512 {
        return Err("模型标识无效".to_string().into());
    }
    if request.model_api_key.trim().is_empty()
        || request.model_api_key.len() > 16 * 1024
        || request.model_api_key.chars().any(char::is_control)
    {
        return Err("模型凭据无效".to_string().into());
    }
    let fingerprint = RuntimeFingerprint {
        skill_directories: Vec::new(),
        connectors: Vec::new(),
        local_file_roots: Vec::new(),
        allow_browser: false,
        allowed_computer_tools: Vec::new(),
        execution_mode: "agent".to_string(),
        allow_shell: true,
        allow_lsp: true,
        allow_external_agents: false,
        allow_hooks: false,
        litellm_base_url: request.litellm_base_url,
        knowledge_endpoint: String::new(),
        schedule_endpoint: String::new(),
        employee_id: String::new(),
        team_id: String::new(),
        knowledge_base_refs: Some(Vec::new()),
        model: request.model,
        reasoning_effort: None,
        memory_context: String::new(),
        credential_digest: credential_digest(&request.model_api_key, ""),
    };
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let mut process = HarnessProcess::start_uninitialized(
            &app,
            fingerprint,
            request.model_api_key,
            String::new(),
        )?;
        let result = process.request("provider.check", None, None);
        process.shutdown();
        serde_json::from_value(result?).map_err(|error| format!("模型服务检查响应无效：{error}"))
    })
    .await
    .map_err(|error| format!("模型服务检查线程异常：{error}"))??)
}

#[tauri::command]
pub async fn inspect_harness_session(
    app: tauri::AppHandle,
    employee_id: String,
    session_id: String,
) -> Result<Option<HarnessSessionInspection>, HarnessCommandError> {
    validate_employee_id(&employee_id)?;
    if !is_valid_session_id(&session_id) {
        return Err("Harness 会话标识无效".to_string().into());
    }
    crate::dingtalk_auth::require_employee(&app, &employee_id).await?;
    let fingerprint = RuntimeFingerprint {
        skill_directories: Vec::new(),
        connectors: Vec::new(),
        local_file_roots: Vec::new(),
        allow_browser: false,
        allowed_computer_tools: Vec::new(),
        execution_mode: "agent".to_string(),
        allow_shell: true,
        allow_lsp: true,
        allow_external_agents: false,
        allow_hooks: false,
        litellm_base_url: String::new(),
        knowledge_endpoint: String::new(),
        schedule_endpoint: String::new(),
        employee_id,
        team_id: String::new(),
        knowledge_base_refs: Some(Vec::new()),
        model: "session-inspection".to_string(),
        reasoning_effort: None,
        memory_context: String::new(),
        credential_digest: credential_digest("", ""),
    };
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let mut process =
            HarnessProcess::start_uninitialized(&app, fingerprint, String::new(), String::new())?;
        let result = process.request(
            "session.inspect",
            Some(json!({ "sessionId": session_id })),
            None,
        );
        process.shutdown();
        match result? {
            Value::Null => Ok(None),
            value => serde_json::from_value(value)
                .map(Some)
                .map_err(|error| format!("Harness 会话摘要无效：{error}")),
        }
    })
    .await
    .map_err(|error| format!("Harness 会话检查线程异常：{error}"))??)
}

#[tauri::command]
pub async fn search_harness_sessions(
    app: tauri::AppHandle,
    employee_id: String,
    session_ids: Vec<String>,
    query: String,
    limit: Option<u32>,
    cursor: Option<String>,
) -> Result<HarnessSessionSearchPage, HarnessCommandError> {
    validate_employee_id(&employee_id)?;
    if session_ids.len() > 2_000 || session_ids.iter().any(|id| !is_valid_session_id(id)) {
        return Err("Harness 会话标识无效".to_string().into());
    }
    crate::dingtalk_auth::require_employee(&app, &employee_id).await?;
    if query.trim().is_empty() || query.len() > 500 {
        return Err("Harness 历史搜索词无效".to_string().into());
    }
    if cursor
        .as_ref()
        .is_some_and(|value| value.is_empty() || value.len() > 8_192)
    {
        return Err("Harness 历史搜索游标无效".to_string().into());
    }
    let fingerprint = RuntimeFingerprint {
        skill_directories: Vec::new(),
        connectors: Vec::new(),
        local_file_roots: Vec::new(),
        allow_browser: false,
        allowed_computer_tools: Vec::new(),
        execution_mode: "agent".to_string(),
        allow_shell: true,
        allow_lsp: true,
        allow_external_agents: false,
        allow_hooks: false,
        litellm_base_url: String::new(),
        knowledge_endpoint: String::new(),
        schedule_endpoint: String::new(),
        employee_id,
        team_id: String::new(),
        knowledge_base_refs: Some(Vec::new()),
        model: "session-search".to_string(),
        reasoning_effort: None,
        memory_context: String::new(),
        credential_digest: credential_digest("", ""),
    };
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let mut process =
            HarnessProcess::start_uninitialized(&app, fingerprint, String::new(), String::new())?;
        let result = process.request(
            "session.search",
            Some(
                json!({ "sessionIds": session_ids, "query": query, "limit": limit.unwrap_or(100), "cursor": cursor }),
            ),
            None,
        );
        process.shutdown();
        serde_json::from_value(result?)
            .map_err(|error| format!("Harness 历史搜索响应无效：{error}"))
    })
    .await
    .map_err(|error| format!("Harness 历史搜索线程异常：{error}"))??)
}

impl HarnessManager {
    fn run(
        &self,
        task_id: &str,
        app: &tauri::AppHandle,
        fingerprint: RuntimeFingerprint,
        turn: HarnessTurnInput,
        model_api_key: String,
        session_token: String,
    ) -> Result<HarnessRunResult, String> {
        let slot = self.slot(task_id)?;
        let mut guard = slot
            .process
            .lock()
            .map_err(|_| "Harness 进程状态不可用".to_string())?;
        if fingerprint_changed(
            guard.as_ref().map(|process| &process.fingerprint),
            &fingerprint,
        ) && let Some(mut process) = guard.take()
        {
            process.shutdown();
        }
        let needs_initialize = guard.is_none();
        if needs_initialize {
            *guard = Some(HarnessProcess::start_for_task(
                app,
                task_id,
                fingerprint,
                model_api_key,
                session_token,
                slot.intents.clone(),
                InteractionBrokers {
                    approval: Arc::clone(&self.approvals),
                    question: Arc::clone(&self.questions),
                },
            )?);
        }
        let process = guard.as_mut().expect("Harness process was initialized");
        let result = slot.register_process(process.child.id()).and_then(|()| {
            if needs_initialize {
                process.request("host.initialize", None, None)?;
            }
            process.run(task_id, app, turn)
        });
        match result {
            Ok(result) => Ok(result),
            Err(error) => {
                process.kill();
                *guard = None;
                Err(error)
            }
        }
    }

    fn slot(&self, task_id: &str) -> Result<Arc<HarnessSlot>, String> {
        if task_id.is_empty() || task_id.len() > 200 {
            return Err("Harness 任务标识无效".to_string());
        }
        let mut evicted = Vec::new();
        let slot = {
            let mut slots = self
                .slots
                .lock()
                .map_err(|_| "Harness 任务池不可用".to_string())?;
            if let Some(slot) = slots.get(task_id) {
                return Ok(Arc::clone(slot));
            }
            let idle = slots
                .iter()
                .filter(|(_, slot)| !slot.is_running())
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            for id in idle.into_iter().skip(WARM_IDLE_HARNESS_SLOTS) {
                evicted.extend(slots.remove(&id));
            }
            let slot = Arc::new(HarnessSlot::default());
            slots.insert(task_id.to_string(), Arc::clone(&slot));
            slot
        };
        for evicted in evicted {
            if let Ok(mut process) = evicted.process.lock()
                && let Some(mut process) = process.take()
            {
                process.shutdown();
            }
        }
        Ok(slot)
    }

    fn shutdown(&self, task_id: Option<&str>) -> Result<(), String> {
        match task_id {
            Some(task_id) => {
                self.approvals.reject_task(task_id);
                self.questions.reject_task(task_id);
            }
            None => {
                self.approvals.reject_all();
                self.questions.reject_all();
            }
        }
        let slots = {
            let mut current = self
                .slots
                .lock()
                .map_err(|_| "Harness 任务池不可用".to_string())?;
            match task_id {
                Some(task_id) => current.remove(task_id).into_iter().collect::<Vec<_>>(),
                None => current.drain().map(|(_, slot)| slot).collect::<Vec<_>>(),
            }
        };
        for slot in slots {
            let _ = slot.cancel();
            if let Ok(mut process) = slot.process.lock()
                && let Some(mut process) = process.take()
            {
                process.shutdown();
            }
        }
        Ok(())
    }

    fn cancel(&self, task_id: &str) -> Result<bool, String> {
        self.approvals.reject_task(task_id);
        self.questions.reject_task(task_id);
        let slot = self
            .slots
            .lock()
            .map_err(|_| "Harness 任务池不可用".to_string())?
            .get(task_id)
            .cloned();
        let Some(slot) = slot else { return Ok(false) };
        slot.cancel()
    }

    /// Queue one employee message for the running turn. The live run loop
    /// forwards it to the agent at its next step boundary.
    fn steer(&self, task_id: &str, text: &str) -> Result<bool, String> {
        if text.trim().is_empty() {
            return Err("插话内容不能为空".to_string());
        }
        let slot = self
            .slots
            .lock()
            .map_err(|_| "Harness 任务池不可用".to_string())?
            .get(task_id)
            .cloned();
        let Some(slot) = slot else { return Ok(false) };
        slot.queue_steer(text.trim().to_string())
    }

    /// Fork the task's session before its last prompt and return the new id.
    /// Called between turns, so it takes the process directly instead of the
    /// run loop's intent channel.
    fn fork(&self, task_id: &str) -> Result<String, String> {
        let slot = self
            .slots
            .lock()
            .map_err(|_| "Harness 任务池不可用".to_string())?
            .get(task_id)
            .cloned()
            .ok_or("该任务没有可重新生成的会话")?;
        if slot.is_running() {
            return Err("请等待当前轮结束后再重新生成".to_string());
        }
        let mut guard = slot
            .process
            .lock()
            .map_err(|_| "Harness 进程状态不可用".to_string())?;
        let process = guard.as_mut().ok_or("该任务没有可重新生成的会话")?;
        let session_id = process
            .current_session_id
            .clone()
            .ok_or("该任务还没有可重新生成的会话")?;
        let result = process.request(
            "session.fork",
            Some(json!({ "sessionId": session_id })),
            None,
        )?;
        let forked = result
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or("重新生成未返回新的会话")?;
        process.current_session_id = Some(forked.to_string());
        Ok(forked.to_string())
    }

    /// Ask the running turn to stop while keeping its partial results.
    fn interrupt(&self, task_id: &str) -> Result<bool, String> {
        let slot = self
            .slots
            .lock()
            .map_err(|_| "Harness 任务池不可用".to_string())?
            .get(task_id)
            .cloned();
        let Some(slot) = slot else { return Ok(false) };
        if !slot.request_interrupt()? {
            return Ok(false);
        }
        // A question or approval can block the stdout reader indefinitely;
        // releasing its broker lets the run loop observe cancellation now.
        self.questions.reject_task(task_id);
        self.approvals.reject_task(task_id);
        Ok(true)
    }

    fn respond_to_approval(
        &self,
        task_id: &str,
        approval_id: &str,
        decision: &str,
    ) -> Result<bool, String> {
        if !matches!(decision, "allow" | "reject") {
            return Err("授权决定无效".to_string());
        }
        self.approvals.respond(task_id, approval_id, decision)
    }

    fn respond_to_question(
        &self,
        task_id: &str,
        question_id: &str,
        answers: Vec<QuestionAnswerInput>,
    ) -> Result<bool, String> {
        validate_question_answers(&answers)?;
        self.questions.respond(task_id, question_id, answers)
    }
}

impl ApprovalBroker {
    fn register(&self, task_id: &str, approval_id: &str) -> Result<mpsc::Receiver<String>, String> {
        let (sender, receiver) = mpsc::channel();
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "Harness 授权状态不可用".to_string())?;
        if pending.contains_key(approval_id) {
            return Err("Harness 授权请求重复".to_string());
        }
        pending.insert(
            approval_id.to_string(),
            PendingApproval {
                task_id: task_id.to_string(),
                sender,
            },
        );
        Ok(receiver)
    }

    fn respond(&self, task_id: &str, approval_id: &str, decision: &str) -> Result<bool, String> {
        let mut approvals = self
            .pending
            .lock()
            .map_err(|_| "Harness 授权状态不可用".to_string())?;
        let Some(owner) = approvals
            .get(approval_id)
            .map(|value| value.task_id.clone())
        else {
            return Ok(false);
        };
        if owner != task_id {
            return Err("授权请求不属于当前任务".to_string());
        }
        let pending = approvals
            .remove(approval_id)
            .expect("approval was checked above");
        Ok(pending.sender.send(decision.to_string()).is_ok())
    }

    fn reject_task(&self, task_id: &str) {
        let pending = self.pending.lock();
        let Ok(mut pending) = pending else { return };
        let approval_ids = pending
            .iter()
            .filter(|(_, value)| value.task_id == task_id)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for approval_id in approval_ids {
            if let Some(value) = pending.remove(&approval_id) {
                let _ = value.sender.send("reject".to_string());
            }
        }
    }

    fn reject_all(&self) {
        let pending = self.pending.lock();
        let Ok(mut pending) = pending else { return };
        for (_, value) in pending.drain() {
            let _ = value.sender.send("reject".to_string());
        }
    }

    fn remove(&self, approval_id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(approval_id);
        }
    }
}

impl QuestionBroker {
    fn register(
        &self,
        task_id: &str,
        question_id: &str,
    ) -> Result<mpsc::Receiver<Vec<QuestionAnswerInput>>, String> {
        let (sender, receiver) = mpsc::channel();
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "Harness 问题状态不可用".to_string())?;
        let key = (task_id.to_string(), question_id.to_string());
        if pending.contains_key(&key) {
            return Err("Harness 问题请求重复".to_string());
        }
        pending.insert(key, PendingQuestion { sender });
        Ok(receiver)
    }

    fn respond(
        &self,
        task_id: &str,
        question_id: &str,
        answers: Vec<QuestionAnswerInput>,
    ) -> Result<bool, String> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "Harness 问题状态不可用".to_string())?;
        let key = (task_id.to_string(), question_id.to_string());
        let Some(request) = pending.remove(&key) else {
            if pending.keys().any(|(_, id)| id == question_id) {
                return Err("问题请求不属于当前任务".to_string());
            }
            return Ok(false);
        };
        Ok(request.sender.send(answers).is_ok())
    }

    fn reject_task(&self, task_id: &str) {
        let Ok(mut pending) = self.pending.lock() else {
            return;
        };
        pending.retain(|(owner, _), _| owner != task_id);
    }

    fn reject_all(&self) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.clear();
        }
    }

    fn remove(&self, task_id: &str, question_id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&(task_id.to_string(), question_id.to_string()));
        }
    }
}

fn terminate_process(pid: u32) -> Result<bool, String> {
    signal_process(pid, true)
}

fn signal_process(pid: u32, force: bool) -> Result<bool, String> {
    if pid == 0 {
        return Err("无效的任务进程".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        let _ = force;
        let mut command = Command::new("taskkill");
        command.creation_flags(0x0800_0000);
        let status = command
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| format!("无法取消当前任务：{error}"))?;
        Ok(status.success())
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Let the SDK dispose its detached tool handles first. Escalation targets
        // only the isolated task group if shutdown does not settle in time.
        let target = if force {
            format!("-{pid}")
        } else {
            pid.to_string()
        };
        let status = Command::new("kill")
            .args([if force { "-KILL" } else { "-TERM" }, "--", &target])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| format!("无法取消当前任务：{error}"))?;
        Ok(status.success())
    }
}

struct HarnessStartOptions<'a> {
    initialize: bool,
    task_id: Option<&'a str>,
    interaction_brokers: Option<InteractionBrokers>,
    intents: TurnIntents,
}

impl HarnessProcess {
    pub(crate) fn start(
        app: &tauri::AppHandle,
        fingerprint: RuntimeFingerprint,
        model_api_key: String,
        session_token: String,
    ) -> Result<Self, String> {
        Self::start_internal(
            app,
            fingerprint,
            model_api_key,
            session_token,
            HarnessStartOptions {
                initialize: true,
                task_id: None,
                interaction_brokers: None,
                intents: TurnIntents::default(),
            },
        )
    }

    fn start_for_task(
        app: &tauri::AppHandle,
        task_id: &str,
        fingerprint: RuntimeFingerprint,
        model_api_key: String,
        session_token: String,
        intents: TurnIntents,
        brokers: InteractionBrokers,
    ) -> Result<Self, String> {
        Self::start_internal(
            app,
            fingerprint,
            model_api_key,
            session_token,
            HarnessStartOptions {
                initialize: false,
                task_id: Some(task_id),
                interaction_brokers: Some(brokers),
                intents,
            },
        )
    }

    fn start_uninitialized(
        app: &tauri::AppHandle,
        fingerprint: RuntimeFingerprint,
        model_api_key: String,
        session_token: String,
    ) -> Result<Self, String> {
        Self::start_internal(
            app,
            fingerprint,
            model_api_key,
            session_token,
            HarnessStartOptions {
                initialize: false,
                task_id: None,
                interaction_brokers: None,
                intents: TurnIntents::default(),
            },
        )
    }

    fn start_internal(
        app: &tauri::AppHandle,
        fingerprint: RuntimeFingerprint,
        model_api_key: String,
        session_token: String,
        options: HarnessStartOptions<'_>,
    ) -> Result<Self, String> {
        let HarnessStartOptions {
            initialize,
            task_id,
            interaction_brokers,
            intents,
        } = options;
        let runtime = resolve_runtime_paths(app)?;
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("无法确定 Harness 数据目录：{error}"))?;
        let dsh_home = employee_harness_root(&app_data, &fingerprint.employee_id);
        let browser_home = task_id.map(|task_id| {
            let mut hasher = Sha256::new();
            hasher.update(fingerprint.employee_id.as_bytes());
            hasher.update([0]);
            hasher.update(task_id.as_bytes());
            app_data
                .join("harness-browser")
                .join(format!("{:x}", hasher.finalize()))
        });
        let workspace = app_data
            .join("workspaces")
            .join(employee_namespace(&fingerprint.employee_id));
        std::fs::create_dir_all(&dsh_home)
            .and_then(|_| std::fs::create_dir_all(&workspace))
            .map_err(|error| format!("无法创建 Harness 数据目录：{error}"))?;
        let session_workspace = fingerprint
            .local_file_roots
            .first()
            .map(|root| dunce::simplified(Path::new(&root.path)).to_path_buf())
            .filter(|path| path.is_dir())
            .unwrap_or_else(|| workspace.clone());

        let skill_directories = serde_json::to_string(&fingerprint.skill_directories)
            .map_err(|error| format!("无法生成技能配置：{error}"))?;
        let resolved_connectors = resolve_connector_credentials(
            app,
            &fingerprint.connectors,
            &fingerprint.employee_id,
            &session_token,
        )?;
        let connectors = serde_json::to_string(&resolved_connectors)
            .map_err(|error| format!("无法生成连接器配置：{error}"))?;
        let local_file_roots = serde_json::to_string(&fingerprint.local_file_roots)
            .map_err(|error| format!("无法生成本地文件授权配置：{error}"))?;
        let knowledge_base_refs = serde_json::to_string(&fingerprint.knowledge_base_refs)
            .map_err(|error| format!("无法生成知识库范围配置：{error}"))?;
        let computer_tools = serde_json::to_string(&fingerprint.allowed_computer_tools)
            .map_err(|error| format!("无法生成 Computer Use 工具配置：{error}"))?;
        let mut command = Command::new(&runtime.node);
        #[cfg(unix)]
        command.process_group(0);
        #[cfg(target_os = "windows")]
        command.creation_flags(0x0800_0000);
        let mut child = command
            .arg(&runtime.entry)
            .current_dir(&session_workspace)
            .env("DSH_CORDIS_CONFIG", &runtime.config)
            .env("DSH_BUNDLED_PRIMARY_RUNTIME", &runtime.primary_runtime)
            .env("DSH_CWD", &session_workspace)
            .env("DSH_HOME", &dsh_home)
            .env("DSH_SESSION_ROOT", dsh_home.join("sessions"))
            .envs(
                task_id
                    .map(|id| {
                        crate::task_operations::journal_path(app, &fingerprint.employee_id, id)
                    })
                    .transpose()?
                    .into_iter()
                    .flat_map(|path| {
                        [
                            ("XIAOYIN_OPERATION_SCOPE_FILE", path.with_extension("scope")),
                            ("XIAOYIN_OPERATION_JOURNAL", path),
                        ]
                    }),
            )
            .env(
                "XIAOYIN_IM_STATE_PATH",
                app_data
                    .join("im-channels")
                    .join(employee_namespace(&fingerprint.employee_id))
                    .join("dingtalk-sessions.json"),
            )
            .env("DSH_CUSTOM_SKILL_DIRS", skill_directories)
            .env("XIAOYIN_EXECUTION_MODE", &fingerprint.execution_mode)
            .env(
                "DSH_PERMISSION_MODE",
                if fingerprint.execution_mode == "plan" {
                    "read-only"
                } else {
                    "workspace-write"
                },
            )
            .env("XIAOYIN_ALLOW_SHELL", fingerprint.allow_shell.to_string())
            .env("XIAOYIN_ALLOW_LSP", fingerprint.allow_lsp.to_string())
            .env(
                "XIAOYIN_ALLOW_EXTERNAL_AGENTS",
                fingerprint.allow_external_agents.to_string(),
            )
            .env("XIAOYIN_ALLOW_HOOKS", fingerprint.allow_hooks.to_string())
            .env("XIAOYIN_MCP_CONNECTORS", connectors)
            // The official preset is declared once in cordis.yml. Capability
            // filtering remains process-scoped through the official Harness
            // permission/profile environment; no second dynamic preset
            // registry is created by the desktop bridge.
            .env("XIAOYIN_CONTROL_PLANE_TOKEN", &session_token)
            .env(
                "XIAOYIN_EMPLOYEE_BEARER_TOKEN",
                crate::dingtalk_auth::connector_bearer_token(
                    &fingerprint.employee_id,
                    &session_token,
                ),
            )
            .env("XIAOYIN_EMPLOYEE_ID", &fingerprint.employee_id)
            .env("XIAOYIN_TEAM_ID", &fingerprint.team_id)
            .env(
                "XIAOYIN_KNOWLEDGE_ENDPOINT",
                &fingerprint.knowledge_endpoint,
            )
            .env("XIAOYIN_SCHEDULE_ENDPOINT", &fingerprint.schedule_endpoint)
            .env("XIAOYIN_KNOWLEDGE_BASE_REFS", knowledge_base_refs)
            .env("XIAOYIN_LOCAL_FILE_ROOTS", local_file_roots)
            .envs(browser_home.as_ref().map(|path| {
                (
                    "XIAOYIN_BROWSER_PROFILE_DIR",
                    path.join("profile").into_os_string(),
                )
            }))
            .envs(browser_home.as_ref().map(|path| {
                (
                    "XIAOYIN_BROWSER_DOWNLOAD_DIR",
                    path.join("downloads").into_os_string(),
                )
            }))
            .env(
                "XIAOYIN_ALLOW_BROWSER",
                fingerprint.allow_browser.to_string(),
            )
            .env("XIAOYIN_COMPUTER_USE_TOOLS", computer_tools)
            .env("DEEPSEEK_BASE_URL", &fingerprint.litellm_base_url)
            .env("DEEPSEEK_API_KEY", model_api_key)
            .env("DSH_MODEL", &fingerprint.model)
            .env(
                "DSH_REASONING_EFFORT",
                fingerprint.reasoning_effort.as_deref().unwrap_or(""),
            )
            .env("XIAOYIN_MEMORY_CONTEXT", &fingerprint.memory_context)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("无法启动 Harness Host：{error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "无法连接 Harness stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "无法连接 Harness stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "无法连接 Harness stderr".to_string())?;
        let stderr_tail = Arc::new(Mutex::new(String::new()));
        let stderr_reader = Some(capture_stderr(stderr, Arc::clone(&stderr_tail)));
        let (stdout, stdout_reader) = capture_stdout(stdout);
        let (approval_broker, question_broker) = interaction_brokers
            .map(|brokers| (Some(brokers.approval), Some(brokers.question)))
            .unwrap_or_default();
        let mut process = Self {
            child,
            stdin,
            stdout,
            stdout_reader: Some(stdout_reader),
            stderr_tail,
            stderr_reader,
            next_id: 1,
            notification_task_id: String::new(),
            intents,
            current_session_id: None,
            fingerprint,
            approval_broker,
            question_broker,
        };
        if initialize {
            process.request("host.initialize", None, None)?;
        }
        Ok(process)
    }

    fn run(
        &mut self,
        task_id: &str,
        app: &tauri::AppHandle,
        turn: HarnessTurnInput,
    ) -> Result<HarnessRunResult, String> {
        self.notification_task_id = task_id.to_string();
        let scope_path =
            crate::task_operations::journal_path(app, &self.fingerprint.employee_id, task_id)?
                .with_extension("scope");
        std::fs::create_dir_all(scope_path.parent().ok_or("任务记录目录无效")?)
            .and_then(|_| std::fs::write(&scope_path, &turn.operation_scope))
            .map_err(|_| "无法保存任务执行标识")?;
        let mut params = json!({ "prompt": turn.prompt, "images": turn.images });
        if let Some(session_id) = turn.session_id {
            params["sessionId"] = Value::String(session_id.clone());
            self.current_session_id = Some(session_id);
        }
        let result = self.request("session.run", Some(params), Some(app))?;
        serde_json::from_value(result).map_err(|error| format!("Harness 结果无效：{error}"))
    }

    pub(crate) fn request(
        &mut self,
        method: &str,
        params: Option<Value>,
        app: Option<&tauri::AppHandle>,
    ) -> Result<Value, String> {
        let request_id = self.next_id;
        self.next_id += 1;
        let request = json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params,
        });
        serde_json::to_writer(&mut self.stdin, &request)
            .map_err(|error| format!("无法序列化 Harness 请求：{error}"))?;
        self.stdin
            .write_all(b"\n")
            .and_then(|_| self.stdin.flush())
            .map_err(|error| format!("无法向 Harness 发送请求：{error}"))?;

        let notification_stream_id = uuid::Uuid::new_v4().to_string();
        let mut notification_sequence = 0_u64;
        let mut pending_question_ack: Option<(u64, String, Vec<QuestionAnswerInput>)> = None;

        loop {
            self.deliver_pending_turn_intents()?;
            let line = match self.stdout.recv_timeout(Duration::from_millis(100)) {
                Ok(Ok(line)) => line,
                Ok(Err(error)) => {
                    return Err(structured_wire_error(
                        "XY-LOCAL-AGENT",
                        "local-agent",
                        "本地 Agent 异常",
                        &format!("无法读取 Harness 响应：{error}"),
                        true,
                        true,
                    ));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => String::new(),
            };
            if line.is_empty() {
                let status = self.child.try_wait().ok().flatten();
                if status.is_some() {
                    self.finish_stderr_capture();
                    self.finish_stdout_capture();
                }
                let detail = self
                    .stderr_tail
                    .lock()
                    .map(|value| value.clone())
                    .unwrap_or_default();
                return Err(structured_wire_error(
                    "XY-LOCAL-AGENT",
                    "local-agent",
                    "本地 Agent 异常",
                    &unexpected_exit_message(status, &detail),
                    true,
                    true,
                ));
            }
            let output: Value = serde_json::from_str(&line)
                .map_err(|error| format!("Harness 输出不是有效 JSON-RPC：{error}"))?;
            if output.get("method").is_some() {
                if matches!(
                    output.get("method").and_then(Value::as_str),
                    Some("schedule.request" | "skill.request")
                ) {
                    let domain = if output["method"] == "skill.request" {
                        "skill"
                    } else {
                        "schedule"
                    };
                    let params = output.get("params").cloned().unwrap_or(Value::Null);
                    let id = params
                        .get("requestId")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if id.is_empty() || id.len() > 100 {
                        return Err("桌面工具请求标识无效".into());
                    }
                    let result = if let Some(app) = app {
                        let (sender, receiver) = mpsc::channel::<Value>();
                        let listener =
                            app.listen(format!("xiaoyin://{domain}-response/{id}"), move |event| {
                                if let Ok(value) = serde_json::from_str(event.payload()) {
                                    let _ = sender.send(value);
                                }
                            });
                        let _ = app.emit(
                            &format!("xiaoyin://{domain}-request"),
                            json!({
                                "taskId": self.notification_task_id, "request": params
                            }),
                        );
                        let result = receiver.recv_timeout(Duration::from_secs(if domain == "skill" { 90 } else { 12 }))
                            .unwrap_or_else(|_| json!({"error": "桌面未确认操作结果，请先查询状态，不要直接重复操作"}));
                        app.unlisten(listener);
                        result
                    } else {
                        json!({"error": "此操作需要小胤桌面保持运行"})
                    };
                    serde_json::to_writer(
                        &mut self.stdin,
                        &json!({
                            "jsonrpc": "2.0", "id": null, "method": format!("{domain}.respond"),
                            "params": {"requestId": id, "result": result}
                        }),
                    )
                    .map_err(|e| e.to_string())?;
                    self.stdin
                        .write_all(b"\n")
                        .and_then(|_| self.stdin.flush())
                        .map_err(|e| e.to_string())?;
                    continue;
                }
                if output.get("method").and_then(Value::as_str) == Some("approval.request") {
                    let approval = parse_approval_request(output.get("params"))?;
                    let decision = if let (Some(app), Some(broker)) = (app, &self.approval_broker) {
                        let receiver =
                            broker.register(&self.notification_task_id, &approval.approval_id)?;
                        let event = json!({
                            "event": {
                                "method": "session.event",
                                "params": { "event": {
                                    "type": "approval/request",
                                    "data": {
                                        "approvalId": approval.approval_id,
                                        "name": approval.tool_name,
                                        "reason": approval.reason
                                    }
                                }}
                            }
                        });
                        let _ = app.emit("xiaoyin://harness-notification", {
                            notification_sequence += 1;
                            ui_notification(
                                &self.notification_task_id,
                                request_id,
                                &notification_stream_id,
                                notification_sequence,
                                event,
                            )
                        });
                        match receiver.recv_timeout(Duration::from_secs(5 * 60)) {
                            Ok(decision) => decision,
                            Err(_) => {
                                broker.remove(&approval.approval_id);
                                "reject".to_string()
                            }
                        }
                    } else {
                        "reject".to_string()
                    };
                    self.send_approval_response(&approval.approval_id, &decision)?;
                    if let Some(app) = app {
                        let event = json!({
                            "event": {
                                "method": "session.event",
                                "params": { "event": {
                                    "type": "approval/decision",
                                    "data": {
                                        "approvalId": approval.approval_id,
                                        "name": approval.tool_name,
                                        "decision": decision
                                    }
                                }}
                            }
                        });
                        let _ = app.emit("xiaoyin://harness-notification", {
                            notification_sequence += 1;
                            ui_notification(
                                &self.notification_task_id,
                                request_id,
                                &notification_stream_id,
                                notification_sequence,
                                event,
                            )
                        });
                    }
                    continue;
                }
                if output.get("method").and_then(Value::as_str) == Some("question.request") {
                    let question = parse_question_request(output.get("params"))?;
                    let answers = if let (Some(app), Some(broker)) = (app, &self.question_broker) {
                        let receiver =
                            broker.register(&self.notification_task_id, &question.question_id)?;
                        let event = json!({
                            "event": {
                                "method": "session.event",
                                "params": { "event": {
                                    "type": "question/request",
                                    "data": {
                                        "questionId": question.question_id,
                                        "questions": question.questions
                                    }
                                }}
                            }
                        });
                        let _ = app.emit("xiaoyin://harness-notification", {
                            notification_sequence += 1;
                            ui_notification(
                                &self.notification_task_id,
                                request_id,
                                &notification_stream_id,
                                notification_sequence,
                                event,
                            )
                        });
                        match receiver.recv_timeout(Duration::from_secs(30 * 60)) {
                            Ok(answers) => answers,
                            Err(_) => {
                                broker.remove(&self.notification_task_id, &question.question_id);
                                return Err(structured_wire_error(
                                    "XY-QUESTION-TIMEOUT",
                                    "timeout",
                                    "等待问题回答超时",
                                    "等待问题回答超时，本轮已停止",
                                    false,
                                    false,
                                ));
                            }
                        }
                    } else {
                        return Err("当前界面不能回答 Harness 问题".to_string());
                    };
                    let response_id =
                        self.send_question_response(&question.question_id, &answers)?;
                    pending_question_ack = Some((response_id, question.question_id, answers));
                    continue;
                }
                if let Some(app) = app {
                    // Preserve the method envelope for product-level Harness
                    // projections. Older session events intentionally keep
                    // their compact params shape for the existing renderer.
                    let event = if output.get("method").and_then(Value::as_str)
                        == Some("session.projection")
                    {
                        json!({
                            "method": "session.projection",
                            "params": output.get("params").cloned().unwrap_or(Value::Null),
                        })
                    } else {
                        output.get("params").cloned().unwrap_or(Value::Null)
                    };
                    let _ = app.emit("xiaoyin://harness-notification", {
                        notification_sequence += 1;
                        ui_notification(
                            &self.notification_task_id,
                            request_id,
                            &notification_stream_id,
                            notification_sequence,
                            event,
                        )
                    });
                }
                continue;
            }
            if let Some((response_id, question_id, answers)) = pending_question_ack.as_ref()
                && output.get("id").and_then(Value::as_u64) == Some(*response_id)
            {
                if output.get("error").is_some() {
                    return Err("问题回答未被 Agent 接收，请重新发起本轮任务".to_string());
                }
                if let Some(app) = app {
                    let event = json!({
                        "event": {
                            "method": "session.event",
                            "params": { "event": {
                                "type": "question/answered",
                                "data": { "questionId": question_id, "answers": answers }
                            }}
                        }
                    });
                    let _ = app.emit("xiaoyin://harness-notification", {
                        notification_sequence += 1;
                        ui_notification(
                            &self.notification_task_id,
                            request_id,
                            &notification_stream_id,
                            notification_sequence,
                            event,
                        )
                    });
                }
                pending_question_ack = None;
                continue;
            }
            if output.get("id").and_then(Value::as_u64) != Some(request_id) {
                continue;
            }
            if let Some(error) = output.get("error") {
                let data = error.get("data").cloned().unwrap_or_else(|| json!({
                    "code": "XY-HOST-ERROR",
                    "category": "unknown",
                    "title": "Harness 执行失败",
                    "detail": error.get("message").and_then(Value::as_str).unwrap_or("Harness 执行失败"),
                    "infrastructure": false,
                    "retryable": false,
                }));
                return Err(
                    serde_json::to_string(&data).unwrap_or_else(|_| "Harness 执行失败".to_string())
                );
            }
            return output
                .get("result")
                .cloned()
                .ok_or_else(|| "Harness 响应缺少 result".to_string());
        }
    }

    /// Forward employee turn intents queued by the desktop. The run loop wakes
    /// on every Harness notification, the same step cadence the agent claims
    /// steering input at. Responses carry unmatched ids and are skipped below.
    fn deliver_pending_turn_intents(&mut self) -> Result<(), String> {
        let session_id = self.current_session_id.clone();
        let Some(session_id) = session_id else {
            return Ok(());
        };
        if self
            .intents
            .interrupt_requested
            .swap(false, Ordering::SeqCst)
        {
            self.write_request(
                "session.interrupt",
                json!({ "sessionId": session_id.clone() }),
            )?;
        }
        let pending: Vec<String> = match self.intents.steer_inbox.lock() {
            Ok(mut inbox) => std::mem::take(&mut *inbox),
            Err(_) => Vec::new(),
        };
        for text in pending {
            self.write_request(
                "session.steer",
                json!({ "sessionId": session_id.clone(), "text": text }),
            )?;
        }
        Ok(())
    }

    /// Write one fire-and-forget request. Its response is filtered out by the
    /// request loop's id check, so no pending-response bookkeeping is needed.
    fn write_request(&mut self, method: &str, params: Value) -> Result<(), String> {
        let request_id = self.next_id;
        self.next_id += 1;
        let request = json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params,
        });
        serde_json::to_writer(&mut self.stdin, &request)
            .map_err(|error| format!("无法序列化 Harness 请求：{error}"))?;
        self.stdin
            .write_all(b"\n")
            .and_then(|_| self.stdin.flush())
            .map_err(|error| format!("无法向 Harness 发送请求：{error}"))
    }

    fn send_approval_response(&mut self, approval_id: &str, decision: &str) -> Result<(), String> {
        let request_id = self.next_id;
        self.next_id += 1;
        let request = json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "approval.respond",
            "params": { "approvalId": approval_id, "decision": decision },
        });
        serde_json::to_writer(&mut self.stdin, &request)
            .map_err(|error| format!("无法序列化 Harness 授权响应：{error}"))?;
        self.stdin
            .write_all(b"\n")
            .and_then(|_| self.stdin.flush())
            .map_err(|error| format!("无法向 Harness 发送授权响应：{error}"))
    }

    fn send_question_response(
        &mut self,
        question_id: &str,
        answers: &[QuestionAnswerInput],
    ) -> Result<u64, String> {
        let request_id = self.next_id;
        self.next_id += 1;
        let request = json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "question.respond",
            "params": { "questionId": question_id, "answers": answers },
        });
        serde_json::to_writer(&mut self.stdin, &request)
            .map_err(|error| format!("无法序列化 Harness 问题响应：{error}"))?;
        self.stdin
            .write_all(b"\n")
            .and_then(|_| self.stdin.flush())
            .map_err(|error| format!("无法向 Harness 发送问题响应：{error}"))?;
        Ok(request_id)
    }

    pub(crate) fn shutdown(&mut self) {
        let _ = self.request("host.shutdown", None, None);
        self.kill();
    }

    fn kill(&mut self) {
        let _ = terminate_process(self.child.id());
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.finish_stdout_capture();
        self.finish_stderr_capture();
    }

    fn finish_stdout_capture(&mut self) {
        if let Some(reader) = self.stdout_reader.take() {
            let _ = reader.join();
        }
    }

    fn finish_stderr_capture(&mut self) {
        if let Some(reader) = self.stderr_reader.take() {
            let _ = reader.join();
        }
    }
}

const MAX_HARNESS_STDERR_CHARS: usize = 16 * 1024;
const MAX_HARNESS_ERROR_CHARS: usize = 1_200;

fn capture_stdout<R: Read + Send + 'static>(
    stdout: R,
) -> (mpsc::Receiver<Result<String, String>>, JoinHandle<()>) {
    let (sender, receiver) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut stdout = BufReader::new(stdout);
        loop {
            let mut line = String::new();
            match stdout.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    if sender.send(Ok(line)).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    let _ = sender.send(Err(error.to_string()));
                    break;
                }
            }
        }
    });
    (receiver, reader)
}

fn capture_stderr<R>(mut stderr: R, tail: Arc<Mutex<String>>) -> JoinHandle<()>
where
    R: Read + Send + 'static,
{
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        while let Ok(bytes) = stderr.read(&mut buffer) {
            if bytes == 0 {
                break;
            }
            let chunk = String::from_utf8_lossy(&buffer[..bytes]);
            let Ok(mut output) = tail.lock() else {
                break;
            };
            output.push_str(&chunk);
            let count = output.chars().count();
            if count > MAX_HARNESS_STDERR_CHARS {
                *output = output
                    .chars()
                    .skip(count - MAX_HARNESS_STDERR_CHARS)
                    .collect();
            }
        }
    })
}

fn unexpected_exit_message(status: Option<std::process::ExitStatus>, stderr: &str) -> String {
    let status = status
        .and_then(|value| value.code())
        .map(|value| format!("（退出码 {value}）"))
        .unwrap_or_default();
    let detail = sanitize_harness_error(stderr);
    if detail.is_empty() {
        format!("Harness Host 意外退出{status}")
    } else {
        format!("Harness Host 意外退出{status}：{detail}")
    }
}

fn structured_wire_error(
    code: &str,
    category: &str,
    title: &str,
    detail: &str,
    infrastructure: bool,
    retryable: bool,
) -> String {
    serde_json::to_string(&json!({
        "code": code,
        "category": category,
        "title": title,
        "detail": detail,
        "infrastructure": infrastructure,
        "retryable": retryable,
    }))
    .unwrap_or_else(|_| detail.to_string())
}

fn sanitize_harness_error(value: &str) -> String {
    let lines = value
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let safe = redact_secret_prefixes(&lines)
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    let count = safe.chars().count();
    if count > MAX_HARNESS_ERROR_CHARS {
        format!(
            "…{}",
            safe.chars()
                .skip(count - MAX_HARNESS_ERROR_CHARS)
                .collect::<String>()
        )
    } else {
        safe
    }
}

fn redact_secret_prefixes(value: &str) -> String {
    let mut output = value.to_string();
    for prefix in ["sk-"] {
        let mut offset = 0;
        while let Some(relative) = output[offset..].find(prefix) {
            let start = offset + relative;
            let end = output[start..]
                .char_indices()
                .skip(prefix.chars().count())
                .find(|(_, character)| {
                    !(character.is_ascii_alphanumeric()
                        || matches!(character, '-' | '_' | '.' | '~' | '+' | '/' | '='))
                })
                .map(|(index, _)| start + index)
                .unwrap_or(output.len());
            output.replace_range(start..end, "[REDACTED]");
            offset = start + "[REDACTED]".len();
        }
    }
    output
}

#[derive(Debug, Eq, PartialEq)]
struct ApprovalPrompt {
    approval_id: String,
    tool_name: String,
    reason: String,
}

#[derive(Debug, PartialEq)]
struct QuestionPrompt {
    question_id: String,
    questions: Value,
}

fn parse_approval_request(params: Option<&Value>) -> Result<ApprovalPrompt, String> {
    let value = params.ok_or_else(|| "Harness 授权请求缺少参数".to_string())?;
    let approval_id = value
        .get("approvalId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 200)
        .ok_or_else(|| "Harness 授权请求 ID 无效".to_string())?;
    let tool_name = value
        .get("toolName")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 200)
        .ok_or_else(|| "Harness 授权工具名称无效".to_string())?;
    let reason = value
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("该操作需要员工确认。");
    Ok(ApprovalPrompt {
        approval_id: approval_id.to_string(),
        tool_name: sanitize_dialog_text(tool_name, 200),
        reason: sanitize_dialog_text(reason, 8 * 1024),
    })
}

fn parse_question_request(params: Option<&Value>) -> Result<QuestionPrompt, String> {
    let value = params.ok_or_else(|| "Harness 问题请求缺少参数".to_string())?;
    let question_id = value
        .get("questionId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 200)
        .ok_or_else(|| "Harness 问题请求 ID 无效".to_string())?;
    let questions = value
        .get("questions")
        .and_then(Value::as_array)
        .filter(|value| !value.is_empty() && value.len() <= 3)
        .ok_or_else(|| "Harness 问题内容无效".to_string())?;
    let mut question_ids = HashSet::new();
    for question in questions {
        let question = question
            .as_object()
            .ok_or_else(|| "Harness 问题内容无效".to_string())?;
        let id = valid_question_text(question.get("id"), 200, false)
            .ok_or_else(|| "Harness 问题 ID 无效".to_string())?;
        if !question_ids.insert(id) {
            return Err("Harness 问题 ID 重复".to_string());
        }
        valid_question_text(question.get("question"), 4_000, true)
            .ok_or_else(|| "Harness 问题正文无效".to_string())?;
        for (field, max) in [("header", 200), ("detail", 64 * 1024)] {
            if question.contains_key(field)
                && valid_question_text(question.get(field), max, true).is_none()
            {
                return Err("Harness 问题补充内容无效".to_string());
            }
        }
        if question
            .get("multiSelect")
            .is_some_and(|value| !value.is_boolean())
        {
            return Err("Harness 问题选择模式无效".to_string());
        }
        let mut option_labels = HashSet::new();
        if let Some(options) = question.get("options") {
            let options = options
                .as_array()
                .filter(|options| options.len() <= 12)
                .ok_or_else(|| "Harness 问题选项无效".to_string())?;
            for option in options {
                let option = option
                    .as_object()
                    .ok_or_else(|| "Harness 问题选项无效".to_string())?;
                let label = valid_question_text(option.get("label"), 200, false)
                    .ok_or_else(|| "Harness 问题选项无效".to_string())?;
                if !option_labels.insert(label) {
                    return Err("Harness 问题选项重复".to_string());
                }
                if option.contains_key("description")
                    && valid_question_text(option.get("description"), 2_000, true).is_none()
                {
                    return Err("Harness 问题选项说明无效".to_string());
                }
            }
        }
        if let Some(intent) = question.get("intent") {
            let intent = intent
                .as_object()
                .ok_or_else(|| "Harness 问题意图无效".to_string())?;
            let approve = valid_question_text(intent.get("approve"), 200, false)
                .ok_or_else(|| "Harness 问题意图无效".to_string())?;
            if intent.get("kind").and_then(Value::as_str) != Some("plan-review")
                || !question.contains_key("detail")
                || !option_labels.contains(approve)
            {
                return Err("Harness 计划审阅意图无效".to_string());
            }
        }
    }
    if serde_json::to_vec(questions)
        .map_err(|error| error.to_string())?
        .len()
        > 128 * 1024
    {
        return Err("Harness 问题内容过长".to_string());
    }
    Ok(QuestionPrompt {
        question_id: question_id.to_string(),
        questions: Value::Array(questions.clone()),
    })
}

fn validate_question_answers(answers: &[QuestionAnswerInput]) -> Result<(), String> {
    if answers.is_empty() || answers.len() > 3 {
        return Err("问题回答数量无效".to_string());
    }
    let mut answer_ids = HashSet::new();
    for answer in answers {
        if answer.id.trim().is_empty()
            || answer.id.len() > 200
            || answer.id.chars().any(char::is_control)
            || !answer_ids.insert(answer.id.as_str())
            || answer.selected.len() > 12
            || answer.selected.iter().any(|value| {
                value.trim().is_empty() || value.len() > 200 || value.chars().any(char::is_control)
            })
            || answer.custom.as_ref().is_some_and(|value| {
                value.len() > 16 * 1024
                    || value.chars().any(|character| {
                        character != '\n' && character != '\t' && character.is_control()
                    })
            })
            || (answer.selected.is_empty()
                && answer
                    .custom
                    .as_ref()
                    .is_none_or(|value| value.trim().is_empty()))
        {
            return Err("问题回答内容无效".to_string());
        }
    }
    Ok(())
}

fn valid_question_text(value: Option<&Value>, max_bytes: usize, multiline: bool) -> Option<&str> {
    value.and_then(Value::as_str).filter(|value| {
        !value.trim().is_empty()
            && value.len() <= max_bytes
            && !value.chars().any(|character| {
                character.is_control() && (!multiline || (character != '\n' && character != '\t'))
            })
    })
}

fn sanitize_dialog_text(value: &str, max_chars: usize) -> String {
    let filtered = value
        .chars()
        .map(|character| {
            if character == '\n' || character == '\t' || !character.is_control() {
                character
            } else {
                ' '
            }
        })
        .take(max_chars)
        .collect::<String>();
    if value.chars().count() > max_chars {
        format!("{filtered}\n…内容已截断")
    } else {
        filtered
    }
}

impl Drop for HarnessProcess {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            self.kill();
        }
    }
}

pub(crate) fn resolve_runtime_paths(
    _app: &tauri::AppHandle,
) -> Result<HarnessRuntimePaths, String> {
    #[cfg(not(debug_assertions))]
    {
        let paths = packaged_runtime_paths(
            &_app
                .path()
                .resource_dir()
                .map_err(|error| format!("无法确定应用资源目录：{error}"))?,
        );
        validate_runtime_paths(&paths)?;
        return Ok(paths);
    }

    #[cfg(debug_assertions)]
    {
        let defaults = development_runtime_paths()?;
        let paths = HarnessRuntimePaths {
            node: configured_path("XIAOYIN_HARNESS_NODE", defaults.node)?,
            entry: configured_path("XIAOYIN_HARNESS_HOST_ENTRY", defaults.entry)?,
            config: configured_path("XIAOYIN_HARNESS_CORDIS_CONFIG", defaults.config)?,
            primary_runtime: configured_path("DSH_PRIMARY_RUNTIME", defaults.primary_runtime)?,
        };
        validate_runtime_paths(&paths)?;
        Ok(paths)
    }
}

#[cfg(debug_assertions)]
fn development_runtime_paths() -> Result<HarnessRuntimePaths, String> {
    let repository = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| "无法确定桌面项目目录".to_string())?;
    Ok(HarnessRuntimePaths {
        node: PathBuf::from("node"),
        entry: repository.join("harness-host/dist/index.js"),
        config: repository.join("harness-host/runtime/cordis.yml"),
        primary_runtime: repository.join("src-tauri/resources/harness-runtime/primary-runtime"),
    })
}

#[cfg(any(not(debug_assertions), test))]
fn packaged_runtime_paths(resource_dir: &Path) -> HarnessRuntimePaths {
    // Node's entry-point resolver rejects Windows verbatim paths returned by Tauri.
    let root = dunce::simplified(resource_dir).join("resources/harness-runtime");
    HarnessRuntimePaths {
        node: root.join(if cfg!(target_os = "windows") {
            "node/node.exe"
        } else {
            "node/node"
        }),
        entry: root.join("harness-host/dist/index.js"),
        config: root.join("harness-host/runtime/cordis.yml"),
        primary_runtime: root.join("primary-runtime"),
    }
}

#[cfg(debug_assertions)]
fn configured_path(variable: &str, fallback: PathBuf) -> Result<PathBuf, String> {
    if let Ok(value) = std::env::var(variable)
        && !value.trim().is_empty()
    {
        let path = PathBuf::from(value);
        return if path.is_absolute() {
            Ok(path)
        } else {
            std::env::current_dir()
                .map(|directory| directory.join(path))
                .map_err(|error| format!("无法解析 {variable}：{error}"))
        };
    }
    Ok(fallback)
}

fn validate_runtime_paths(paths: &HarnessRuntimePaths) -> Result<(), String> {
    if paths.node != Path::new("node") && !paths.node.is_file() {
        return Err(format!("找不到内置 Node Runtime：{}", paths.node.display()));
    }
    if !paths.entry.is_file() {
        return Err(format!("找不到 Harness Host：{}", paths.entry.display()));
    }
    if !paths.config.is_file() {
        return Err(format!("找不到 Harness 配置：{}", paths.config.display()));
    }
    if !paths.primary_runtime.join("runtime.json").is_file() {
        return Err(format!(
            "找不到官方 Office Runtime：{}",
            paths.primary_runtime.display()
        ));
    }
    if !paths
        .primary_runtime
        .parent()
        .is_some_and(|root| root.join("office-skills/scripts/check_office.py").is_file())
    {
        return Err("找不到官方 Office Skills 资源".to_string());
    }
    Ok(())
}

fn validate_run_request(request: &HarnessRunRequest) -> Result<(), String> {
    if request.operation_scope.is_empty()
        || request.operation_scope.len() > 100
        || !request
            .operation_scope
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("任务执行标识无效".into());
    }
    if request.task_id.trim().is_empty()
        || request.task_id.len() > 200
        || request.task_id.chars().any(char::is_control)
    {
        return Err("任务标识无效".to_string());
    }
    validate_employee_id(&request.employee_id)?;
    if request.team_id.len() > 512 || request.team_id.chars().any(char::is_control) {
        return Err("团队标识无效".to_string());
    }
    if request.prompt.trim().is_empty() || request.prompt.len() > 1024 * 1024 {
        return Err("消息不能为空且不能超过 1 MiB".to_string());
    }
    if !matches!(request.execution_mode.as_str(), "agent" | "plan") {
        return Err("执行模式无效".to_string());
    }
    validate_http_url("LiteLLM", &request.litellm_base_url)?;
    validate_http_url("知识库", &request.knowledge_endpoint)?;
    validate_http_url("定时任务", &request.schedule_endpoint)?;
    validate_capability_snapshot(&request.capability_snapshot)?;
    if request.attachments.len() > 16 {
        return Err("单条消息最多添加 16 个附件".to_string());
    }
    if request.model.trim().is_empty() || request.model.len() > 200 {
        return Err("模型名称无效".to_string());
    }
    if request
        .reasoning_effort
        .as_deref()
        .is_some_and(|value| !matches!(value, "low" | "medium" | "high" | "xhigh" | "ultra"))
    {
        return Err("无效的思考强度".to_string());
    }
    if request.model_api_key.trim().is_empty()
        || request.model_api_key.len() > 16 * 1024
        || request.model_api_key.chars().any(char::is_control)
    {
        return Err("模型访问凭据无效".to_string());
    }
    if request.session_token.len() > 16 * 1024 || request.session_token.chars().any(char::is_control)
    {
        return Err("ERP 访问凭据无效".to_string());
    }
    Ok(())
}

pub(crate) fn validate_capability_snapshot(snapshot: &CapabilitySnapshot) -> Result<(), String> {
    if snapshot.schema_version != 2 {
        return Err("能力快照协议版本无效".to_string());
    }
    if snapshot.created_at.trim().is_empty()
        || snapshot.created_at.len() > 64
        || snapshot.created_at.chars().any(char::is_control)
    {
        return Err("能力快照创建时间无效".to_string());
    }
    if snapshot.selections.len() != snapshot.artifacts.len() {
        return Err("能力快照中的选择项与制品数量不一致".to_string());
    }
    if snapshot.requested_connector_ids.len() > 64
        || snapshot.local_tools.len() > 256
        || snapshot.requested_knowledge_base_refs.len() > 32
    {
        return Err("能力快照的产品选择范围过大".to_string());
    }
    if snapshot
        .requested_connector_ids
        .iter()
        .any(|id| id.trim().is_empty() || id.len() > 200 || id.chars().any(char::is_control))
        || snapshot
            .requested_knowledge_base_refs
            .iter()
            .any(|reference| {
                reference.trim().is_empty()
                    || reference.len() > 512
                    || reference.chars().any(char::is_control)
            })
    {
        return Err("能力快照的产品选择无效".to_string());
    }
    if snapshot.local_tools.iter().any(|tool| {
        tool.trim().is_empty()
            || tool.len() > 128
            || tool.bytes().any(|value| {
                !(value.is_ascii_alphanumeric() || matches!(value, b'.' | b'_' | b'-'))
            })
    }) {
        return Err("能力快照中的本地工具无效".to_string());
    }
    validate_connector_catalog(&snapshot.connectors)?;
    expert_kits::validate_allowed_artifacts(&snapshot.artifacts)?;
    expert_kits::validate_allowed_artifacts(&snapshot.implicit_artifacts)
}

fn prepare_attachments(
    local_files: &LocalFileAuthorizations,
    attachments: &[LocalTaskAttachment],
) -> Result<(String, Vec<HarnessImageInput>), String> {
    if attachments.is_empty() {
        return Ok((String::new(), Vec::new()));
    }
    let mut lines = vec![
        "用户已明确添加以下本地附件。优先使用给出的 rootId 和相对路径，不要重新要求选择目录："
            .to_string(),
    ];
    let mut images = Vec::new();
    for attachment in attachments {
        if attachment.root_id.trim().is_empty()
            || attachment.path.trim().is_empty()
            || attachment.name.trim().is_empty()
            || attachment.name.len() > 255
            || attachment.path.len() > 4_096
            || !matches!(attachment.kind.as_str(), "file" | "image")
        {
            return Err("附件信息无效".to_string());
        }
        let path = local_files.resolve_artifact(&attachment.root_id, &attachment.path)?;
        let metadata =
            std::fs::metadata(&path).map_err(|error| format!("无法读取附件：{error}"))?;
        if !metadata.is_file() {
            return Err(format!("附件不是文件：{}", attachment.name));
        }
        lines.push(format!(
            "- {}（rootId: {}，path: {}，目录: {}）",
            attachment.name, attachment.root_id, attachment.path, attachment.root_name
        ));
        if attachment.kind == "image" {
            if images.len() >= 4 {
                return Err("单条消息最多添加 4 张图片".to_string());
            }
            let media_type = attachment
                .media_type
                .as_deref()
                .ok_or_else(|| "图片附件缺少格式".to_string())?;
            if !matches!(media_type, "image/png" | "image/jpeg") {
                return Err("图片附件只支持 PNG 或 JPEG".to_string());
            }
            if metadata.len() > 10 * 1024 * 1024 {
                return Err(format!("图片附件超过 10 MB：{}", attachment.name));
            }
            let bytes =
                std::fs::read(path).map_err(|error| format!("无法读取图片附件：{error}"))?;
            images.push(HarnessImageInput {
                data_base64: BASE64.encode(bytes),
                media_type: media_type.to_string(),
                name: attachment.name.clone(),
            });
        }
    }
    Ok((lines.join("\n"), images))
}

fn validate_access_token(session_token: &str) -> Result<(), String> {
    if session_token.len() > 16 * 1024 || session_token.chars().any(char::is_control) {
        return Err("ERP 访问凭据无效".to_string());
    }
    Ok(())
}

fn is_valid_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
}

fn resolve_connector_credentials(
    app: &tauri::AppHandle,
    connectors: &[RuntimeConnector],
    employee_id: &str,
    session_token: &str,
) -> Result<Vec<RuntimeConnector>, String> {
    let epoch = crate::dingtalk_auth::mcp::session_epoch();
    connectors
        .iter()
        .cloned()
        .map(|mut connector| {
            let credential = match connector.auth_mode.as_str() {
                "none" => None,
                "employee-bearer" => {
                    let token =
                        crate::dingtalk_auth::connector_bearer_token(employee_id, session_token);
                    if token.is_empty() {
                        return Err(format!("连接器「{}」缺少员工登录凭据", connector.name));
                    }
                    Some(("authorization", format!("Bearer {token}")))
                }
                "oauth" => {
                    let result = crate::connector_oauth::token_result(
                        app,
                        Some(&connector),
                        &connector.url,
                        employee_id,
                        epoch,
                        None,
                    );
                    let token = result["token"]
                        .as_str()
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| {
                            result["error"]
                                .as_str()
                                .unwrap_or("连接器需要重新授权")
                                .to_string()
                        })?;
                    Some(("authorization", format!("Bearer {token}")))
                }
                "erp-cookie" => {
                    let cookie = connector
                        .headers
                        .iter()
                        .find(|(key, _)| key.eq_ignore_ascii_case("cookie"))
                        .map(|(_, value)| value.trim())
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| format!("连接器「{}」需要重新登录", connector.name))?;
                    if cookie.contains('\r') || cookie.contains('\n') {
                        return Err(format!("连接器「{}」的登录凭据无效", connector.name));
                    }
                    None
                }
                _ => return Err(format!("连接器「{}」认证方式无效", connector.name)),
            };
            if let Some((header, value)) = credential {
                connector
                    .headers
                    .retain(|key, _| !key.eq_ignore_ascii_case(header));
                connector.headers.insert(header.to_string(), value);
            }
            Ok(connector)
        })
        .collect()
}

pub(crate) fn credential_digest(model_api_key: &str, session_token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update((model_api_key.len() as u64).to_be_bytes());
    hasher.update(model_api_key.as_bytes());
    hasher.update((session_token.len() as u64).to_be_bytes());
    hasher.update(session_token.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Keep Harness persistence and the default workspace private to one employee without putting
/// employee identifiers (which may contain PII) into filesystem paths.
pub(crate) fn employee_namespace(employee_id: &str) -> String {
    format!("employee-{:x}", Sha256::digest(employee_id.as_bytes()))
}

fn employee_harness_root(app_data: &Path, employee_id: &str) -> PathBuf {
    app_data
        .join("harness")
        .join(employee_namespace(employee_id))
}

pub(crate) fn validate_employee_id(value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err("员工标识无效".to_string());
    }
    Ok(())
}

fn fingerprint_changed(current: Option<&RuntimeFingerprint>, next: &RuntimeFingerprint) -> bool {
    current.is_some_and(|value| value != next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stdout_reader_delivers_lines_without_blocking_the_request_loop() {
        let (receiver, reader) = capture_stdout(std::io::Cursor::new(b"one\ntwo\n".to_vec()));
        assert_eq!(
            receiver
                .recv_timeout(Duration::from_secs(1))
                .unwrap()
                .unwrap(),
            "one\n"
        );
        assert_eq!(
            receiver
                .recv_timeout(Duration::from_secs(1))
                .unwrap()
                .unwrap(),
            "two\n"
        );
        assert!(matches!(
            receiver.recv_timeout(Duration::from_secs(1)),
            Err(mpsc::RecvTimeoutError::Disconnected)
        ));
        reader.join().unwrap();
    }

    #[test]
    fn employee_storage_namespaces_are_stable_and_private() {
        let app_data = Path::new("/tmp/xiaoyin");
        assert_eq!(
            employee_namespace("employee-1"),
            employee_namespace("employee-1")
        );
        assert_ne!(
            employee_namespace("employee-1"),
            employee_namespace("employee-2")
        );
        assert!(
            !employee_harness_root(app_data, "employee-1")
                .to_string_lossy()
                .contains("employee-1")
        );
        assert!(
            employee_harness_root(app_data, "employee-1")
                .ends_with("harness/".to_string() + &employee_namespace("employee-1"))
        );
    }

    #[test]
    fn employee_id_validation_rejects_empty_and_control_values() {
        assert!(validate_employee_id("employee-1").is_ok());
        assert!(validate_employee_id("").is_err());
        assert!(validate_employee_id("employee\n1").is_err());
    }

    #[test]
    fn runtime_fingerprint_changes_force_a_fresh_process() {
        let baseline = RuntimeFingerprint {
            skill_directories: Vec::new(),
            connectors: Vec::new(),
            local_file_roots: Vec::new(),
            allow_browser: false,
            allowed_computer_tools: Vec::new(),
            execution_mode: "agent".to_string(),
            allow_shell: true,
            allow_lsp: true,
            allow_external_agents: false,
            allow_hooks: false,
            litellm_base_url: "https://model.example/v1".to_string(),
            knowledge_endpoint: "https://knowledge.example".to_string(),
            schedule_endpoint: "https://schedule.example".to_string(),
            employee_id: "employee-1".to_string(),
            team_id: "team-1".to_string(),
            knowledge_base_refs: Some(Vec::new()),
            model: "deepseek-chat".to_string(),
            memory_context: String::new(),
            reasoning_effort: None,
            credential_digest: "digest-1".to_string(),
        };
        assert!(!fingerprint_changed(None, &baseline));
        assert!(!fingerprint_changed(Some(&baseline), &baseline));
        for changed in [
            RuntimeFingerprint {
                reasoning_effort: Some("medium".into()),
                ..baseline.clone()
            },
            RuntimeFingerprint {
                employee_id: "employee-2".into(),
                ..baseline.clone()
            },
            RuntimeFingerprint {
                model: "deepseek-reasoner".into(),
                ..baseline.clone()
            },
            RuntimeFingerprint {
                credential_digest: "digest-2".into(),
                ..baseline.clone()
            },
            RuntimeFingerprint {
                execution_mode: "plan".into(),
                ..baseline.clone()
            },
            RuntimeFingerprint {
                allow_shell: false,
                ..baseline.clone()
            },
            RuntimeFingerprint {
                allow_lsp: false,
                ..baseline.clone()
            },
            RuntimeFingerprint {
                allow_hooks: true,
                ..baseline.clone()
            },
        ] {
            assert!(fingerprint_changed(Some(&baseline), &changed));
        }
    }

    #[test]
    fn cancel_without_active_run_is_a_noop() {
        assert_eq!(HarnessManager::default().cancel("missing-task"), Ok(false));
    }

    #[test]
    fn steering_and_interrupt_only_reach_a_running_turn() {
        let manager = HarnessManager::default();
        assert_eq!(manager.steer("missing-task", "改用方案 B"), Ok(false));
        assert_eq!(manager.interrupt("missing-task"), Ok(false));
        assert!(manager.steer("missing-task", "   ").is_err());

        let slot = manager.slot("steered-task").unwrap();
        let run = slot.begin_for("employee-1").unwrap();
        assert_eq!(manager.steer("steered-task", "改用方案 B"), Ok(true));
        assert_eq!(
            slot.intents.steer_inbox.lock().unwrap().as_slice(),
            ["改用方案 B"]
        );
        assert_eq!(manager.interrupt("steered-task"), Ok(true));
        assert!(slot.intents.interrupt_requested.load(Ordering::SeqCst));
        drop(run);
        // A finished turn accepts neither intent.
        assert_eq!(manager.steer("steered-task", "太晚了"), Ok(false));
        assert_eq!(manager.interrupt("steered-task"), Ok(false));
        // A slot is reused with its warm Harness process, so stale intents
        // must be removed before the next turn starts.
        let _next = slot.begin().unwrap();
        assert!(slot.intents.steer_inbox.lock().unwrap().is_empty());
        assert!(!slot.intents.interrupt_requested.load(Ordering::SeqCst));
    }

    #[test]
    fn interrupt_releases_a_pending_question_without_waiting_for_another_event() {
        let manager = HarnessManager::default();
        let slot = manager.slot("question-task").unwrap();
        let _run = slot.begin_for("employee-1").unwrap();
        let receiver = manager
            .questions
            .register("question-task", "question-1")
            .unwrap();
        assert_eq!(manager.interrupt("question-task"), Ok(true));
        assert!(receiver.recv_timeout(Duration::from_millis(50)).is_err());
    }

    #[test]
    fn task_slot_owner_blocks_other_employee_controls_and_reuse() {
        let manager = HarnessManager::default();
        assert!(manager.check_task_owner("missing", "employee-2").is_ok());
        let slot = manager.slot("owned-task").unwrap();
        let run = slot.begin_for("employee-1").unwrap();
        assert!(manager.check_task_owner("owned-task", "employee-1").is_ok());
        assert!(
            manager
                .check_task_owner("owned-task", "employee-2")
                .is_err()
        );
        drop(run);
        assert!(slot.begin_for("employee-2").is_err());
        assert!(
            manager
                .begin_operation_review("owned-task", "employee-2")
                .is_err()
        );
        assert!(
            manager
                .begin_operation_review("owned-task", "employee-1")
                .is_ok()
        );
    }

    #[test]
    fn cancellation_is_remembered_before_process_start_and_scoped_to_one_turn() {
        let manager = HarnessManager::default();
        let slot = manager.slot("startup").unwrap();
        let guard = slot.begin().unwrap();
        assert!(slot.is_running());
        assert!(slot.begin().is_err());
        assert_eq!(manager.cancel("startup"), Ok(true));
        assert_eq!(slot.register_process(123), Err("本轮已停止".to_string()));
        drop(guard);
        assert!(!slot.is_running());
        assert_eq!(manager.cancel("startup"), Ok(false));
        let _next = slot.begin().unwrap();
        assert!(!slot.active.lock().unwrap().as_ref().unwrap().canceled);
    }

    #[test]
    fn canceling_one_task_does_not_cancel_another() {
        let manager = HarnessManager::default();
        let one = manager.slot("one").unwrap();
        let two = manager.slot("two").unwrap();
        let _first = one.begin().unwrap();
        let _second = two.begin().unwrap();
        assert_eq!(manager.cancel("one"), Ok(true));
        assert!(!two.active.lock().unwrap().as_ref().unwrap().canceled);
        assert!(terminate_process(0).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn stop_terminates_an_isolated_host_group_even_when_term_is_ignored() {
        let mut child = Command::new("sh")
            .args(["-c", "trap '' TERM; sleep 30 & printf 'ready\\n'; wait"])
            .process_group(0)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let mut ready = String::new();
        stdout.read_line(&mut ready).unwrap();
        assert_eq!(ready, "ready\n");
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let mut output = String::new();
            let result = stdout.read_to_string(&mut output);
            let _ = sender.send(result);
        });
        assert_eq!(terminate_process(child.id()), Ok(true));
        assert!(!child.wait().unwrap().success());
        // Descendants must release inherited stdout too, or native reads hang.
        assert!(
            receiver
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .is_ok()
        );
    }

    #[test]
    fn native_bridge_preserves_harness_result() {
        let result: HarnessRunResult = serde_json::from_value(json!({
            "sessionId": "session-1", "finalResponse": "请补充月份"
        }))
        .unwrap();
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({
                "sessionId": "session-1", "finalResponse": "请补充月份"
            })
        );
    }

    #[test]
    fn native_bridge_preserves_incremental_host_event_shape() {
        let host_params = json!({
            "requestId": 7,
            "rootSessionId": "session-1",
            "event": {
                "method": "session.event",
                "params": {
                    "sessionId": "session-1",
                    "event": { "type": "text-chunks", "data": { "texts": ["正在回答"] } }
                }
            }
        });
        let bridged = serde_json::to_value(ui_notification(
            "task-1",
            7,
            "stream-1",
            3,
            host_params.clone(),
        ))
        .expect("notification should serialize");
        assert_eq!(bridged["taskId"], "task-1");
        assert_eq!(bridged["requestId"], 7);
        assert_eq!(bridged["streamId"], "stream-1");
        assert_eq!(bridged["sequence"], 3);
        assert_eq!(bridged["event"], host_params);
    }

    #[test]
    fn idle_slots_are_trimmed_while_running_tasks_all_keep_theirs() {
        let manager = HarnessManager::default();
        for index in 1..=6 {
            assert!(manager.slot(&format!("task-{index}")).is_ok());
        }
        {
            let slots = manager.slots.lock().expect("task pool should be available");
            // Nothing is running, so only the warm idle slots and the newest one survive.
            assert_eq!(slots.len(), WARM_IDLE_HARNESS_SLOTS + 1);
            assert!(slots.contains_key("task-6"));
        }

        let running = (1..=5)
            .map(|index| {
                let id = format!("busy-{index}");
                let slot = manager.slot(&id).expect("slot should be available");
                (id, slot.begin().expect("task should start"))
            })
            .collect::<Vec<_>>();
        assert!(manager.slot("busy-6").is_ok());
        let slots = manager.slots.lock().expect("task pool should be available");
        // A running task is never evicted and never refused, however many are already going.
        for (id, _) in &running {
            assert!(
                slots.contains_key(id.as_str()),
                "{id} should still be pooled"
            );
        }
        assert!(slots.contains_key("busy-6"));
    }

    #[test]
    fn run_request_requires_safe_endpoints_and_model() {
        let valid = HarnessRunRequest {
            operation_scope: "test-turn".into(),
            task_id: "task-1".to_string(),
            prompt: "分析库存".to_string(),
            execution_mode: "agent".to_string(),
            allow_shell: true,
            allow_lsp: true,
            allow_external_agents: false,
            allow_hooks: false,
            employee_id: "employee-1".to_string(),
            team_id: "crossborder".to_string(),
            session_id: None,
            capability_snapshot: CapabilitySnapshot {
                schema_version: 2,
                created_at: "2026-09-11T00:00:00Z".to_string(),
                selections: Vec::new(),
                artifacts: Vec::new(),
                implicit_artifacts: Vec::new(),
                local_tools: Vec::new(),
                requested_connector_ids: Vec::new(),
                knowledge_base_refs: Vec::new(),
                requested_knowledge_base_refs: Vec::new(),
                connectors: vec![ConnectorDefinition {
                    timeout_seconds: None,
                    id: "erp-mcp".to_string(),
                    name: "ERP".to_string(),
                    status: "ready".to_string(),
                    version: "1".to_string(),
                    transport: "streamable-http".to_string(),
                    url: "http://erp.internal/mcp".to_string(),
                    auth_mode: "employee-bearer".to_string(),
                    tool_names: vec!["sales_summary".to_string()],
                    read_only_tools: vec!["sales_summary".to_string()],
                    command: String::new(),
                    arguments: Vec::new(),
                    environment: std::collections::HashMap::new(),
                    headers: std::collections::HashMap::new(),
                    enabled: true,
                }],
            },
            litellm_base_url: "http://litellm.internal/v1".to_string(),
            knowledge_endpoint: "http://xiaoyin-server.internal/api/v1/knowledge-bases".to_string(),
            schedule_endpoint: "http://xiaoyin-server.internal/api/v1/schedules".to_string(),
            model: "deepseek-chat".to_string(),
            model_api_key: "model-token".to_string(),
            reasoning_effort: None,
            session_token: "erp-token".to_string(),
            local_file_root_ids: Vec::new(),
            attachments: Vec::new(),
        };
        assert!(validate_run_request(&valid).is_ok());
        let invalid = HarnessRunRequest {
            litellm_base_url: "file:///tmp/model".to_string(),
            ..valid
        };
        assert!(validate_run_request(&invalid).is_err());
    }

    #[test]
    fn run_request_without_optional_runtime_authorizations_is_restricted() {
        let request: HarnessRunRequest = serde_json::from_value(json!({
            "operationScope": "test-turn",
            "taskId": "task-1",
            "prompt": "整理资料",
            "executionMode": "agent",
            "employeeId": "employee-1",
            "teamId": "team-1",
            "sessionId": null,
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
            "litellmBaseUrl": "http://litellm.internal/v1",
            "knowledgeEndpoint": "http://xiaoyin-server.internal/api/v1/knowledge-bases",
            "model": "deepseek-chat",
            "modelApiKey": "model-token",
            "sessionToken": "token"
        }))
        .expect("request without optional authorizations should remain restricted");
        assert!(!request.allow_shell);
        assert!(!request.allow_lsp);
        assert!(!request.allow_external_agents);
        assert!(!request.allow_hooks);
    }

    #[test]
    fn packaged_runtime_uses_only_installed_resources() {
        let paths = packaged_runtime_paths(Path::new(r"C:\Program Files\xiaoyin"));
        assert_eq!(
            paths.node,
            PathBuf::from(r"C:\Program Files\xiaoyin").join(if cfg!(target_os = "windows") {
                "resources/harness-runtime/node/node.exe"
            } else {
                "resources/harness-runtime/node/node"
            })
        );
        assert_eq!(
            paths.entry,
            PathBuf::from(r"C:\Program Files\xiaoyin")
                .join("resources/harness-runtime/harness-host/dist/index.js")
        );
        assert_eq!(
            paths.config,
            PathBuf::from(r"C:\Program Files\xiaoyin")
                .join("resources/harness-runtime/harness-host/runtime/cordis.yml")
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn packaged_node_entry_starts_from_a_canonical_windows_resource_directory() {
        let temporary =
            std::env::temp_dir().join(format!("xiaoyin runtime {}", uuid::Uuid::new_v4()));
        let entry = temporary.join("resources/harness-runtime/harness-host/dist/index.js");
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::write(&entry, "process.stdout.write('runtime-entry-ready')").unwrap();
        let canonical = temporary.canonicalize().unwrap();
        let paths = packaged_runtime_paths(&canonical);
        let output = Command::new("node")
            .arg(paths.entry)
            .creation_flags(0x0800_0000)
            .output()
            .expect("Node is required for the desktop runtime tests");
        std::fs::remove_dir_all(&temporary).unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.stdout, b"runtime-entry-ready");
    }

    #[test]
    fn ready_connectors_are_session_capabilities_and_declared_dependencies_are_advisory() {
        let catalog = vec![ConnectorDefinition {
            timeout_seconds: None,
            id: "erp-mcp".to_string(),
            name: "ERP".to_string(),
            status: "ready".to_string(),
            version: "1".to_string(),
            transport: "streamable-http".to_string(),
            url: "http://erp.internal/mcp".to_string(),
            auth_mode: "employee-bearer".to_string(),
            tool_names: vec!["sales_summary".to_string(), "order_cancel".to_string()],
            read_only_tools: vec!["sales_summary".to_string()],
            command: String::new(),
            arguments: Vec::new(),
            environment: std::collections::HashMap::new(),
            headers: std::collections::HashMap::new(),
            enabled: true,
        }];
        let profile = expert_kits::ExpertKitHarnessProfile {
            skill_directories: Vec::new(),
            knowledge_base_refs: Some(vec!["organization:operations-sop".to_string()]),
            required_connector_tools: vec!["sales_summary".to_string()],
            allowed_computer_tools: Vec::new(),
            prompt: String::new(),
        };

        let runtime =
            runtime_connectors(&catalog, &profile, true).expect("connector should resolve");
        assert_eq!(runtime.len(), 1);
        assert_eq!(runtime[0].allowed_tools, vec!["sales_summary"]);
        assert_eq!(runtime[0].required_tools, vec!["sales_summary"]);
        assert!(!runtime[0].required);
        assert!(runtime[0].allow_write);
        assert!(runtime[0].require_write_approval);
    }

    #[test]
    fn diagnostics_include_only_ready_remote_connectors_and_all_declared_tools() {
        let catalog = vec![ConnectorDefinition {
            timeout_seconds: None,
            id: "erp-mcp".to_string(),
            name: "ERP".to_string(),
            status: "ready".to_string(),
            version: "2".to_string(),
            transport: "streamable-http".to_string(),
            url: "http://erp.internal/mcp".to_string(),
            auth_mode: "employee-bearer".to_string(),
            tool_names: vec!["sales_summary".to_string(), "inventory_risk".to_string()],
            read_only_tools: vec!["sales_summary".to_string(), "inventory_risk".to_string()],
            command: String::new(),
            arguments: Vec::new(),
            environment: std::collections::HashMap::new(),
            headers: std::collections::HashMap::new(),
            enabled: false,
        }];

        let diagnostics = diagnostic_connectors(&catalog).expect("catalog should be valid");
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].id, "erp-mcp");
        assert_eq!(
            diagnostics[0].required_tools,
            vec!["sales_summary", "inventory_risk"]
        );
    }

    #[test]
    fn approval_requests_are_validated_and_control_characters_are_removed() {
        let value = json!({
            "approvalId": "approval-1",
            "toolName": "bash",
            "reason": "运行命令\u{0007}\nls"
        });
        let approval = parse_approval_request(Some(&value)).expect("approval should parse");
        assert_eq!(approval.approval_id, "approval-1");
        assert_eq!(approval.tool_name, "bash");
        assert_eq!(approval.reason, "运行命令 \nls");
    }

    #[test]
    fn approval_broker_scopes_decisions_to_the_owning_task() {
        let broker = ApprovalBroker::default();
        let receiver = broker.register("task-1", "approval-1").unwrap();
        assert!(broker.respond("task-2", "approval-1", "allow").is_err());
        assert!(broker.respond("task-1", "approval-1", "allow").unwrap());
        assert_eq!(receiver.recv().unwrap(), "allow");
    }

    #[test]
    fn question_requests_validate_shape_and_plan_review_intent() {
        let value = json!({
            "questionId": "question-1",
            "questions": [{
                "id": "review",
                "header": "计划",
                "question": "是否执行？",
                "detail": "## 实施计划",
                "options": [{"label": "批准"}, {"label": "修改"}],
                "intent": {"kind": "plan-review", "approve": "批准"}
            }]
        });
        let question = parse_question_request(Some(&value)).expect("question should parse");
        assert_eq!(question.question_id, "question-1");
        assert_eq!(question.questions[0]["id"], "review");

        let invalid_intent = json!({
            "questionId": "question-2",
            "questions": [{
                "id": "review",
                "question": "是否执行？",
                "detail": "计划",
                "options": [{"label": "修改"}],
                "intent": {"kind": "plan-review", "approve": "批准"}
            }]
        });
        assert!(parse_question_request(Some(&invalid_intent)).is_err());
        let duplicate_ids = json!({
            "questionId": "question-3",
            "questions": [
                {"id": "same", "question": "第一个？"},
                {"id": "same", "question": "第二个？"}
            ]
        });
        assert!(parse_question_request(Some(&duplicate_ids)).is_err());
    }

    #[test]
    fn question_answers_reject_empty_duplicate_or_unsafe_values() {
        let valid = vec![QuestionAnswerInput {
            id: "scope".into(),
            selected: vec!["运行时".into()],
            custom: Some("保留备份".into()),
        }];
        assert!(validate_question_answers(&valid).is_ok());
        assert_eq!(
            serde_json::to_value(&QuestionAnswerInput {
                id: "addend".into(),
                selected: vec!["35".into()],
                custom: None,
            })
            .unwrap(),
            json!({ "id": "addend", "selected": ["35"] })
        );
        assert!(
            validate_question_answers(&[QuestionAnswerInput {
                id: "scope".into(),
                selected: Vec::new(),
                custom: Some("  ".into()),
            }])
            .is_err()
        );
        assert!(
            validate_question_answers(&[
                valid[0].clone(),
                QuestionAnswerInput {
                    id: "scope".into(),
                    selected: vec!["界面".into()],
                    custom: None,
                },
            ])
            .is_err()
        );
    }

    #[test]
    fn question_broker_isolates_same_question_id_between_tasks() {
        let broker = QuestionBroker::default();
        let first = broker.register("task-1", "question-1").unwrap();
        let second = broker.register("task-2", "question-1").unwrap();
        assert!(broker.respond("task-3", "question-1", Vec::new()).is_err());
        assert!(
            broker
                .respond(
                    "task-2",
                    "question-1",
                    vec![QuestionAnswerInput {
                        id: "answer".into(),
                        selected: vec!["two".into()],
                        custom: None,
                    }],
                )
                .unwrap()
        );
        assert_eq!(second.recv().unwrap()[0].selected, vec!["two"]);
        assert!(
            broker
                .respond(
                    "task-1",
                    "question-1",
                    vec![QuestionAnswerInput {
                        id: "answer".into(),
                        selected: vec!["one".into()],
                        custom: None,
                    }],
                )
                .unwrap()
        );
        assert_eq!(first.recv().unwrap()[0].selected, vec!["one"]);
    }

    #[test]
    fn unexpected_exit_includes_a_bounded_sanitized_cause() {
        let message = unexpected_exit_message(None, "\n fatal\u{0007}: key sk-secret-value\n");
        assert_eq!(message, "Harness Host 意外退出：fatal : key [REDACTED]");
        assert!(!message.contains("secret-value"));

        let long = "x".repeat(MAX_HARNESS_ERROR_CHARS + 20);
        let message = unexpected_exit_message(None, &long);
        assert!(message.ends_with(&"x".repeat(MAX_HARNESS_ERROR_CHARS)));
        assert!(message.contains('…'));
    }
}
#[test]
fn command_errors_accept_only_the_structured_contract() {
    let value = HarnessCommandError::from_message(
        serde_json::json!({
            "code": "XY-CAPACITY",
            "category": "capacity",
            "title": "模型服务繁忙",
            "detail": "稍后重试",
            "infrastructure": false,
            "retryable": true,
        })
        .to_string(),
    );
    assert_eq!(value.code, "XY-CAPACITY");
    assert!(value.retryable);
    let invalid = HarnessCommandError::from_message(
        serde_json::json!({
            "code": "MODEL",
            "category": "model",
            "title": "模型失败",
            "detail": "未知",
            "infrastructure": false,
            "retryable": true,
        })
        .to_string(),
    );
    assert_eq!(invalid.code, "XY-UNSTRUCTURED-ERROR");
    assert!(!invalid.retryable);
}
