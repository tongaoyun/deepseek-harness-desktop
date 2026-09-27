#[cfg(target_os = "macos")]
use std::{
    process::{Child, Command, Stdio},
    sync::{Mutex, OnceLock},
};

#[cfg(target_os = "macos")]
static PROCESS: OnceLock<Mutex<Option<Child>>> = OnceLock::new();

/// The assertion ends when Xiaoyin exits, including an unexpected process exit.
#[tauri::command]
pub async fn schedule_keep_awake(
    app: tauri::AppHandle,
    enabled: Option<bool>,
) -> Result<bool, String> {
    crate::dingtalk_auth::current_employee(&app).await?;
    keep_awake(enabled)
}

pub(crate) fn stop_keep_awake() {
    let _ = keep_awake(Some(false));
}

fn keep_awake(enabled: Option<bool>) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let mut process = PROCESS
            .get_or_init(|| Mutex::new(None))
            .lock()
            .map_err(|e| e.to_string())?;
        if let Some(child) = process.as_mut()
            && child.try_wait().map_err(|e| e.to_string())?.is_some()
        {
            *process = None;
        }
        match enabled {
            Some(true) if process.is_none() => {
                *process = Some(
                    Command::new("/usr/bin/caffeinate")
                        .args(["-i", "-w", &std::process::id().to_string()])
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn()
                        .map_err(|e| format!("无法保持系统唤醒：{e}"))?,
                );
            }
            Some(false) => {
                if let Some(mut child) = process.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
            _ => {}
        }
        Ok(process.is_some())
    }
    #[cfg(not(target_os = "macos"))]
    {
        if enabled == Some(true) {
            Err("请在系统电源设置中关闭自动睡眠".into())
        } else {
            Ok(false)
        }
    }
}
