pub(crate) use crate::harness_connectors::{
    ConnectorDefinition, RuntimeConnector, runtime_connectors,
};
use crate::harness_connectors::{
    desktop_connector_enabled, diagnostic_connectors, validate_connector_catalog, validate_http_url,
};
use crate::{expert_kits, local_files::LocalFileAuthorizations, memory};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, Ordering},
    },
    thread::JoinHandle,
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[derive(Clone, Default)]
pub struct HarnessManager {
    process: Arc<Mutex<Option<HarnessProcess>>>,
    active_pid: Arc<AtomicU32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessRunRequest {
    prompt: String,
    employee_id: String,
    team_id: String,
    session_id: Option<String>,
    selected_extension: Option<ExtensionSelection>,
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
    prompt: String,
    session_id: Option<String>,
    images: Vec<HarnessImageInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExtensionSelection {
    kind: String,
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorDiagnosticRequest {
    #[serde(default)]
    connectors: Vec<ConnectorDefinition>,
    access_token: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessRunResult {
    session_id: String,
    final_response: String,
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
    request_id: u64,
    event: Value,
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct RuntimeFingerprint {
    pub(crate) skill_directories: Vec<String>,
    pub(crate) connectors: Vec<RuntimeConnector>,
    pub(crate) local_file_roots: Vec<String>,
    pub(crate) allow_browser: bool,
    pub(crate) allowed_computer_tools: Vec<String>,
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
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    stderr_tail: Arc<Mutex<String>>,
    stderr_reader: Option<JoinHandle<()>>,
    next_id: u64,
    pub(crate) fingerprint: RuntimeFingerprint,
}

#[derive(Debug, Eq, PartialEq)]
struct HarnessRuntimePaths {
    node: PathBuf,
    entry: PathBuf,
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
    let (attachment_context, images) = prepare_attachments(&local_files, &request.attachments)?;
    let user_prompt = if attachment_context.is_empty() {
        request.prompt.trim().to_string()
    } else {
        format!("{}\n\n{}", request.prompt.trim(), attachment_context)
    };
    let profile = expert_kits::harness_profile(
        &app,
        request
            .selected_extension
            .as_ref()
            .map(|selection| selection.kind.as_str()),
        request
            .selected_extension
            .as_ref()
            .map(|selection| selection.id.as_str()),
        &request.knowledge_base_refs,
        &user_prompt,
        &request.allowed_artifacts,
    )?;
    let local_file_roots = local_files.resolve(&request.local_file_root_ids)?;
    let allow_browser = desktop_connector_enabled(&request.connectors, "desktop-browser");
    let connectors = runtime_connectors(&request.connectors, &profile)?;
    let fingerprint = RuntimeFingerprint {
        skill_directories: profile.skill_directories,
        connectors,
        local_file_roots,
        allow_browser,
        allowed_computer_tools: profile.allowed_computer_tools,
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
        prompt: profile.prompt,
        session_id: request.session_id,
        images,
    };
    let model_api_key = request.model_api_key;
    let access_token = request.access_token;
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.run(&app, fingerprint, turn, model_api_key, access_token)
    })
    .await
    .map_err(|error| format!("Harness 执行线程异常：{error}"))?
}

#[tauri::command]
pub async fn shutdown_harness(manager: tauri::State<'_, HarnessManager>) -> Result<(), String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.shutdown())
        .await
        .map_err(|error| format!("Harness 关闭线程异常：{error}"))?
}

#[tauri::command]
pub fn cancel_harness(manager: tauri::State<'_, HarnessManager>) -> Result<bool, String> {
    manager.cancel()
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
        litellm_base_url: String::new(),
        knowledge_endpoint: String::new(),
        schedule_endpoint: String::new(),
        employee_id: String::new(),
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
        app: &tauri::AppHandle,
        fingerprint: RuntimeFingerprint,
        turn: HarnessTurnInput,
        model_api_key: String,
        access_token: String,
    ) -> Result<HarnessRunResult, String> {
        let mut guard = self
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
        if guard.is_none() {
            *guard = Some(HarnessProcess::start(
                app,
                fingerprint,
                model_api_key,
                access_token,
            )?);
        }
        let process = guard.as_mut().expect("Harness process was initialized");
        self.active_pid.store(process.child.id(), Ordering::Release);
        let result = process.run(app, turn.prompt, turn.session_id, turn.images);
        self.active_pid.store(0, Ordering::Release);
        match result {
            Ok(result) => Ok(result),
            Err(error) => {
                process.kill();
                *guard = None;
                Err(error)
            }
        }
    }

    fn shutdown(&self) -> Result<(), String> {
        let mut guard = self
            .process
            .lock()
            .map_err(|_| "Harness 进程状态不可用".to_string())?;
        if let Some(mut process) = guard.take() {
            process.shutdown();
        }
        Ok(())
    }

    fn cancel(&self) -> Result<bool, String> {
        let pid = self.active_pid.load(Ordering::Acquire);
        if pid == 0 {
            return Ok(false);
        }
        #[cfg(target_os = "windows")]
        {
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
            let status = Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map_err(|error| format!("无法取消当前任务：{error}"))?;
            Ok(status.success())
        }
    }
}

impl HarnessProcess {
    pub(crate) fn start(
        app: &tauri::AppHandle,
        fingerprint: RuntimeFingerprint,
        model_api_key: String,
        access_token: String,
    ) -> Result<Self, String> {
        Self::start_internal(app, fingerprint, model_api_key, access_token, true)
    }

    fn start_uninitialized(
        app: &tauri::AppHandle,
        fingerprint: RuntimeFingerprint,
        model_api_key: String,
        access_token: String,
    ) -> Result<Self, String> {
        Self::start_internal(app, fingerprint, model_api_key, access_token, false)
    }

    fn start_internal(
        app: &tauri::AppHandle,
        fingerprint: RuntimeFingerprint,
        model_api_key: String,
        access_token: String,
        initialize: bool,
    ) -> Result<Self, String> {
        let runtime = resolve_runtime_paths(app)?;
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("无法确定 Harness 数据目录：{error}"))?;
        let dsh_home = app_data.join("harness");
        let workspace = app_data.join("workspace");
        std::fs::create_dir_all(&dsh_home)
            .and_then(|_| std::fs::create_dir_all(&workspace))
            .map_err(|error| format!("无法创建 Harness 数据目录：{error}"))?;
        let session_workspace = fingerprint
            .local_file_roots
            .first()
            .map(PathBuf::from)
            .filter(|path| path.is_dir())
            .unwrap_or_else(|| workspace.clone());

        let skill_directories = serde_json::to_string(&fingerprint.skill_directories)
            .map_err(|error| format!("无法生成 Skill 配置：{error}"))?;
        let connectors = serde_json::to_string(&fingerprint.connectors)
            .map_err(|error| format!("无法生成连接器配置：{error}"))?;
        let local_file_roots = serde_json::to_string(&fingerprint.local_file_roots)
            .map_err(|error| format!("无法生成本地文件授权配置：{error}"))?;
        let knowledge_base_refs = serde_json::to_string(&fingerprint.knowledge_base_refs)
            .map_err(|error| format!("无法生成知识库范围配置：{error}"))?;
        let computer_tools = serde_json::to_string(&fingerprint.allowed_computer_tools)
            .map_err(|error| format!("无法生成 Computer Use 工具配置：{error}"))?;
        let mut command = Command::new(&runtime.node);
        #[cfg(target_os = "windows")]
        command.creation_flags(0x0800_0000);
        let mut child = command
            .arg(&runtime.entry)
            .current_dir(&session_workspace)
            .env("DSH_CORDIS_CONFIG", &runtime.config)
            .env("DSH_CWD", &session_workspace)
            .env("DSH_HOME", &dsh_home)
            .env("DSH_SESSION_ROOT", dsh_home.join("sessions"))
            .env(
                "XIAOYIN_IM_STATE_PATH",
                app_data.join("im-channels/dingtalk-sessions.json"),
            )
            .env("DSH_CUSTOM_SKILL_DIRS", skill_directories)
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
            child,
            stdin,
            stdout: BufReader::new(stdout),
            stderr_tail,
            stderr_reader,
            next_id: 1,
            fingerprint,
        };
        if initialize {
            process.request("host.initialize", None, None)?;
        }
        Ok(process)
    }

    fn run(
        &mut self,
        app: &tauri::AppHandle,
        prompt: String,
        session_id: Option<String>,
        images: Vec<HarnessImageInput>,
    ) -> Result<HarnessRunResult, String> {
        let mut params = json!({ "prompt": prompt, "images": images });
        if let Some(session_id) = session_id {
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
                if output.get("method").and_then(Value::as_str) == Some("approval.request") {
                    let approval = parse_approval_request(output.get("params"))?;
                    let decision = if let Some(app) = app {
                        let confirmed = app
                            .dialog()
                            .message(approval_message(&approval))
                            .title("小胤操作确认")
                            .kind(MessageDialogKind::Warning)
                            .buttons(MessageDialogButtons::YesNo)
                            .blocking_show();
                        if confirmed { "allow" } else { "reject" }
                    } else {
                        "reject"
                    };
                    self.send_approval_response(&approval.approval_id, decision)?;
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
                            HarnessUiNotification { request_id, event },
                        );
                    }
                    continue;
                }
                if let Some(app) = app {
                    let event = output.get("params").cloned().unwrap_or(Value::Null);
                    let _ = app.emit(
                        "xiaoyin://harness-notification",
                        HarnessUiNotification { request_id, event },
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
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.finish_stderr_capture();
    }

    fn kill(&mut self) {
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

fn approval_message(approval: &ApprovalPrompt) -> String {
    format!(
        "工具：{}\n\n{}\n\n仅本次允许该操作？",
        approval.tool_name, approval.reason
    )
}

impl Drop for HarnessProcess {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            self.kill();
        }
    }
}

fn resolve_runtime_paths(_app: &tauri::AppHandle) -> Result<HarnessRuntimePaths, String> {
    #[cfg(all(target_os = "windows", not(debug_assertions)))]
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

    #[cfg(not(all(target_os = "windows", not(debug_assertions))))]
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

#[cfg(not(all(target_os = "windows", not(debug_assertions))))]
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

#[cfg(any(all(target_os = "windows", not(debug_assertions)), test))]
fn packaged_runtime_paths(resource_dir: &Path) -> HarnessRuntimePaths {
    let root = resource_dir.join("resources/harness-runtime");
    HarnessRuntimePaths {
        node: root.join("node/node.exe"),
        entry: root.join("harness-host/dist/index.js"),
        config: root.join("harness-host/runtime/cordis.yml"),
    }
}

#[cfg(not(all(target_os = "windows", not(debug_assertions))))]
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
            if metadata.len() > 5 * 1024 * 1024 {
                return Err(format!("图片附件超过 5 MB：{}", attachment.name));
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
        assert_eq!(HarnessManager::default().cancel(), Ok(false));
    }

    #[test]
    fn run_request_requires_safe_endpoints_and_model() {
        let valid = HarnessRunRequest {
            prompt: "分析库存".to_string(),
            employee_id: "employee-1".to_string(),
            team_id: "crossborder".to_string(),
            session_id: None,
            selected_extension: None,
            knowledge_base_refs: Vec::new(),
            allowed_artifacts: Vec::new(),
            litellm_base_url: "http://litellm.internal/v1".to_string(),
            knowledge_endpoint: "http://control-plane.internal/api/v1/knowledge-bases".to_string(),
            schedule_endpoint: "http://control-plane.internal/api/v1/schedules".to_string(),
            connectors: vec![ConnectorDefinition {
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
            PathBuf::from(r"C:\Program Files\xiaoyin")
                .join("resources/harness-runtime/node/node.exe")
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

    #[test]
    fn ready_connectors_are_session_capabilities_and_declared_dependencies_are_advisory() {
        let catalog = vec![
            ConnectorDefinition {
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

        let runtime = runtime_connectors(&catalog, &profile).expect("connector should resolve");
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
        assert!(approval_message(&approval).contains("仅本次允许"));
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
