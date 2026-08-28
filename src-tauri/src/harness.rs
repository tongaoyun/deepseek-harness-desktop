use crate::{expert_kits, local_files::LocalFileAuthorizations};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
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
    session_id: Option<String>,
    expert_kit_id: Option<String>,
    litellm_base_url: String,
    erp_mcp_url: String,
    model: String,
    access_token: String,
    #[serde(default)]
    local_file_root_ids: Vec<String>,
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
    pub(crate) allowed_erp_tools: Vec<String>,
    pub(crate) required_erp_tools: Vec<String>,
    pub(crate) local_file_roots: Vec<String>,
    pub(crate) allow_local_files: bool,
    pub(crate) allow_shell: bool,
    pub(crate) allow_erp_write: bool,
    pub(crate) litellm_base_url: String,
    pub(crate) erp_mcp_url: String,
    pub(crate) model: String,
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
    let fingerprint = RuntimeFingerprint {
        skill_directories: profile.skill_directories,
        allowed_erp_tools: profile.allowed_erp_tools,
        required_erp_tools: profile.required_erp_tools,
        local_file_roots,
        allow_local_files: profile.allow_local_files,
        allow_shell: profile.allow_shell,
        allow_erp_write: profile.allow_erp_write,
        litellm_base_url: request.litellm_base_url,
        erp_mcp_url: request.erp_mcp_url,
        model: request.model,
        credential_digest: format!("{:x}", Sha256::digest(request.access_token.as_bytes())),
    };
    let session_id = request.session_id;
    let access_token = request.access_token;
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.run(&app, fingerprint, profile.prompt, session_id, access_token)
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
            *guard = Some(HarnessProcess::start(app, fingerprint, access_token)?);
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
        let allowed_tools = serde_json::to_string(&fingerprint.allowed_erp_tools)
            .map_err(|error| format!("无法生成 ERP 工具配置：{error}"))?;
        let required_tools = serde_json::to_string(&fingerprint.required_erp_tools)
            .map_err(|error| format!("无法生成 ERP 工具配置：{error}"))?;
        let local_file_roots = serde_json::to_string(&fingerprint.local_file_roots)
            .map_err(|error| format!("无法生成本地文件授权配置：{error}"))?;
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
            .env("ERP_MCP_URL", &fingerprint.erp_mcp_url)
            .env("ERP_MCP_ALLOWED_TOOLS", allowed_tools)
            .env("ERP_MCP_REQUIRED_TOOLS", required_tools)
            .env("ERP_MCP_BEARER_TOKEN", access_token)
            .env("XIAOYIN_LOCAL_FILE_ROOTS", local_file_roots)
            .env(
                "XIAOYIN_ALLOW_LOCAL_FILES",
                fingerprint.allow_local_files.to_string(),
            )
            .env("XIAOYIN_ALLOW_SHELL", fingerprint.allow_shell.to_string())
            .env(
                "ERP_MCP_ALLOW_WRITE",
                fingerprint.allow_erp_write.to_string(),
            )
            .env("DEEPSEEK_BASE_URL", &fingerprint.litellm_base_url)
            .env("DSH_MODEL", &fingerprint.model)
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
    if request.prompt.trim().is_empty() || request.prompt.len() > 1024 * 1024 {
        return Err("消息不能为空且不能超过 1 MiB".to_string());
    }
    validate_http_url("LiteLLM", &request.litellm_base_url)?;
    if !request.erp_mcp_url.trim().is_empty() {
        validate_http_url("ERP MCP", &request.erp_mcp_url)?;
    }
    if request.model.trim().is_empty() || request.model.len() > 200 {
        return Err("模型名称无效".to_string());
    }
    if request.access_token.len() > 16 * 1024 || request.access_token.chars().any(char::is_control)
    {
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
    fn run_request_requires_safe_endpoints_and_model() {
        let valid = HarnessRunRequest {
            prompt: "分析库存".to_string(),
            session_id: None,
            expert_kit_id: None,
            litellm_base_url: "http://litellm.internal/v1".to_string(),
            erp_mcp_url: "http://erp.internal/mcp".to_string(),
            model: "deepseek-chat".to_string(),
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
