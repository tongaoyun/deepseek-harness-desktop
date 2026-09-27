use serde::Serialize;
use std::{
    fs,
    path::Path,
    time::{Duration, SystemTime},
};
use tauri::Manager;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsage {
    files: u64,
    bytes: u64,
    reclaimable_files: u64,
    reclaimable_bytes: u64,
    removed_files: u64,
    removed_bytes: u64,
}

#[tauri::command]
pub async fn attachment_storage(
    app: tauri::AppHandle,
    references: Vec<serde_json::Value>,
    clean: bool,
) -> Result<StorageUsage, String> {
    crate::dingtalk_auth::current_employee(&app).await?;
    tauri::async_runtime::spawn_blocking(move || inspect_storage(&app, references, clean))
        .await
        .map_err(|_| "附件存储检查线程异常".to_string())?
}

fn inspect_storage(
    app: &tauri::AppHandle,
    references: Vec<serde_json::Value>,
    clean: bool,
) -> Result<StorageUsage, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let references = serde_json::to_string(&references).map_err(|error| error.to_string())?;
    crate::local_store::with_database(app, |database| {
        // Include all accounts and archived tasks, not just the currently loaded page.
        scan(&root, clean, SystemTime::now(), |name| {
            let encoded = serde_json::to_string(name).map_err(|error| error.to_string())?;
            let fragment = &encoded[1..encoded.len() - 1];
            if references.contains(fragment) {
                return Ok(true);
            }
            database_references_attachment(database, fragment)
        })
    })
}

fn database_references_attachment(
    database: &rusqlite::Connection,
    fragment: &str,
) -> Result<bool, String> {
    database
        .query_row(
            "SELECT EXISTS(
               SELECT 1 FROM local_task WHERE instr(payload, ?1) > 0
               UNION ALL
               SELECT 1 FROM local_schedule WHERE instr(payload, ?1) > 0
               UNION ALL
               SELECT 1 FROM local_task_queue WHERE instr(payload, ?1) > 0
               UNION ALL
               SELECT 1 FROM local_workspace_state WHERE instr(payload, ?1) > 0
             )",
            [fragment],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| format!("无法检查任务引用，未继续清理：{error}"))
}

fn scan(
    root: &Path,
    clean: bool,
    now: SystemTime,
    mut referenced: impl FnMut(&str) -> Result<bool, String>,
) -> Result<StorageUsage, String> {
    let mut usage = StorageUsage::default();
    let mut candidates = Vec::new();
    for name in ["pasted-files", "pasted-images"] {
        let directory = root.join(name);
        if !directory.exists() {
            continue;
        }
        if fs::symlink_metadata(&directory)
            .map_err(|error| error.to_string())?
            .file_type()
            .is_symlink()
        {
            continue;
        }
        for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let metadata = fs::symlink_metadata(entry.path()).map_err(|error| error.to_string())?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                continue;
            }
            usage.files += 1;
            usage.bytes += metadata.len();
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let old = metadata
                .modified()
                .ok()
                .and_then(|time| now.duration_since(time).ok())
                .is_some_and(|age| age >= Duration::from_secs(86400));
            if !old || referenced(&name)? {
                continue;
            }
            usage.reclaimable_files += 1;
            usage.reclaimable_bytes += metadata.len();
            candidates.push((entry.path(), metadata.len()));
        }
    }
    if clean {
        for (path, bytes) in candidates {
            fs::remove_file(path).map_err(|error| {
                format!(
                    "已清理 {} 个文件；部分缓存无法清理：{error}",
                    usage.removed_files
                )
            })?;
            usage.removed_files += 1;
            usage.removed_bytes += bytes;
        }
    }
    Ok(usage)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_tasks_schedules_and_queues_retain_attachment_cache() {
        let database = rusqlite::Connection::open_in_memory().unwrap();
        database
            .execute_batch(
                "CREATE TABLE local_task (payload TEXT NOT NULL);
             CREATE TABLE local_schedule (payload TEXT NOT NULL);
             CREATE TABLE local_task_queue (payload TEXT NOT NULL);
             CREATE TABLE local_workspace_state (payload TEXT NOT NULL);
             INSERT INTO local_task(payload) VALUES ('{\"path\":\"task-file.txt\"}');
             INSERT INTO local_schedule(payload) VALUES ('{\"path\":\"schedule-file.txt\"}');
             INSERT INTO local_task_queue(payload) VALUES ('{\"path\":\"queue-file.txt\"}');
             INSERT INTO local_workspace_state(payload) VALUES ('{\"path\":\"draft-file.txt\"}');",
            )
            .unwrap();
        assert!(database_references_attachment(&database, "task-file.txt").unwrap());
        assert!(database_references_attachment(&database, "schedule-file.txt").unwrap());
        assert!(database_references_attachment(&database, "queue-file.txt").unwrap());
        assert!(database_references_attachment(&database, "draft-file.txt").unwrap());
        assert!(!database_references_attachment(&database, "unused.txt").unwrap());
    }

    #[test]
    fn only_old_unreferenced_cache_files_are_removed() {
        let root =
            std::env::temp_dir().join(format!("xiaoyin-cache-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("pasted-files")).unwrap();
        for name in ["used.txt", "unused.txt"] {
            fs::write(root.join("pasted-files").join(name), b"test").unwrap();
        }
        fs::write(root.join("business.txt"), b"keep").unwrap();
        let now = SystemTime::now();
        assert_eq!(
            scan(&root, false, now, |_| Ok(false))
                .unwrap()
                .reclaimable_files,
            0
        );
        let later = now + Duration::from_secs(86401);
        let preview = scan(&root, false, later, |name| Ok(name == "used.txt")).unwrap();
        assert_eq!(preview.files, 2);
        assert_eq!(preview.reclaimable_bytes, 4);
        assert!(root.join("pasted-files/unused.txt").exists());
        let result = scan(&root, true, later, |name| Ok(name == "used.txt")).unwrap();
        assert_eq!(result.removed_files, 1);
        assert!(root.join("pasted-files/used.txt").exists());
        assert!(root.join("business.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
