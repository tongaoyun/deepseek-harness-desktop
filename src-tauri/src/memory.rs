use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::PathBuf};
use tauri::Manager;

const MAX_STYLE_CHARS: usize = 8_000;
const MAX_MANUAL_CHARS: usize = 16_000;

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryProfile {
    enabled: bool,
    collaboration_style: String,
    work_manual: String,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    automatic_memory: bool,
    #[serde(default)]
    entries: Vec<MemoryEntry>,
    #[serde(default)]
    sync_pending: bool,
    #[serde(default)]
    version: u64,
    #[serde(default)]
    sync_conflict: bool,
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryEntry {
    id: String,
    kind: String,
    text: String,
    source: String,
    task_id: String,
    updated_at: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRevision {
    id: String,
    saved_at: String,
    profile: MemoryProfile,
}

impl Default for MemoryProfile {
    fn default() -> Self {
        Self {
            enabled: true,
            collaboration_style: String::new(),
            work_manual: String::new(),
            updated_at: String::new(),
            automatic_memory: false,
            entries: Vec::new(),
            sync_pending: false,
            version: 0,
            sync_conflict: false,
        }
    }
}

#[tauri::command]
pub async fn load_memory_profile(
    app: tauri::AppHandle,
    employee_id: String,
) -> Result<MemoryProfile, String> {
    validate_employee_id(&employee_id)?;
    crate::dingtalk_auth::require_employee(&app, &employee_id).await?;
    tauri::async_runtime::spawn_blocking(move || load(&app, &employee_id))
        .await
        .map_err(|_| "记忆配置读取线程异常".to_string())?
}

#[tauri::command]
pub async fn save_memory_profile(
    app: tauri::AppHandle,
    employee_id: String,
    profile: MemoryProfile,
) -> Result<MemoryProfile, String> {
    validate_employee_id(&employee_id)?;
    crate::dingtalk_auth::require_employee(&app, &employee_id).await?;
    validate(&profile)?;
    tauri::async_runtime::spawn_blocking(move || save_profile(&app, &employee_id, profile))
        .await
        .map_err(|_| "记忆配置保存线程异常".to_string())?
}

fn save_profile(
    app: &tauri::AppHandle,
    employee_id: &str,
    profile: MemoryProfile,
) -> Result<MemoryProfile, String> {
    let previous = load(app, employee_id).ok();
    let path = profile_path(app, employee_id)?;
    let parent = path
        .parent()
        .ok_or_else(|| "记忆配置路径无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建记忆配置目录：{error}"))?;
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(&profile)
        .map_err(|error| format!("无法生成记忆配置：{error}"))?;
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("无法保存记忆配置：{error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("无法保存记忆配置：{error}"))?;
    replace_file(&temporary, &path).map_err(|error| format!("无法提交记忆配置：{error}"))?;
    if previous.as_ref().is_none_or(|old| {
        old.enabled != profile.enabled
            || old.automatic_memory != profile.automatic_memory
            || old.collaboration_style != profile.collaboration_style
            || old.work_manual != profile.work_manual
            || old.entries != profile.entries
    }) {
        append_history(app, employee_id, &profile)?;
    }
    Ok(profile)
}

#[tauri::command]
pub async fn load_memory_history(
    app: tauri::AppHandle,
    employee_id: String,
) -> Result<Vec<MemoryRevision>, String> {
    validate_employee_id(&employee_id)?;
    crate::dingtalk_auth::require_employee(&app, &employee_id).await?;
    tauri::async_runtime::spawn_blocking(move || load_history(&app, &employee_id))
        .await
        .map_err(|_| "记忆历史读取线程异常".to_string())?
}

pub fn context(app: &tauri::AppHandle, employee_id: &str) -> Result<String, String> {
    load(app, employee_id)?;
    // Read the current profile each turn, including long-lived IM processes.
    // Passing only the path also avoids operating-system environment size limits.
    Ok(serde_json::json!({ "profilePath": profile_path(app, employee_id)? }).to_string())
}

fn load(app: &tauri::AppHandle, employee_id: &str) -> Result<MemoryProfile, String> {
    validate_employee_id(employee_id)?;
    let path = profile_path(app, employee_id)?;
    if !path.exists() {
        return Ok(MemoryProfile::default());
    }
    let bytes = fs::read(path).map_err(|error| format!("无法读取记忆配置：{error}"))?;
    let profile: MemoryProfile =
        serde_json::from_slice(&bytes).map_err(|error| format!("记忆配置无效：{error}"))?;
    validate(&profile)?;
    Ok(profile)
}

fn profile_path(app: &tauri::AppHandle, employee_id: &str) -> Result<PathBuf, String> {
    let account = format!("{:x}", Sha256::digest(employee_id.as_bytes()));
    app.path()
        .app_data_dir()
        .map(|root| root.join("memory").join(account).join("profile.json"))
        .map_err(|error| format!("无法确定记忆配置目录：{error}"))
}

fn history_path(app: &tauri::AppHandle, employee_id: &str) -> Result<PathBuf, String> {
    profile_path(app, employee_id).map(|path| path.with_file_name("history.json"))
}

fn append_history(
    app: &tauri::AppHandle,
    employee_id: &str,
    profile: &MemoryProfile,
) -> Result<(), String> {
    let mut history = load_history(app, employee_id)?;
    history.insert(
        0,
        MemoryRevision {
            id: format!("memory-{}", timestamp_millis()),
            saved_at: profile.updated_at.clone(),
            profile: profile.clone(),
        },
    );
    history.truncate(50);
    let path = history_path(app, employee_id)?;
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(&history)
        .map_err(|error| format!("无法生成记忆历史：{error}"))?;
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("无法保存记忆历史：{error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("无法保存记忆历史：{error}"))?;
    replace_file(&temporary, &path).map_err(|error| format!("无法提交记忆历史：{error}"))
}

fn load_history(app: &tauri::AppHandle, employee_id: &str) -> Result<Vec<MemoryRevision>, String> {
    let path = history_path(app, employee_id)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = fs::read(path).map_err(|error| format!("无法读取记忆历史：{error}"))?;
    let mut history: Vec<MemoryRevision> =
        serde_json::from_slice(&bytes).map_err(|error| format!("记忆历史无效：{error}"))?;
    history.truncate(50);
    Ok(history)
}

fn timestamp_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn replace_file(temporary: &std::path::Path, destination: &std::path::Path) -> std::io::Result<()> {
    #[cfg(windows)]
    if destination.exists() {
        fs::remove_file(destination)?;
    }
    fs::rename(temporary, destination)
}

fn validate_employee_id(value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        Err("员工标识无效".to_string())
    } else {
        Ok(())
    }
}

fn validate(profile: &MemoryProfile) -> Result<(), String> {
    if profile.entries.len() > 100 {
        return Err("最多保存 100 条记忆".to_string());
    }
    let mut ids = std::collections::HashSet::new();
    for entry in &profile.entries {
        if !matches!(entry.kind.as_str(), "preference" | "fact")
            || entry.id.is_empty()
            || entry.id.len() > 100
            || !ids.insert(&entry.id)
            || entry.text.trim().is_empty()
            || entry.text.chars().count() > 800
            || entry.source.chars().count() > 120
            || entry.task_id.len() > 200
            || entry.updated_at.len() > 40
            || entry.text.contains('\0')
        {
            return Err("记忆条目格式无效".to_string());
        }
    }
    if profile.collaboration_style.chars().count() > MAX_STYLE_CHARS {
        return Err("协作风格不能超过 8000 个字符".to_string());
    }
    if profile.work_manual.chars().count() > MAX_MANUAL_CHARS {
        return Err("工作手册不能超过 16000 个字符".to_string());
    }
    if profile.collaboration_style.contains('\0') || profile.work_manual.contains('\0') {
        return Err("记忆配置包含无效字符".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_profile_limits_user_controlled_context() {
        assert!(validate(&MemoryProfile::default()).is_ok());
        assert!(validate_employee_id("employee-1").is_ok());
        assert!(validate_employee_id("../employee\n").is_err());
        let invalid = MemoryProfile {
            work_manual: "x".repeat(MAX_MANUAL_CHARS + 1),
            ..MemoryProfile::default()
        };
        assert!(validate(&invalid).is_err());
    }
}
