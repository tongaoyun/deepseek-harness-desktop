use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};
use tauri::Manager;

const DEFAULT_LIMIT: u32 = 100;
const MAX_LIMIT: u32 = 200;
const RETAINED_TASK_LIMIT: i64 = 200;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskQuery {
    #[serde(default)]
    query: String,
    #[serde(default)]
    offset: u32,
    #[serde(default = "default_limit")]
    limit: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPage {
    items: Vec<Value>,
    total: u64,
    offset: u32,
    limit: u32,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnterpriseCatalogCache {
    saved_at: String,
    catalog: Value,
    skills: Value,
    connectors: Value,
    knowledge: Value,
}

#[tauri::command]
pub fn load_local_tasks(
    app: tauri::AppHandle,
    employee_id: String,
    query: Option<TaskQuery>,
) -> Result<TaskPage, String> {
    validate_employee_id(&employee_id)?;
    let query = query.unwrap_or(TaskQuery {
        query: String::new(),
        offset: 0,
        limit: DEFAULT_LIMIT,
    });
    let limit = query.limit.clamp(1, MAX_LIMIT);
    let account = account_key(&employee_id);
    with_database(&app, |database| {
        let pattern = format!("%{}%", escape_like(query.query.trim()));
        let total = database
            .query_row(
                "SELECT COUNT(*) FROM local_task WHERE employee_key = ?1 AND (?2 = '%%' OR name LIKE ?2 ESCAPE '\\' OR payload LIKE ?2 ESCAPE '\\')",
                params![account, pattern],
                |row| row.get::<_, u64>(0),
            )
            .map_err(database_error)?;
        let mut statement = database
            .prepare("SELECT payload FROM local_task WHERE employee_key = ?1 AND (?2 = '%%' OR name LIKE ?2 ESCAPE '\\' OR payload LIKE ?2 ESCAPE '\\') ORDER BY updated_at DESC LIMIT ?3 OFFSET ?4")
            .map_err(database_error)?;
        let values = statement
            .query_map(params![account, pattern, limit, query.offset], |row| {
                row.get::<_, String>(0)
            })
            .map_err(database_error)?
            .map(|row| {
                let payload = row.map_err(database_error)?;
                serde_json::from_str(&payload).map_err(|error| format!("本地会话数据无效：{error}"))
            })
            .collect::<Result<Vec<Value>, String>>()?;
        Ok(TaskPage {
            items: values,
            total,
            offset: query.offset,
            limit,
        })
    })
}

#[tauri::command]
pub fn save_local_task(
    app: tauri::AppHandle,
    employee_id: String,
    task: Value,
) -> Result<(), String> {
    validate_employee_id(&employee_id)?;
    let object = task
        .as_object()
        .ok_or_else(|| "本地会话格式无效".to_string())?;
    let text = |name: &str| {
        object
            .get(name)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| format!("本地会话缺少 {name}"))
    };
    let id = text("id")?;
    let name = text("name")?;
    let status = text("status")?;
    let updated_at = text("updatedAt")?;
    if id.len() > 200 || name.len() > 500 || status.len() > 32 || updated_at.len() > 64 {
        return Err("本地会话字段过长".to_string());
    }
    let payload =
        serde_json::to_string(&task).map_err(|error| format!("无法序列化本地会话：{error}"))?;
    if payload.len() > 16 * 1024 * 1024 {
        return Err("单个会话不能超过 16 MB".to_string());
    }
    with_database(&app, |database| {
        let account = account_key(&employee_id);
        database.execute(
            "INSERT INTO local_task(employee_key, id, name, status, updated_at, payload) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(employee_key, id) DO UPDATE SET name=excluded.name, status=excluded.status, updated_at=excluded.updated_at, payload=excluded.payload",
            params![account, id, name, status, updated_at, payload],
        ).map_err(database_error)?;
        prune_local_tasks(database, &account)?;
        Ok(())
    })
}

fn prune_local_tasks(database: &Connection, employee_key: &str) -> Result<(), String> {
    database
        .execute(
            "DELETE FROM local_task
             WHERE employee_key = ?1
               AND id NOT IN (
                 SELECT id FROM local_task
                 WHERE employee_key = ?1
                 ORDER BY updated_at DESC, id DESC
                 LIMIT ?2
               )",
            params![employee_key, RETAINED_TASK_LIMIT],
        )
        .map_err(database_error)?;
    Ok(())
}

#[tauri::command]
pub fn delete_local_task(
    app: tauri::AppHandle,
    employee_id: String,
    id: String,
) -> Result<(), String> {
    validate_employee_id(&employee_id)?;
    if id.trim().is_empty() || id.len() > 200 || id.chars().any(char::is_control) {
        return Err("会话标识无效".to_string());
    }
    with_database(&app, |database| {
        database
            .execute(
                "DELETE FROM local_task WHERE employee_key = ?1 AND id = ?2",
                params![account_key(&employee_id), id],
            )
            .map_err(database_error)?;
        Ok(())
    })
}

#[tauri::command]
pub fn load_enterprise_catalog_cache(
    app: tauri::AppHandle,
    employee_id: String,
) -> Result<Option<EnterpriseCatalogCache>, String> {
    validate_employee_id(&employee_id)?;
    with_database(&app, |database| {
        let payload = database.query_row(
            "SELECT payload FROM enterprise_catalog_cache WHERE employee_key = ?1",
            params![account_key(&employee_id)],
            |row| row.get::<_, String>(0),
        );
        match payload {
            Ok(payload) => serde_json::from_str(&payload)
                .map(Some)
                .map_err(|error| format!("企业目录缓存无效：{error}")),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(database_error(error)),
        }
    })
}

#[tauri::command]
pub fn save_enterprise_catalog_cache(
    app: tauri::AppHandle,
    employee_id: String,
    cache: EnterpriseCatalogCache,
) -> Result<(), String> {
    validate_employee_id(&employee_id)?;
    let payload = serde_json::to_string(&cache)
        .map_err(|error| format!("无法序列化企业目录缓存：{error}"))?;
    if payload.len() > 16 * 1024 * 1024 {
        return Err("企业目录缓存不能超过 16 MB".to_string());
    }
    with_database(&app, |database| {
        database.execute(
            "INSERT INTO enterprise_catalog_cache(employee_key, saved_at, payload) VALUES (?1, ?2, ?3) ON CONFLICT(employee_key) DO UPDATE SET saved_at=excluded.saved_at, payload=excluded.payload",
            params![account_key(&employee_id), cache.saved_at, payload],
        ).map_err(database_error)?;
        Ok(())
    })
}

fn with_database<T>(
    app: &tauri::AppHandle,
    operation: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    let path = database_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建本地数据目录：{error}"))?;
    }
    let database = Connection::open(path).map_err(database_error)?;
    database
        .busy_timeout(std::time::Duration::from_secs(3))
        .map_err(database_error)?;
    database.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         CREATE TABLE IF NOT EXISTS local_task (
           employee_key TEXT NOT NULL,
           id TEXT NOT NULL,
           name TEXT NOT NULL,
           status TEXT NOT NULL,
           updated_at TEXT NOT NULL,
           payload TEXT NOT NULL,
           PRIMARY KEY(employee_key, id)
         );
         CREATE INDEX IF NOT EXISTS idx_local_task_employee_updated ON local_task(employee_key, updated_at DESC);
         CREATE TABLE IF NOT EXISTS enterprise_catalog_cache (
           employee_key TEXT PRIMARY KEY,
           saved_at TEXT NOT NULL,
           payload TEXT NOT NULL
         );"
    ).map_err(database_error)?;
    operation(&database)
}

fn database_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|root| root.join("xiaoyin-desktop.sqlite3"))
        .map_err(|error| format!("无法确定本地数据库目录：{error}"))
}

fn account_key(employee_id: &str) -> String {
    format!("{:x}", Sha256::digest(employee_id.as_bytes()))
}

fn validate_employee_id(value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        Err("员工标识无效".to_string())
    } else {
        Ok(())
    }
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn default_limit() -> u32 {
    DEFAULT_LIMIT
}
fn database_error(error: rusqlite::Error) -> String {
    format!("本地数据库操作失败：{error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn employee_and_like_values_are_validated() {
        assert!(validate_employee_id("employee-1").is_ok());
        assert!(validate_employee_id("employee\n1").is_err());
        assert_eq!(escape_like("50%_done\\"), "50\\%\\_done\\\\");
    }

    #[test]
    fn pruning_keeps_only_the_newest_tasks_for_one_employee() {
        let database = Connection::open_in_memory().unwrap();
        database
            .execute_batch(
                "CREATE TABLE local_task (
                   employee_key TEXT NOT NULL,
                   id TEXT NOT NULL,
                   name TEXT NOT NULL,
                   status TEXT NOT NULL,
                   updated_at TEXT NOT NULL,
                   payload TEXT NOT NULL,
                   PRIMARY KEY(employee_key, id)
                 );",
            )
            .unwrap();
        for index in 0..205 {
            database
                .execute(
                    "INSERT INTO local_task(employee_key, id, name, status, updated_at, payload)
                     VALUES (?1, ?2, 'task', 'COMPLETED', ?3, '{}')",
                    params![
                        "employee-1",
                        format!("task-{index:03}"),
                        format!("2026-09-04T00:{index:03}:00Z")
                    ],
                )
                .unwrap();
        }
        database
            .execute(
                "INSERT INTO local_task(employee_key, id, name, status, updated_at, payload)
                 VALUES ('employee-2', 'other-task', 'task', 'COMPLETED', '2026-09-04T00:00:00Z', '{}')",
                [],
            )
            .unwrap();

        prune_local_tasks(&database, "employee-1").unwrap();

        let retained = database
            .query_row(
                "SELECT COUNT(*) FROM local_task WHERE employee_key = 'employee-1'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        let oldest = database
            .query_row(
                "SELECT id FROM local_task WHERE employee_key = 'employee-1' ORDER BY updated_at ASC LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        let other_retained = database
            .query_row(
                "SELECT COUNT(*) FROM local_task WHERE employee_key = 'employee-2'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        assert_eq!(retained, RETAINED_TASK_LIMIT);
        assert_eq!(oldest, "task-005");
        assert_eq!(other_retained, 1);
    }
}
