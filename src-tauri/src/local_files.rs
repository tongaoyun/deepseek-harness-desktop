use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
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
        }
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
