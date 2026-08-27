use crate::expert_kits;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    env,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager};

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
struct RuntimeFingerprint {
    skill_directories: Vec<String>,
    allowed_erp_tools: Vec<String>,
    required_erp_tools: Vec<String>,
    litellm_base_url: String,
    erp_mcp_url: String,
    model: String,
    credential_digest: String,
}

struct HarnessProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
    fingerprint: RuntimeFingerprint,
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
    request: HarnessRunRequest,
) -> Result<HarnessRunResult, String> {
    validate_run_request(&request)?;
    let profile = expert_kits::harness_profile(
        &app,
        request.expert_kit_id.as_deref(),
        request.prompt.trim(),
    )?;
    let fingerprint = RuntimeFingerprint {
        skill_directories: profile.skill_directories,
        allowed_erp_tools: profile.allowed_erp_tools,
        required_erp_tools: profile.required_erp_tools,
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
    fn start(
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
        let mut child = Command::new(&runtime.node)
            .arg(&runtime.entry)
            .current_dir(&workspace)
            .env("DSH_CORDIS_CONFIG", &runtime.config)
            .env("DSH_CWD", &workspace)
            .env("DSH_HOME", &dsh_home)
            .env("DSH_SESSION_ROOT", dsh_home.join("sessions"))
            .env("DSH_CUSTOM_SKILL_DIRS", skill_directories)
            .env("ERP_MCP_URL", &fingerprint.erp_mcp_url)
            .env("ERP_MCP_ALLOWED_TOOLS", allowed_tools)
            .env("ERP_MCP_REQUIRED_TOOLS", required_tools)
            .env("ERP_MCP_BEARER_TOKEN", access_token)
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

    fn request(
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

    fn shutdown(&mut self) {
        let _ = self.request("host.shutdown", None, None);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
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

fn configured_path(variable: &str, fallback: PathBuf) -> Result<PathBuf, String> {
    if let Ok(value) = env::var(variable)
        && !value.trim().is_empty()
    {
        let path = PathBuf::from(value);
        return if path.is_absolute() {
            Ok(path)
        } else {
            env::current_dir()
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
}
