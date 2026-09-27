use crate::harness::HarnessManager;
use rusqlite::{Connection, OpenFlags, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, time::Duration};
use tauri::Manager;

pub(crate) fn journal_path(
    app: &tauri::AppHandle,
    employee: &str,
    task: &str,
) -> Result<PathBuf, String> {
    if employee.trim().is_empty() || employee.len() > 200 || task.is_empty() || task.len() > 200 {
        return Err("任务写操作记录标识无效".into());
    }
    let key = serde_json::to_vec(&(employee, task)).map_err(|_| "任务标识无效")?;
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| "无法确定任务记录目录")?
        .join("task-operations")
        .join(format!("{:x}.sqlite", Sha256::digest(key))))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationRequest {
    employee_id: String,
    task_id: String,
    resolution: Option<OperationResolution>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OperationResolution {
    id: String,
    applied: bool,
    evidence: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskOperation {
    id: String,
    connector: String,
    tool: String,
    started_at: String,
}

#[tauri::command]
pub async fn task_write_operations(
    app: tauri::AppHandle,
    manager: tauri::State<'_, HarnessManager>,
    request: OperationRequest,
) -> Result<Vec<TaskOperation>, String> {
    crate::dingtalk_auth::require_employee(&app, &request.employee_id).await?;
    let path = journal_path(&app, &request.employee_id, &request.task_id)?;
    let review_guard = if request.resolution.is_some() {
        Some(manager.begin_operation_review(&request.task_id, &request.employee_id)?)
    } else {
        None
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = review_guard;
        if !path.exists() { return Ok(Vec::new()); }
        let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(|_| "无法读取任务写操作记录")?;
        db.busy_timeout(Duration::from_secs(5)).map_err(|_| "任务记录暂不可用")?;
        if let Some(resolution) = request.resolution { resolve(&db, &resolution)?; }
        let mut statement = db.prepare("SELECT id, connector, tool, started_at FROM operations WHERE state='started' ORDER BY started_at LIMIT 100")
            .map_err(|_| "任务记录无效")?;
        let values = statement.query_map([], |row| Ok(TaskOperation { id: row.get(0)?, connector: row.get(1)?, tool: row.get(2)?, started_at: row.get(3)? }))
            .map_err(|_| "无法读取任务记录")?;
        values.collect::<Result<Vec<_>, _>>().map_err(|_| "无法读取任务记录".into())
    }).await.map_err(|_| "任务记录线程异常".to_string())?
}

fn resolve(db: &Connection, value: &OperationResolution) -> Result<(), String> {
    if value.id.len() != 64
        || !value.id.bytes().all(|value| value.is_ascii_hexdigit())
        || !(5..=2000).contains(&value.evidence.trim().chars().count())
    {
        return Err("请填写核对依据，至少 5 个字，最多 2000 字".into());
    }
    let changed = db.execute("UPDATE operations SET state=?1, review_note=?2, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?3 AND state='started'",
        params![if value.applied { "confirmed" } else { "released" }, value.evidence.trim(), value.id]).map_err(|_| "无法保存核对记录")?;
    if changed != 1 {
        return Err("操作状态已改变，请刷新后核对".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_unresolved_operations_can_be_reviewed_with_evidence() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE operations(id TEXT, state TEXT, review_note TEXT, updated_at TEXT);",
        )
        .unwrap();
        let id = "a".repeat(64);
        db.execute(
            "INSERT INTO operations(id,state) VALUES (?,'started')",
            [&id],
        )
        .unwrap();
        let mut resolution = OperationResolution {
            id,
            applied: false,
            evidence: "短".into(),
        };
        assert!(resolve(&db, &resolution).is_err());
        resolution.evidence = "已查询订单系统，订单未生成".into();
        assert!(resolve(&db, &resolution).is_ok());
        assert!(resolve(&db, &resolution).is_err());
        assert_eq!(
            db.query_row("SELECT state FROM operations", [], |row| row
                .get::<_, String>(0))
                .unwrap(),
            "released"
        );
    }
}
