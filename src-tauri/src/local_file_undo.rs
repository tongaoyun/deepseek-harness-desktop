use crate::local_files::LocalFileAuthorizations;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::Path, sync::Mutex};

static UNDO_LOCK: Mutex<()> = Mutex::new(());
const MAX_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UndoLocalFileChangeRequest {
    root_id: String,
    path: String,
    action: String,
    after_hash: String,
    before_hash: Option<String>,
    backup_path: Option<String>,
}

#[tauri::command]
pub async fn undo_local_file_change(
    app: tauri::AppHandle,
    authorizations: tauri::State<'_, LocalFileAuthorizations>,
    request: UndoLocalFileChangeRequest,
) -> Result<String, String> {
    let employee_id = crate::dingtalk_auth::current_employee(&app).await?;
    authorizations.ensure_employee(&employee_id)?;
    let _guard = UNDO_LOCK.lock().map_err(|_| "撤销状态不可用")?;
    if !matches!(request.action.as_str(), "created" | "updated" | "copied") {
        return Err("此类型的改动不支持自动撤销".into());
    }
    if request.action == "updated" && request.backup_path.is_none() {
        return Err("没有修改前的备份，无法撤销".into());
    }
    let target = authorizations.resolve_artifact(&request.root_id, &request.path)?;
    let root = authorizations.resolve_artifact(&request.root_id, ".")?;
    let backup = request
        .backup_path
        .as_deref()
        .map(|value| {
            if !value.starts_with(".xiaoyin-backups/") {
                return Err("备份路径无效".into());
            }
            authorizations.resolve_artifact(&request.root_id, value)
        })
        .transpose()?;
    let recovery_dir = root.join(".xiaoyin-backups").join("undo");
    fs::create_dir_all(&recovery_dir).map_err(|error| error.to_string())?;
    let recovery_dir = recovery_dir
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !recovery_dir.starts_with(&root) {
        return Err("恢复目录超出工作目录".into());
    }
    let recovery = undo_file(
        &target,
        backup.as_deref(),
        &request.after_hash,
        request.before_hash.as_deref(),
        &recovery_dir,
    )?;
    Ok(recovery
        .strip_prefix(root)
        .map_err(|error| error.to_string())?
        .to_string_lossy()
        .replace('\\', "/"))
}

fn checked_hash(path: &Path) -> Result<String, String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "文件不存在或已被移动")?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES {
        return Err("仅支持不超过 32 MiB 的普通文件".into());
    }
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    file.by_ref()
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("文件超过撤销大小限制".into());
    }
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn undo_file(
    target: &Path,
    backup: Option<&Path>,
    after_hash: &str,
    before_hash: Option<&str>,
    recovery_dir: &Path,
) -> Result<std::path::PathBuf, String> {
    if checked_hash(target)? != after_hash {
        return Err("文件在本轮之后已被修改，已跳过撤销".into());
    }
    if let Some(backup) = backup
        && Some(checked_hash(backup)?.as_str()) != before_hash
    {
        return Err("修改前的备份校验失败，已跳过撤销".into());
    }
    let transaction = recovery_dir.join(uuid::Uuid::new_v4().to_string());
    fs::create_dir(&transaction).map_err(|error| error.to_string())?;
    let recovery_folder = transaction.join("current");
    fs::create_dir(&recovery_folder).map_err(|error| error.to_string())?;
    let recovery = recovery_folder.join(target.file_name().ok_or("文件名无效")?);
    let staged = transaction.join("restore.tmp");
    if let Some(backup) = backup {
        fs::copy(backup, &staged).map_err(|error| error.to_string())?;
        if Some(checked_hash(&staged)?.as_str()) != before_hash {
            return Err("备份在读取时发生变化，未执行撤销".into());
        }
    }
    // Check again immediately before changing the destination. Every removed
    // version remains recoverable, including failures during the final rename.
    if checked_hash(target)? != after_hash {
        return Err("文件在撤销前发生变化，已跳过".into());
    }
    fs::rename(target, &recovery).map_err(|error| error.to_string())?;
    if backup.is_some()
        && let Err(error) = fs::rename(&staged, target)
    {
        let restored = fs::rename(&recovery, target).is_ok();
        return Err(format!(
            "无法恢复备份：{error}。{}",
            if restored {
                "原文件已还原".to_string()
            } else {
                format!("原文件保存在 {}", recovery.display())
            }
        ));
    }
    Ok(recovery)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("xiaoyin-undo-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn restores_backup_and_keeps_the_replaced_version() {
        let dir = Fixture::new();
        let file = dir.0.join("demo.txt");
        let backup = dir.0.join("before.txt");
        fs::write(&file, "new").unwrap();
        fs::write(&backup, "old").unwrap();
        let after = checked_hash(&file).unwrap();
        let before = checked_hash(&backup).unwrap();
        let recovery = undo_file(&file, Some(&backup), &after, Some(&before), &dir.0).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "old");
        assert_eq!(fs::read_to_string(recovery).unwrap(), "new");
        assert!(undo_file(&file, Some(&backup), &after, Some(&before), &dir.0).is_err());
    }

    #[test]
    fn new_file_moves_to_recovery_instead_of_being_deleted() {
        let dir = Fixture::new();
        let file = dir.0.join("created.txt");
        fs::write(&file, "new").unwrap();
        let recovery = undo_file(&file, None, &checked_hash(&file).unwrap(), None, &dir.0).unwrap();
        assert!(!file.exists());
        assert_eq!(fs::read_to_string(recovery).unwrap(), "new");
    }

    #[test]
    fn rejects_changed_current_file_and_changed_backup() {
        let dir = Fixture::new();
        let file = dir.0.join("demo.txt");
        let backup = dir.0.join("before.txt");
        fs::write(&file, "manual edit").unwrap();
        fs::write(&backup, "backup").unwrap();
        assert!(undo_file(&file, None, "stale", None, &dir.0).is_err());
        assert!(
            undo_file(
                &file,
                Some(&backup),
                &checked_hash(&file).unwrap(),
                Some("stale"),
                &dir.0
            )
            .is_err()
        );
        assert_eq!(fs::read_to_string(file).unwrap(), "manual edit");
    }
}
