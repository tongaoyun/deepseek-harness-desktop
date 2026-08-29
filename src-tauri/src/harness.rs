use crate::{expert_kits, local_files::LocalFileAuthorizations, memory};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[derive(Clone, Default)]
pub struct HarnessManager {
    process: Arc<Mutex<Option<HarnessProcess>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessRunRequest {
    prompt: String,
    employee_id: String,
    team_id: String,
    session_id: Option<String>,
    expert_kit_id: Option<String>,
    litellm_base_url: String,
    knowledge_endpoint: String,
    #[serde(default)]
    connectors: Vec<ConnectorDefinition>,
    model: String,
    model_api_key: String,
    access_token: String,
    #[serde(default)]
    local_file_root_ids: Vec<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectorDefinition {
    id: String,
    name: String,
    status: String,
    version: String,
    transport: String,
    url: String,
    auth_mode: String,
    #[serde(default)]
    tool_names: Vec<String>,
}

#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeConnector {
    id: String,
    name: String,
    version: String,
    transport: String,
    url: String,
    auth_mode: String,
    allowed_tools: Vec<String>,
    required_tools: Vec<String>,
    allow_write: bool,
    required: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessRunResult {
    session_id: String,
    final_response: String,
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
    pub(crate) allow_local_files: bool,
    pub(crate) allow_shell: bool,
    pub(crate) litellm_base_url: String,
    pub(crate) knowledge_endpoint: String,
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
    let profile = expert_kits::harness_profile(
        &app,
        request.expert_kit_id.as_deref(),
        request.prompt.trim(),
    )?;
    if !profile.allow_local_files && !profile.allow_shell && !request.local_file_root_ids.is_empty()
    {
        return Err("当前专家套件禁止使用本地目录".to_string());
    }
    let local_file_roots = local_files.resolve(&request.local_file_root_ids)?;
    let connectors = runtime_connectors(
        &request.connectors,
        &profile,
        request.expert_kit_id.is_some(),
    )?;
    let fingerprint = RuntimeFingerprint {
        skill_directories: profile.skill_directories,
        connectors,
        local_file_roots,
        allow_local_files: profile.allow_local_files,
        allow_shell: profile.allow_shell,
        litellm_base_url: request.litellm_base_url,
        knowledge_endpoint: request.knowledge_endpoint,
        employee_id: request.employee_id.clone(),
        team_id: request.team_id,
        knowledge_base_refs: profile.knowledge_base_refs,
        model: request.model,
        memory_context: memory::context(&app, &request.employee_id)?,
        credential_digest: credential_digest(&request.model_api_key, &request.access_token),
    };
    let session_id = request.session_id;
    let model_api_key = request.model_api_key;
    let access_token = request.access_token;
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.run(
            &app,
            fingerprint,
            profile.prompt,
            session_id,
            model_api_key,
            access_token,
        )
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

impl HarnessManager {
    fn run(
        &self,
        app: &tauri::AppHandle,
        fingerprint: RuntimeFingerprint,
        prompt: String,
        session_id: Option<String>,
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
        match process.run(app, prompt, session_id) {
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
}

impl HarnessProcess {
    pub(crate) fn start(
        app: &tauri::AppHandle,
        fingerprint: RuntimeFingerprint,
        model_api_key: String,
        access_token: String,
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

        let skill_directories = serde_json::to_string(&fingerprint.skill_directories)
            .map_err(|error| format!("无法生成 Skill 配置：{error}"))?;
        let connectors = serde_json::to_string(&fingerprint.connectors)
            .map_err(|error| format!("无法生成连接器配置：{error}"))?;
        let local_file_roots = serde_json::to_string(&fingerprint.local_file_roots)
            .map_err(|error| format!("无法生成本地文件授权配置：{error}"))?;
        let knowledge_base_refs = serde_json::to_string(&fingerprint.knowledge_base_refs)
            .map_err(|error| format!("无法生成知识库范围配置：{error}"))?;
        let mut child = Command::new(&runtime.node)
            .arg(&runtime.entry)
            .current_dir(&workspace)
            .env("DSH_CORDIS_CONFIG", &runtime.config)
            .env("DSH_CWD", &workspace)
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
            .env("XIAOYIN_KNOWLEDGE_ENDPOINT", &fingerprint.knowledge_endpoint)
            .env("XIAOYIN_KNOWLEDGE_BASE_REFS", knowledge_base_refs)
            .env("XIAOYIN_LOCAL_FILE_ROOTS", local_file_roots)
            .env(
                "XIAOYIN_ALLOW_LOCAL_FILES",
                fingerprint.allow_local_files.to_string(),
            )
            .env("XIAOYIN_ALLOW_SHELL", fingerprint.allow_shell.to_string())
            .env("DEEPSEEK_BASE_URL", &fingerprint.litellm_base_url)
            .env("DEEPSEEK_API_KEY", model_api_key)
            .env("DSH_MODEL", &fingerprint.model)
            .env("XIAOYIN_MEMORY_CONTEXT", &fingerprint.memory_context)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
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
        let mut process = Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
            fingerprint,
        };
        process.request("host.initialize", None, None)?;
        Ok(process)
    }

    fn run(
        &mut self,
        app: &tauri::AppHandle,
        prompt: String,
        session_id: Option<String>,
    ) -> Result<HarnessRunResult, String> {
        let mut params = json!({ "prompt": prompt });
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
                return Err("Harness Host 意外退出".to_string());
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
    }

    fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
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
    validate_connector_catalog(&request.connectors)?;
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

pub(crate) fn runtime_connectors(
    catalog: &[ConnectorDefinition],
    profile: &expert_kits::ExpertKitHarnessProfile,
    expert_kit_selected: bool,
) -> Result<Vec<RuntimeConnector>, String> {
    validate_connector_catalog(catalog)?;
    let by_id = catalog
        .iter()
        .map(|connector| (connector.id.as_str(), connector))
        .collect::<HashMap<_, _>>();
    let selected = if expert_kit_selected {
        let mut values = Vec::new();
        for connector_id in &profile.connector_refs {
            let connector = by_id
                .get(connector_id.as_str())
                .ok_or_else(|| format!("专家套件引用了未发布的连接器：{connector_id}"))?;
            if connector.transport == "desktop" {
                continue;
            }
            if connector.status != "ready" {
                return Err(format!("专家套件连接器尚未就绪：{}", connector.name));
            }
            values.push(*connector);
        }
        values
    } else {
        catalog
            .iter()
            .filter(|connector| connector.transport != "desktop" && connector.status == "ready")
            .collect::<Vec<_>>()
    };

    let allowed_tools = profile
        .allowed_connector_tools
        .iter()
        .cloned()
        .collect::<HashSet<_>>();
    let connector_tools = selected
        .iter()
        .map(|connector| {
            let tools = connector
                .tool_names
                .iter()
                .filter(|tool| !expert_kit_selected || allowed_tools.contains(*tool))
                .cloned()
                .collect::<Vec<_>>();
            (connector.id.as_str(), tools)
        })
        .collect::<HashMap<_, _>>();
    let mut claimed_tools = HashMap::<String, String>::new();
    for connector in &selected {
        for tool in connector_tools
            .get(connector.id.as_str())
            .expect("selected connector tools were computed")
        {
            if let Some(owner) = claimed_tools.insert(tool.clone(), connector.id.clone()) {
                return Err(format!(
                    "连接器工具名冲突：{tool} 同时由 {owner} 和 {} 提供",
                    connector.id
                ));
            }
        }
    }
    let available_tools = claimed_tools.keys().cloned().collect::<HashSet<_>>();
    let missing = profile
        .required_connector_tools
        .iter()
        .filter(|tool| !available_tools.contains(*tool))
        .cloned()
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(format!(
            "专家套件缺少可用连接器工具：{}",
            missing.join(", ")
        ));
    }

    Ok(selected
        .into_iter()
        .map(|connector| RuntimeConnector {
            id: connector.id.clone(),
            name: connector.name.clone(),
            version: connector.version.clone(),
            transport: connector.transport.clone(),
            url: connector.url.clone(),
            auth_mode: connector.auth_mode.clone(),
            allowed_tools: connector_tools
                .get(connector.id.as_str())
                .expect("selected connector tools were computed")
                .clone(),
            required_tools: profile
                .required_connector_tools
                .iter()
                .filter(|tool| connector.tool_names.contains(*tool))
                .cloned()
                .collect(),
            allow_write: expert_kit_selected && profile.allow_connector_write,
            required: expert_kit_selected,
        })
        .collect())
}

fn validate_connector_catalog(connectors: &[ConnectorDefinition]) -> Result<(), String> {
    if connectors.len() > 32 {
        return Err("连接器数量不能超过 32 个".to_string());
    }
    let mut connector_ids = HashSet::new();
    for connector in connectors {
        if !valid_identifier(&connector.id) || !connector_ids.insert(connector.id.as_str()) {
            return Err(format!("连接器 ID 无效或重复：{}", connector.id));
        }
        if connector.name.trim().is_empty() || connector.name.len() > 200 {
            return Err(format!("连接器名称无效：{}", connector.id));
        }
        if connector.version.trim().is_empty() || connector.version.len() > 100 {
            return Err(format!("连接器版本无效：{}", connector.id));
        }
        if !matches!(
            connector.status.as_str(),
            "ready" | "needs-configuration" | "unavailable" | "disabled"
        ) {
            return Err(format!("连接器状态无效：{}", connector.id));
        }
        if !matches!(
            connector.transport.as_str(),
            "streamable-http" | "sse" | "desktop"
        ) {
            return Err(format!("连接器传输方式无效：{}", connector.id));
        }
        if !matches!(connector.auth_mode.as_str(), "employee-bearer" | "none") {
            return Err(format!("连接器认证方式无效：{}", connector.id));
        }
        if connector.transport == "desktop" {
            if !connector.url.is_empty() {
                return Err(format!("桌面内置连接器不能配置远程地址：{}", connector.id));
            }
        } else if connector.status == "ready" {
            validate_http_url("连接器", &connector.url)?;
        }
        if connector.tool_names.len() > 512 {
            return Err(format!("连接器工具数量超限：{}", connector.id));
        }
        let mut tools = HashSet::new();
        for tool in &connector.tool_names {
            if !valid_identifier(tool) || !tools.insert(tool.as_str()) {
                return Err(format!("连接器工具名称无效或重复：{tool}"));
            }
        }
    }
    Ok(())
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'.' | b'_' | b'-'))
}

pub(crate) fn credential_digest(model_api_key: &str, access_token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update((model_api_key.len() as u64).to_be_bytes());
    hasher.update(model_api_key.as_bytes());
    hasher.update((access_token.len() as u64).to_be_bytes());
    hasher.update(access_token.as_bytes());
    format!("{:x}", hasher.finalize())
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
    fn run_request_requires_safe_endpoints_and_model() {
        let valid = HarnessRunRequest {
            prompt: "分析库存".to_string(),
            employee_id: "employee-1".to_string(),
            team_id: "crossborder".to_string(),
            session_id: None,
            expert_kit_id: None,
            litellm_base_url: "http://litellm.internal/v1".to_string(),
            knowledge_endpoint: "http://control-plane.internal/api/v1/knowledge-bases".to_string(),
            connectors: vec![ConnectorDefinition {
                id: "erp-mcp".to_string(),
                name: "ERP".to_string(),
                status: "ready".to_string(),
                version: "1".to_string(),
                transport: "streamable-http".to_string(),
                url: "http://erp.internal/mcp".to_string(),
                auth_mode: "employee-bearer".to_string(),
                tool_names: vec!["sales_summary".to_string()],
            }],
            model: "deepseek-chat".to_string(),
            model_api_key: "model-token".to_string(),
            access_token: "erp-token".to_string(),
            local_file_root_ids: Vec::new(),
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
    fn expert_kit_connectors_expose_only_manifest_tools() {
        let catalog = vec![ConnectorDefinition {
            id: "erp-mcp".to_string(),
            name: "ERP".to_string(),
            status: "ready".to_string(),
            version: "1".to_string(),
            transport: "streamable-http".to_string(),
            url: "http://erp.internal/mcp".to_string(),
            auth_mode: "employee-bearer".to_string(),
            tool_names: vec!["sales_summary".to_string(), "order_cancel".to_string()],
        }];
        let profile = expert_kits::ExpertKitHarnessProfile {
            skill_directories: Vec::new(),
            connector_refs: vec!["erp-mcp".to_string()],
            knowledge_base_refs: Some(vec!["organization:operations-sop".to_string()]),
            allowed_connector_tools: vec!["sales_summary".to_string()],
            required_connector_tools: vec!["sales_summary".to_string()],
            allow_local_files: false,
            allow_shell: false,
            allow_connector_write: false,
            prompt: String::new(),
        };

        let runtime =
            runtime_connectors(&catalog, &profile, true).expect("connector should resolve");
        assert_eq!(runtime.len(), 1);
        assert_eq!(runtime[0].allowed_tools, vec!["sales_summary"]);
        assert_eq!(runtime[0].required_tools, vec!["sales_summary"]);
        assert!(runtime[0].required);
        assert!(!runtime[0].allow_write);
    }

    #[test]
    fn approval_requests_are_validated_and_control_characters_are_removed() {
        let value = json!({
            "approvalId": "approval-1",
            "toolName": "local_shell_run",
            "reason": "运行命令\u{0007}\nls"
        });
        let approval = parse_approval_request(Some(&value)).expect("approval should parse");
        assert_eq!(approval.approval_id, "approval-1");
        assert_eq!(approval.tool_name, "local_shell_run");
        assert_eq!(approval.reason, "运行命令 \nls");
        assert!(approval_message(&approval).contains("仅本次允许"));
    }
}
