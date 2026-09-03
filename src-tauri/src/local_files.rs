use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

const MAX_AUTHORIZED_DIRECTORIES: usize = 8;

#[derive(Clone, Default)]
pub struct LocalFileAuthorizations {
    directories: Arc<Mutex<Vec<AuthorizedDirectory>>>,
}

#[derive(Clone)]
struct AuthorizedDirectory {
    id: String,
    name: String,
    path: PathBuf,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizedDirectoryView {
    id: String,
    name: String,
    path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTaskAttachmentView {
    id: String,
    root_id: String,
    root_name: String,
    path: String,
    name: String,
    kind: String,
    media_type: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DroppedPathAuthorization {
    directories: Vec<AuthorizedDirectoryView>,
    attachments: Vec<LocalTaskAttachmentView>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StandardDirectoryRequest {
    directories: Vec<String>,
}

#[tauri::command]
pub async fn authorize_local_directory(
    app: tauri::AppHandle,
    authorizations: tauri::State<'_, LocalFileAuthorizations>,
) -> Result<Option<AuthorizedDirectoryView>, String> {
    let selected = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("选择允许小胤读取的文件夹")
            .blocking_pick_folder()
    })
    .await
    .map_err(|error| format!("打开文件夹选择器失败：{error}"))?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|error| format!("选择的文件夹路径无效：{error}"))?;
    authorizations.authorize(path).map(Some)
}

#[tauri::command]
pub fn authorize_standard_local_directories(
    app: tauri::AppHandle,
    authorizations: tauri::State<'_, LocalFileAuthorizations>,
    request: StandardDirectoryRequest,
) -> Result<Vec<AuthorizedDirectoryView>, String> {
    if request.directories.len() > 3 {
        return Err("系统目录请求数量无效".to_string());
    }
    let mut views = Vec::new();
    for directory in request.directories {
        let path = match directory.as_str() {
            "downloads" => app.path().download_dir(),
            "desktop" => app.path().desktop_dir(),
            "documents" => app.path().document_dir(),
            _ => return Err(format!("不支持的系统目录：{directory}")),
        }
        .map_err(|error| format!("无法确定系统目录：{error}"))?;
        let view = authorizations.authorize(path)?;
        if !views
            .iter()
            .any(|item: &AuthorizedDirectoryView| item.id == view.id)
        {
            views.push(view);
        }
    }
    Ok(views)
}

#[tauri::command]
pub fn authorize_dropped_paths(
    authorizations: tauri::State<'_, LocalFileAuthorizations>,
    paths: Vec<String>,
) -> Result<DroppedPathAuthorization, String> {
    if paths.is_empty() {
        return Ok(DroppedPathAuthorization {
            directories: Vec::new(),
            attachments: Vec::new(),
        });
    }
    if paths.len() > 32 {
        return Err("单次最多拖入 32 个文件或文件夹".to_string());
    }
    let mut directories = Vec::new();
    let mut attachments = Vec::new();
    for value in paths {
        let selected = PathBuf::from(value);
        let is_directory = selected.is_dir();
        let directory = if is_directory {
            selected.clone()
        } else {
            selected
                .parent()
                .map(Path::to_path_buf)
                .ok_or_else(|| "拖入的文件路径无效".to_string())?
        };
        let view = authorizations.authorize(directory)?;
        if !directories
            .iter()
            .any(|item: &AuthorizedDirectoryView| item.id == view.id)
        {
            directories.push(view.clone());
        }
        if !is_directory {
            let canonical = selected
                .canonicalize()
                .map_err(|error| format!("无法读取拖入的文件：{error}"))?;
            if !canonical.is_file() {
                return Err("拖入的路径不是文件或文件夹".to_string());
            }
            let relative = canonical
                .strip_prefix(Path::new(&view.path))
                .map_err(|_| "拖入的文件超出授权目录".to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            let name = canonical
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("附件")
                .to_string();
            let media_type = image_media_type(&canonical).map(str::to_string);
            attachments.push(LocalTaskAttachmentView {
                id: format!("{}:{}", view.id, relative),
                root_id: view.id,
                root_name: view.name,
                path: relative,
                name,
                kind: if media_type.is_some() {
                    "image"
                } else {
                    "file"
                }
                .to_string(),
                media_type,
            });
        }
    }
    Ok(DroppedPathAuthorization {
        directories,
        attachments,
    })
}

#[tauri::command]
pub fn restore_local_directories(
    authorizations: tauri::State<'_, LocalFileAuthorizations>,
    paths: Vec<String>,
) -> Result<Vec<AuthorizedDirectoryView>, String> {
    if paths.len() > MAX_AUTHORIZED_DIRECTORIES {
        return Err(format!(
            "单次任务最多恢复 {MAX_AUTHORIZED_DIRECTORIES} 个本地文件夹"
        ));
    }
    let mut restored = Vec::new();
    for path in paths {
        if let Ok(view) = authorizations.authorize(PathBuf::from(path))
            && !restored
                .iter()
                .any(|item: &AuthorizedDirectoryView| item.id == view.id)
        {
            restored.push(view);
        }
    }
    Ok(restored)
}

#[tauri::command]
pub fn revoke_local_directory(
    authorizations: tauri::State<'_, LocalFileAuthorizations>,
    id: String,
) -> Result<(), String> {
    authorizations.revoke(&id)
}

#[tauri::command]
pub fn clear_local_directories(
    authorizations: tauri::State<'_, LocalFileAuthorizations>,
) -> Result<(), String> {
    authorizations.clear()
}

impl LocalFileAuthorizations {
    pub fn resolve(&self, ids: &[String]) -> Result<Vec<String>, String> {
        if ids.len() > MAX_AUTHORIZED_DIRECTORIES {
            return Err(format!(
                "单次任务最多使用 {MAX_AUTHORIZED_DIRECTORIES} 个本地文件夹"
            ));
        }
        let requested = ids.iter().collect::<HashSet<_>>();
        if requested.len() != ids.len() {
            return Err("本地文件夹授权不能重复".to_string());
        }
        let guard = self
            .directories
            .lock()
            .map_err(|_| "本地文件夹授权状态不可用".to_string())?;
        ids.iter()
            .map(|id| {
                guard
                    .iter()
                    .find(|directory| &directory.id == id)
                    .map(|directory| directory.path.to_string_lossy().into_owned())
                    .ok_or_else(|| format!("本地文件夹授权已失效：{id}"))
            })
            .collect()
    }

    pub fn resolve_artifact(&self, id: &str, value: &str) -> Result<PathBuf, String> {
        if value.trim().is_empty()
            || value.len() > 4_096
            || value.chars().any(|character| character == '\0')
        {
            return Err("文件路径无效".to_string());
        }
        let relative = Path::new(value);
        if relative.is_absolute() {
            return Err("产物路径必须位于已授权目录内".to_string());
        }
        let guard = self
            .directories
            .lock()
            .map_err(|_| "本地文件夹授权状态不可用".to_string())?;
        let directory = guard
            .iter()
            .find(|directory| directory.id == id)
            .ok_or_else(|| format!("本地文件夹授权已失效：{id}"))?;
        let target = directory
            .path
            .join(relative)
            .canonicalize()
            .map_err(|_| "文件不存在或已被移动".to_string())?;
        if !target.starts_with(&directory.path) {
            return Err("产物路径超出已授权目录".to_string());
        }
        Ok(target)
    }

    fn authorize(&self, selected: PathBuf) -> Result<AuthorizedDirectoryView, String> {
        let path = canonical_directory(&selected)?;
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("已授权目录")
            .to_string();
        let id = format!(
            "local-{:x}",
            Sha256::digest(path.to_string_lossy().as_bytes())
        );
        let mut guard = self
            .directories
            .lock()
            .map_err(|_| "本地文件夹授权状态不可用".to_string())?;
        if let Some(existing) = guard.iter().find(|directory| directory.path == path) {
            return Ok(existing.view());
        }
        if guard.len() >= MAX_AUTHORIZED_DIRECTORIES {
            return Err(format!(
                "最多只能授权 {MAX_AUTHORIZED_DIRECTORIES} 个本地文件夹"
            ));
        }
        let directory = AuthorizedDirectory { id, name, path };
        let view = directory.view();
        guard.push(directory);
        Ok(view)
    }

    fn revoke(&self, id: &str) -> Result<(), String> {
        let mut guard = self
            .directories
            .lock()
            .map_err(|_| "本地文件夹授权状态不可用".to_string())?;
        guard.retain(|directory| directory.id != id);
        Ok(())
    }

    fn clear(&self) -> Result<(), String> {
        self.directories
            .lock()
            .map_err(|_| "本地文件夹授权状态不可用".to_string())?
            .clear();
        Ok(())
    }
}

impl AuthorizedDirectory {
    fn view(&self) -> AuthorizedDirectoryView {
        AuthorizedDirectoryView {
            id: self.id.clone(),
            name: self.name.clone(),
            path: self.path.to_string_lossy().into_owned(),
        }
    }
}

fn image_media_type(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        _ => None,
    }
}

fn canonical_directory(selected: &Path) -> Result<PathBuf, String> {
    let canonical = selected
        .canonicalize()
        .map_err(|error| format!("无法读取所选文件夹：{error}"))?;
    if !canonical.is_dir() {
        return Err("所选路径不是文件夹".to_string());
    }
    if canonical.parent().is_none() {
        return Err("不能授权整个磁盘根目录".to_string());
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn authorization_resolves_only_registered_ids_without_exposing_paths() {
        let directory = temporary_directory();
        let authorizations = LocalFileAuthorizations::default();
        let view = authorizations.authorize(directory.clone()).unwrap();

        assert_eq!(view.name, directory.file_name().unwrap().to_string_lossy());
        assert!(!view.id.contains(&directory.to_string_lossy().to_string()));
        assert_eq!(
            authorizations
                .resolve(std::slice::from_ref(&view.id))
                .unwrap(),
            vec![directory.canonicalize().unwrap().to_string_lossy()]
        );
        assert!(authorizations.resolve(&["missing".to_string()]).is_err());

        let artifact = directory.join("report.md");
        std::fs::write(&artifact, "report").unwrap();
        assert_eq!(
            authorizations
                .resolve_artifact(&view.id, "report.md")
                .unwrap(),
            artifact.canonicalize().unwrap()
        );
        assert!(
            authorizations
                .resolve_artifact(&view.id, "../outside.md")
                .is_err()
        );

        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn disk_root_cannot_be_authorized() {
        let root = Path::new(std::path::MAIN_SEPARATOR_STR);
        assert!(canonical_directory(root).is_err());
    }

    fn temporary_directory() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("xiaoyin-local-files-{unique}"));
        std::fs::create_dir(&path).unwrap();
        path
    }
}
