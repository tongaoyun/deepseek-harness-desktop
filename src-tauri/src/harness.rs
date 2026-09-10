pub(crate) use crate::harness_connectors::{
    ConnectorDefinition, RuntimeConnector, runtime_connectors,
};
use crate::harness_connectors::{
    desktop_connector_enabled, diagnostic_connectors, validate_connector_catalog, validate_http_url,
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
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Arc, Mutex, mpsc},
    thread::JoinHandle,
    time::Duration,
};
use tauri::{Emitter, Listener, Manager};

/// A finished task keeps its harness process warm so the next turn starts quickly, but only this
/// many idle ones are worth the memory. How many tasks run at once is the employee's call, the way
/// it is when they open another terminal, so a running task is never refused a slot.
const WARM_IDLE_HARNESS_SLOTS: usize = 3;

impl HarnessManager {
    pub(crate) fn begin_operation_review(
        &self,
        task_id: &str,
    ) -> Result<impl Drop + use<>, String> {
        self.slot(task_id)?.begin()
    }

    /// A running task holds absolute paths into the extension directories it was started with,
    /// so callers that delete installed content wait until no slot is executing.
    pub(crate) fn has_running_task(&self) -> bool {
        self.slots
            .lock()
            .map_or(true, |slots| slots.values().any(|slot| slot.is_running()))
    }
}

#[derive(Default)]
struct HarnessSlot {
    process: Mutex<Option<HarnessProcess>>,
    active: Mutex<Option<ActiveRun>>,
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
    fn begin(self: &Arc<Self>) -> Result<ActiveRunGuard, String> {
        let mut active = self.active.lock().map_err(|_| "任务状态不可用")?;
        if active.is_some() {
            return Err("当前任务仍在执行".to_string());
        }
        *active = Some(ActiveRun::default());
        Ok(ActiveRunGuard(Arc::clone(self)))
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
        if let Some(pid) = run.pid {
            signal_process(pid, false)?;
            let slot = Arc::clone(self);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(5));
                if let Ok(active) = slot.active.lock()
                    && active
                        .as_ref()
                        .is_some_and(|run| run.canceled && run.pid == Some(pid))
                {
                    let _ = terminate_process(pid);
                }
            });
        }
        run.canceled = true;
        Ok(true)
    }
}

#[derive(Clone, Default)]
pub struct HarnessManager {
    slots: Arc<Mutex<HashMap<String, Arc<HarnessSlot>>>>,
    approvals: Arc<ApprovalBroker>,
}

#[derive(Default)]
struct ApprovalBroker {
    pending: Mutex<HashMap<String, PendingApproval>>,
}

struct PendingApproval {
    task_id: String,
    sender: mpsc::Sender<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessRunRequest {
    operation_scope: String,
    task_id: String,
    prompt: String,
    execution_mode: String,
    employee_id: String,
    team_id: String,
    session_id: Option<String>,
    selected_extensions: Vec<expert_kits::ExtensionSelection>,
    #[serde(default)]
    knowledge_base_refs: Vec<String>,
    #[serde(default)]
    allowed_artifacts: Vec<expert_kits::AllowedExtensionArtifact>,
    litellm_base_url: String,
    knowledge_endpoint: String,
    #[serde(default)]
    schedule_endpoint: String,
    #[serde(default)]
    connectors: Vec<ConnectorDefinition>,
    model: String,
    model_api_key: String,
    access_token: String,
    #[serde(default)]
    local_file_root_ids: Vec<String>,
    #[serde(default)]
    attachments: Vec<LocalTaskAttachment>,
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
    access_token: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessRunResult {
    session_id: String,
    final_response: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    outcome: Option<Value>,
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
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HarnessUiNotification {
    task_id: String,
    request_id: u64,
    event: Value,
}

fn ui_notification(task_id: &str, request_id: u64, event: Value) -> HarnessUiNotification {
    HarnessUiNotification {
        task_id: task_id.to_string(),
        request_id,
        event,
    }
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct RuntimeFingerprint {
    pub(crate) skill_directories: Vec<String>,
    pub(crate) connectors: Vec<RuntimeConnector>,
    pub(crate) local_file_roots: Vec<RuntimeLocalFileRoot>,
    pub(crate) allow_browser: bool,
    pub(crate) allowed_computer_tools: Vec<String>,
    pub(crate) execution_mode: String,
    pub(crate) litellm_base_url: String,
    pub(crate) knowledge_endpoint: String,
    pub(crate) schedule_endpoint: String,
    pub(crate) employee_id: String,
    pub(crate) team_id: String,
    pub(crate) knowledge_base_refs: Option<Vec<String>>,
    pub(crate) model: String,
    pub(crate) memory_context: String,
    pub(crate) credential_digest: String,
}

pub(crate) struct HarnessProcess {
    app: tauri::AppHandle,
    erp_session_epoch: u64,
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    stderr_tail: Arc<Mutex<String>>,
    stderr_reader: Option<JoinHandle<()>>,
    next_id: u64,
    notification_task_id: String,
    approval_broker: Option<Arc<ApprovalBroker>>,
    pub(crate) fingerprint: RuntimeFingerprint,
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct HarnessRuntimePaths {
    pub(crate) node: PathBuf,
    pub(crate) entry: PathBuf,
    config: PathBuf,
}

#[tauri::command]
pub async fn run_harness(
    app: tauri::AppHandle,
    manager: tauri::State<'_, HarnessManager>,
    local_files: tauri::State<'_, LocalFileAuthorizations>,
    request: HarnessRunRequest,
) -> Result<HarnessRunResult, String> {
    validate_run_request(&request)?;
    let active_run = manager.slot(&request.task_id)?.begin()?;
    let (attachment_context, images) = prepare_attachments(&local_files, &request.attachments)?;
    let user_prompt = if attachment_context.is_empty() {
        request.prompt.trim().to_string()
    } else {
        format!("{}\n\n{}", request.prompt.trim(), attachment_context)
    };
    let profile = expert_kits::harness_profile(
        &app,
        &request.selected_extensions,
        &request.knowledge_base_refs,
        &user_prompt,
        &request.allowed_artifacts,
        &request.execution_mode,
    )?;
    let local_file_roots = local_files.resolve(&request.local_file_root_ids)?;
    let plan_mode = request.execution_mode == "plan";
    let allow_browser =
        !plan_mode && desktop_connector_enabled(&request.connectors, "desktop-browser");
    let connectors = runtime_connectors(&request.connectors, &profile, !plan_mode)?;
    let fingerprint = RuntimeFingerprint {
        skill_directories: profile.skill_directories,
        connectors,
        local_file_roots,
        allow_browser,
        allowed_computer_tools: if plan_mode {
            Vec::new()
        } else {
            profile.allowed_computer_tools
        },
        execution_mode: request.execution_mode,
        litellm_base_url: request.litellm_base_url,
        knowledge_endpoint: request.knowledge_endpoint,
        schedule_endpoint: request.schedule_endpoint,
        employee_id: request.employee_id.clone(),
        team_id: request.team_id,
        knowledge_base_refs: profile.knowledge_base_refs,
        model: request.model,
        memory_context: memory::context(&app, &request.employee_id)?,
        credential_digest: credential_digest(&request.model_api_key, &request.access_token),
    };
    let turn = HarnessTurnInput {
        operation_scope: request.operation_scope,
        prompt: profile.prompt,
        session_id: request.session_id,
        images,
    };
    let model_api_key = request.model_api_key;
    let access_token = request.access_token;
    let task_id = request.task_id;
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _active_run = active_run;
        manager.run(
            &task_id,
            &app,
            fingerprint,
            turn,
            model_api_key,
            access_token,
        )
    })
    .await
    .map_err(|error| format!("Harness 执行线程异常：{error}"))?
}

#[tauri::command]
pub async fn shutdown_harness(
    manager: tauri::State<'_, HarnessManager>,
    task_id: Option<String>,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.shutdown(task_id.as_deref()))
        .await
        .map_err(|error| format!("Harness 关闭线程异常：{error}"))?
}

#[tauri::command]
pub fn cancel_harness(
    manager: tauri::State<'_, HarnessManager>,
    task_id: String,
) -> Result<bool, String> {
    manager.cancel(&task_id)
}

#[tauri::command]
pub fn respond_harness_approval(
    manager: tauri::State<'_, HarnessManager>,
    task_id: String,
    approval_id: String,
    decision: String,
) -> Result<bool, String> {
    manager.respond_to_approval(&task_id, &approval_id, &decision)
}

#[tauri::command]
pub async fn diagnose_connectors(
    app: tauri::AppHandle,
    request: ConnectorDiagnosticRequest,
) -> Result<Vec<ConnectorDiagnosticResult>, String> {
    validate_access_token(&request.access_token)?;
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
        litellm_base_url: String::new(),
        knowledge_endpoint: String::new(),
        schedule_endpoint: String::new(),
        employee_id: request.employee_id,
        team_id: String::new(),
        knowledge_base_refs: Some(Vec::new()),
        model: "connector-diagnostics".to_string(),
        memory_context: String::new(),
        credential_digest: credential_digest("", &request.access_token),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut process = HarnessProcess::start_uninitialized(
            &app,
            fingerprint,
            String::new(),
            request.access_token,
        )?;
        let result = process.request("connectors.diagnose", None, None);
        process.shutdown();
        serde_json::from_value(result?).map_err(|error| format!("连接器诊断结果无效：{error}"))
    })
    .await
    .map_err(|error| format!("连接器诊断线程异常：{error}"))?
}

#[tauri::command]
pub async fn self_test_local_capabilities(
    app: tauri::AppHandle,
) -> Result<LocalCapabilitySelfTestResult, String> {
    let fingerprint = RuntimeFingerprint {
        skill_directories: Vec::new(),
        connectors: Vec::new(),
        local_file_roots: Vec::new(),
        allow_browser: false,
        allowed_computer_tools: Vec::new(),
        execution_mode: "agent".to_string(),
        litellm_base_url: String::new(),
        knowledge_endpoint: String::new(),
        schedule_endpoint: String::new(),
        employee_id: String::new(),
        team_id: String::new(),
        knowledge_base_refs: Some(Vec::new()),
        model: "capability-self-test".to_string(),
        memory_context: String::new(),
        credential_digest: credential_digest("", ""),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut process =
            HarnessProcess::start_uninitialized(&app, fingerprint, String::new(), String::new())?;
        let result = process.request("host.self-test", None, None);
        process.shutdown();
        serde_json::from_value(result?).map_err(|error| format!("本地能力自检结果无效：{error}"))
    })
    .await
    .map_err(|error| format!("本地能力自检线程异常：{error}"))?
}

#[tauri::command]
pub async fn probe_harness_host(app: tauri::AppHandle) -> Result<HarnessHostHealth, String> {
    let fingerprint = RuntimeFingerprint {
        skill_directories: Vec::new(),
        connectors: Vec::new(),
        local_file_roots: Vec::new(),
        allow_browser: false,
        allowed_computer_tools: Vec::new(),
        execution_mode: "agent".to_string(),
        litellm_base_url: String::new(),
        knowledge_endpoint: String::new(),
        schedule_endpoint: String::new(),
        employee_id: String::new(),
        team_id: String::new(),
        knowledge_base_refs: Some(Vec::new()),
        model: "host-health-probe".to_string(),
        memory_context: String::new(),
        credential_digest: credential_digest("", ""),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut process =
            HarnessProcess::start_uninitialized(&app, fingerprint, String::new(), String::new())?;
        let result = process.request("host.health", None, None);
        process.shutdown();
        serde_json::from_value(result?)
            .map_err(|error| format!("Harness Host 健康响应无效：{error}"))
    })
    .await
    .map_err(|error| format!("Harness Host 健康检查线程异常：{error}"))?
}

impl HarnessManager {
    fn run(
        &self,
        task_id: &str,
        app: &tauri::AppHandle,
        fingerprint: RuntimeFingerprint,
        turn: HarnessTurnInput,
        model_api_key: String,
        access_token: String,
    ) -> Result<HarnessRunResult, String> {
        let slot = self.slot(task_id)?;
        let mut guard = slot
            .process
            .lock()
            .map_err(|_| "Harness 进程状态不可用".to_string())?;
        if guard
            .as_ref()
            .is_some_and(|process| process.fingerprint != fingerprint)
            && let Some(mut process) = guard.take()
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
                access_token,
                Arc::clone(&self.approvals),
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
            Some(task_id) => self.approvals.reject_task(task_id),
            None => self.approvals.reject_all(),
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
        let slot = self
            .slots
            .lock()
            .map_err(|_| "Harness 任务池不可用".to_string())?
            .get(task_id)
            .cloned();
        let Some(slot) = slot else { return Ok(false) };
        slot.cancel()
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

impl HarnessProcess {
    pub(crate) fn start(
        app: &tauri::AppHandle,
        fingerprint: RuntimeFingerprint,
        model_api_key: String,
        access_token: String,
    ) -> Result<Self, String> {
        Self::start_internal(
            app,
            fingerprint,
            model_api_key,
            access_token,
            true,
            None,
            None,
        )
    }

    fn start_for_task(
        app: &tauri::AppHandle,
        task_id: &str,
        fingerprint: RuntimeFingerprint,
        model_api_key: String,
        access_token: String,
        approval_broker: Arc<ApprovalBroker>,
    ) -> Result<Self, String> {
        Self::start_internal(
            app,
            fingerprint,
            model_api_key,
            access_token,
            false,
            Some(task_id),
            Some(approval_broker),
        )
    }

    fn start_uninitialized(
        app: &tauri::AppHandle,
        fingerprint: RuntimeFingerprint,
        model_api_key: String,
        access_token: String,
    ) -> Result<Self, String> {
        Self::start_internal(
            app,
            fingerprint,
            model_api_key,
            access_token,
            false,
            None,
            None,
        )
    }

    fn start_internal(
        app: &tauri::AppHandle,
        fingerprint: RuntimeFingerprint,
        model_api_key: String,
        access_token: String,
        initialize: bool,
        task_id: Option<&str>,
        approval_broker: Option<Arc<ApprovalBroker>>,
    ) -> Result<Self, String> {
        let runtime = resolve_runtime_paths(app)?;
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("无法确定 Harness 数据目录：{error}"))?;
        let dsh_home = app_data.join("harness");
        let browser_home = task_id.map(|task_id| {
            let mut hasher = Sha256::new();
            hasher.update(task_id.as_bytes());
            app_data
                .join("harness-browser")
                .join(format!("{:x}", hasher.finalize()))
        });
        let workspace = app_data.join("workspace");
        std::fs::create_dir_all(&dsh_home)
            .and_then(|_| std::fs::create_dir_all(&workspace))
            .map_err(|error| format!("无法创建 Harness 数据目录：{error}"))?;
        let session_workspace = fingerprint
            .local_file_roots
            .first()
            .map(|root| PathBuf::from(&root.path))
            .filter(|path| path.is_dir())
            .unwrap_or_else(|| workspace.clone());

        let skill_directories = serde_json::to_string(&fingerprint.skill_directories)
            .map_err(|error| format!("无法生成技能配置：{error}"))?;
        let connectors = serde_json::to_string(&fingerprint.connectors)
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
                app_data.join("im-channels/dingtalk-sessions.json"),
            )
            .env("DSH_CUSTOM_SKILL_DIRS", skill_directories)
            .env("XIAOYIN_EXECUTION_MODE", &fingerprint.execution_mode)
            .env("XIAOYIN_MCP_CONNECTORS", connectors)
            .env("XIAOYIN_EMPLOYEE_BEARER_TOKEN", access_token)
            .env("XIAOYIN_EMPLOYEE_ID", &fingerprint.employee_id)
            .env("XIAOYIN_TEAM_ID", &fingerprint.team_id)
            .env(
                "XIAOYIN_KNOWLEDGE_ENDPOINT",
                &fingerprint.knowledge_endpoint,
            )
            .env("XIAOYIN_SCHEDULE_ENDPOINT", &fingerprint.schedule_endpoint)
            .env("XIAOYIN_KNOWLEDGE_BASE_REFS", knowledge_base_refs)
            .env("XIAOYIN_LOCAL_FILE_ROOTS", local_file_roots)
            .env("XIAOYIN_ATTACHMENT_ROOT", dsh_home.join("attachments"))
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
        let mut process = Self {
            app: app.clone(),
            erp_session_epoch: crate::erp_auth::mcp::session_epoch(),
            child,
            stdin,
            stdout: BufReader::new(stdout),
            stderr_tail,
            stderr_reader,
            next_id: 1,
            notification_task_id: String::new(),
            fingerprint,
            approval_broker,
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
            params["sessionId"] = Value::String(session_id);
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

        loop {
            let mut line = String::new();
            let bytes = self
                .stdout
                .read_line(&mut line)
                .map_err(|error| format!("无法读取 Harness 响应：{error}"))?;
            if bytes == 0 {
                let status = self.child.try_wait().ok().flatten();
                if status.is_some() {
                    self.finish_stderr_capture();
                }
                let detail = self
                    .stderr_tail
                    .lock()
                    .map(|value| value.clone())
                    .unwrap_or_default();
                return Err(unexpected_exit_message(status, &detail));
            }
            let output: Value = serde_json::from_str(&line)
                .map_err(|error| format!("Harness 输出不是有效 JSON-RPC：{error}"))?;
            if output.get("method").is_some() {
                if matches!(
                    output.get("method").and_then(Value::as_str),
                    Some("erp-cookie.request" | "connector-oauth.request")
                ) {
                    let oauth = output["method"] == "connector-oauth.request";
                    let params = &output["params"];
                    let id = params["requestId"].as_str().unwrap_or("");
                    if id.is_empty() || id.len() > 100 {
                        return Err("ERP 会话请求标识无效".into());
                    }
                    let connector_id = params["connectorId"].as_str().unwrap_or("");
                    let connector = self
                        .fingerprint
                        .connectors
                        .iter()
                        .find(|value| value.id == connector_id);
                    let result = if oauth {
                        crate::connector_oauth::token_result(
                            &self.app,
                            connector,
                            params["url"].as_str().unwrap_or(""),
                            &self.fingerprint.employee_id,
                            self.erp_session_epoch,
                            params["rejectedToken"].as_str(),
                        )
                    } else {
                        tauri::async_runtime::block_on(crate::erp_auth::mcp::cookie_result(
                            &self.app,
                            connector,
                            params["url"].as_str().unwrap_or(""),
                            &self.fingerprint.employee_id,
                            self.erp_session_epoch,
                        ))
                    };
                    // This response stays on private IPC and never becomes a task notification.
                    serde_json::to_writer(
                        &mut self.stdin,
                        &json!({
                            "jsonrpc": "2.0", "id": null, "method": if oauth { "connector-oauth.respond" } else { "erp-cookie.respond" },
                            "params": {"requestId": id, "result": result}
                        }),
                    )
                    .map_err(|_| "无法发送 ERP 会话响应".to_string())?;
                    self.stdin
                        .write_all(b"\n")
                        .and_then(|_| self.stdin.flush())
                        .map_err(|_| "无法发送 ERP 会话响应".to_string())?;
                    continue;
                }
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
                        let _ = app.emit(
                            "xiaoyin://harness-notification",
                            ui_notification(&self.notification_task_id, request_id, event),
                        );
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
                        let _ = app.emit(
                            "xiaoyin://harness-notification",
                            ui_notification(&self.notification_task_id, request_id, event),
                        );
                    }
                    continue;
                }
                if let Some(app) = app {
                    let event = output.get("params").cloned().unwrap_or(Value::Null);
                    let _ = app.emit(
                        "xiaoyin://harness-notification",
                        ui_notification(&self.notification_task_id, request_id, event),
                    );
                }
                continue;
            }
            if output.get("id").and_then(Value::as_u64) != Some(request_id) {
                continue;
            }
            if let Some(error) = output.get("error") {
                let message = error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Harness 执行失败");
                return Err(message.to_string());
            }
            return output
                .get("result")
                .cloned()
                .ok_or_else(|| "Harness 响应缺少 result".to_string());
        }
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

    pub(crate) fn shutdown(&mut self) {
        let _ = self.request("host.shutdown", None, None);
        self.kill();
    }

    fn kill(&mut self) {
        let _ = terminate_process(self.child.id());
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.finish_stderr_capture();
    }

    fn finish_stderr_capture(&mut self) {
        if let Some(reader) = self.stderr_reader.take() {
            let _ = reader.join();
        }
    }
}

const MAX_HARNESS_STDERR_CHARS: usize = 16 * 1024;
const MAX_HARNESS_ERROR_CHARS: usize = 1_200;

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
    if request.employee_id.trim().is_empty()
        || request.employee_id.len() > 512
        || request.employee_id.chars().any(char::is_control)
    {
        return Err("员工标识无效".to_string());
    }
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
    validate_connector_catalog(&request.connectors)?;
    expert_kits::validate_allowed_artifacts(&request.allowed_artifacts)?;
    if request.attachments.len() > 16 {
        return Err("单条消息最多添加 16 个附件".to_string());
    }
    if request.model.trim().is_empty() || request.model.len() > 200 {
        return Err("模型名称无效".to_string());
    }
    if request.model_api_key.trim().is_empty()
        || request.model_api_key.len() > 16 * 1024
        || request.model_api_key.chars().any(char::is_control)
    {
        return Err("模型访问凭据无效".to_string());
    }
    if request.access_token.len() > 16 * 1024 || request.access_token.chars().any(char::is_control)
    {
        return Err("ERP 访问凭据无效".to_string());
    }
    Ok(())
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

fn validate_access_token(access_token: &str) -> Result<(), String> {
    if access_token.len() > 16 * 1024 || access_token.chars().any(char::is_control) {
        return Err("ERP 访问凭据无效".to_string());
    }
    Ok(())
}

pub(crate) fn credential_digest(model_api_key: &str, access_token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update((model_api_key.len() as u64).to_be_bytes());
    hasher.update(model_api_key.as_bytes());
    hasher.update((access_token.len() as u64).to_be_bytes());
    hasher.update(access_token.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_without_active_run_is_a_noop() {
        assert_eq!(HarnessManager::default().cancel("missing-task"), Ok(false));
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
    fn native_bridge_preserves_task_outcome_and_accepts_legacy_responses() {
        let outcome = json!({ "status": "needs_input", "summary": "缺少月份",
            "remaining": ["提供统计月份"], "checks": [] });
        let result: HarnessRunResult = serde_json::from_value(json!({
            "sessionId": "session-1", "finalResponse": "请补充月份", "outcome": outcome
        }))
        .unwrap();
        assert_eq!(serde_json::to_value(result).unwrap()["outcome"], outcome);
        let legacy: HarnessRunResult = serde_json::from_value(json!({
            "sessionId": "session-1", "finalResponse": "旧回复"
        }))
        .unwrap();
        assert!(
            serde_json::to_value(legacy)
                .unwrap()
                .get("outcome")
                .is_none()
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
        let bridged = serde_json::to_value(ui_notification("task-1", 7, host_params.clone()))
            .expect("notification should serialize");
        assert_eq!(bridged["taskId"], "task-1");
        assert_eq!(bridged["requestId"], 7);
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
            employee_id: "employee-1".to_string(),
            team_id: "crossborder".to_string(),
            session_id: None,
            selected_extensions: Vec::new(),
            knowledge_base_refs: Vec::new(),
            allowed_artifacts: Vec::new(),
            litellm_base_url: "http://litellm.internal/v1".to_string(),
            knowledge_endpoint: "http://xiaoyin-server.internal/api/v1/knowledge-bases".to_string(),
            schedule_endpoint: "http://xiaoyin-server.internal/api/v1/schedules".to_string(),
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
                command: String::new(),
                arguments: Vec::new(),
                environment: std::collections::HashMap::new(),
                headers: std::collections::HashMap::new(),
                enabled: true,
            }],
            model: "deepseek-chat".to_string(),
            model_api_key: "model-token".to_string(),
            access_token: "erp-token".to_string(),
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
        let catalog = vec![
            ConnectorDefinition {
                timeout_seconds: None,
                id: "erp-mcp".to_string(),
                name: "ERP".to_string(),
                status: "ready".to_string(),
                version: "1".to_string(),
                transport: "streamable-http".to_string(),
                url: "http://erp.internal/mcp".to_string(),
                auth_mode: "employee-bearer".to_string(),
                tool_names: vec!["sales_summary".to_string(), "order_cancel".to_string()],
                command: String::new(),
                arguments: Vec::new(),
                environment: std::collections::HashMap::new(),
                headers: std::collections::HashMap::new(),
                enabled: true,
            },
            ConnectorDefinition {
                id: "desktop-browser".to_string(),
                timeout_seconds: None,
                name: "浏览器".to_string(),
                status: "ready".to_string(),
                version: "1".to_string(),
                transport: "desktop".to_string(),
                url: String::new(),
                auth_mode: "none".to_string(),
                tool_names: vec!["browser_open".to_string()],
                command: String::new(),
                arguments: Vec::new(),
                environment: std::collections::HashMap::new(),
                headers: std::collections::HashMap::new(),
                enabled: false,
            },
        ];
        let profile = expert_kits::ExpertKitHarnessProfile {
            skill_directories: Vec::new(),
            knowledge_base_refs: Some(vec!["organization:operations-sop".to_string()]),
            required_connector_tools: vec!["sales_summary".to_string(), "browser_open".to_string()],
            allowed_computer_tools: Vec::new(),
            prompt: String::new(),
        };

        let runtime =
            runtime_connectors(&catalog, &profile, true).expect("connector should resolve");
        assert_eq!(runtime.len(), 1);
        assert_eq!(
            runtime[0].allowed_tools,
            vec!["sales_summary", "order_cancel"]
        );
        assert_eq!(runtime[0].required_tools, vec!["sales_summary"]);
        assert!(!runtime[0].required);
        assert!(runtime[0].allow_write);
        assert!(runtime[0].require_write_approval);
    }

    #[test]
    fn diagnostics_include_only_ready_remote_connectors_and_all_declared_tools() {
        let catalog = vec![
            ConnectorDefinition {
                timeout_seconds: None,
                id: "erp-mcp".to_string(),
                name: "ERP".to_string(),
                status: "ready".to_string(),
                version: "2".to_string(),
                transport: "streamable-http".to_string(),
                url: "http://erp.internal/mcp".to_string(),
                auth_mode: "employee-bearer".to_string(),
                tool_names: vec!["sales_summary".to_string(), "inventory_risk".to_string()],
                command: String::new(),
                arguments: Vec::new(),
                environment: std::collections::HashMap::new(),
                headers: std::collections::HashMap::new(),
                enabled: false,
            },
            ConnectorDefinition {
                id: "local-files".to_string(),
                timeout_seconds: None,
                name: "本地文件".to_string(),
                status: "ready".to_string(),
                version: "1".to_string(),
                transport: "desktop".to_string(),
                url: String::new(),
                auth_mode: "none".to_string(),
                tool_names: vec!["local_file_read".to_string()],
                command: String::new(),
                arguments: Vec::new(),
                environment: std::collections::HashMap::new(),
                headers: std::collections::HashMap::new(),
                enabled: false,
            },
        ];

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
