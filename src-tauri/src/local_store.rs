use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};
use tauri::Manager;

const DEFAULT_LIMIT: u32 = 100;
const MAX_LIMIT: u32 = 200;
const MAX_TASK_PAYLOAD_BYTES: usize = 16 * 1024 * 1024;
const MAX_SCHEDULE_PAYLOAD_BYTES: usize = 16 * 1024 * 1024;
const MAX_TASK_QUEUE_PAYLOAD_BYTES: usize = 8 * 1024 * 1024;
const MAX_WORKSPACE_STATE_PAYLOAD_BYTES: usize = 16 * 1024 * 1024;
const READABLE_TASK_SQL: &str = "CASE WHEN json_valid(payload) THEN COALESCE(
    json_extract(payload, '$.source') = 'DESKTOP'
    AND json_extract(payload, '$.status') IN ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELED')
    AND json_type(payload, '$.id') = 'text'
    AND json_type(payload, '$.name') = 'text'
    AND json_type(payload, '$.createdAt') = 'text'
    AND json_type(payload, '$.updatedAt') = 'text'
    AND json_type(payload, '$.entries') = 'array'
    AND json_type(payload, '$.projection') = 'object'
    AND json_extract(payload, '$.projection.status') IN ('idle', 'running', 'completed', 'failed', 'canceled')
    AND json_type(payload, '$.projection.activity') = 'text'
    AND json_type(payload, '$.projection.updatedAt') = 'text'
    AND json_type(payload, '$.projection.steps') = 'array'
    AND json_type(payload, '$.projection.artifacts') = 'array'
    AND NOT EXISTS (SELECT 1 FROM json_each(payload) WHERE key NOT IN (
      'id', 'source', 'name', 'status', 'createdAt', 'updatedAt', 'lastOpenedAt', 'archivedAt', 'sessionId',
      'scheduleId', 'scheduleRunId', 'invocationTokens', 'model', 'reasoningEffort', 'executionMode',
      'localDirectories', 'capabilitySnapshot', 'projection', 'entries', 'messagePreview',
      'processedImEventIds', 'capabilityNotices', 'interactionSegments'))
    AND NOT EXISTS (SELECT 1 FROM json_each(payload, '$.entries') WHERE
      COALESCE(json_extract(value, '$.role') IN ('user', 'assistant'), 0) = 0
      OR (json_extract(value, '$.role') = 'user' AND COALESCE(json_type(value, '$.text') = 'text', 0) = 0)
      OR (json_extract(value, '$.role') = 'assistant' AND COALESCE(json_type(value, '$.segments') = 'array', 0) = 0)), 0) ELSE 0 END";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskQuery {
    #[serde(default)]
    exclude_ids: Vec<String>,
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
    invalid_count: u64,
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
pub async fn load_local_schedules(app: tauri::AppHandle, owner: String) -> Result<Value, String> {
    require_storage_owner(&app, &owner).await?;
    with_database_async(app, move |database| {
        load_schedule_payload(database, &account_key(&owner))
            .map(|value| value.unwrap_or(Value::Array(Vec::new())))
    })
    .await
}

#[tauri::command]
pub async fn save_local_schedules(
    app: tauri::AppHandle,
    owner: String,
    schedules: Value,
) -> Result<(), String> {
    require_storage_owner(&app, &owner).await?;
    with_database_async(app, move |database| {
        write_schedule_payload(database, &account_key(&owner), &schedules)
    })
    .await
}

fn load_schedule_payload(database: &Connection, account: &str) -> Result<Option<Value>, String> {
    database
        .query_row(
            "SELECT payload FROM local_schedule WHERE employee_key = ?1",
            [account],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(database_error)?
        .map(|payload| {
            serde_json::from_str(&payload).map_err(|error| format!("本机定时计划数据无效：{error}"))
        })
        .transpose()
}

fn write_schedule_payload(
    database: &Connection,
    account: &str,
    schedules: &Value,
) -> Result<(), String> {
    let items = schedules
        .as_array()
        .filter(|items| items.len() <= 100)
        .ok_or("本机定时计划数据无效")?;
    if items.iter().any(|item| {
        let Some(item) = item.as_object() else {
            return true;
        };
        let text_is_invalid = |field: &str, limit: usize| {
            item.get(field).and_then(Value::as_str).is_none_or(|value| {
                value.trim().is_empty()
                    || value.len() > limit
                    || value.chars().any(char::is_control)
            })
        };
        text_is_invalid("id", 200)
            || text_is_invalid("name", 100)
            || text_is_invalid("prompt", 10_000)
            || text_is_invalid("nextAt", 64)
            || item
                .get("runs")
                .and_then(Value::as_array)
                .is_none_or(|runs| runs.len() > 30)
            || item
                .get("directories")
                .and_then(Value::as_array)
                .is_none_or(|directories| directories.len() > 100)
    }) {
        return Err("本机定时计划数据无效".to_string());
    }
    let payload = serde_json::to_string(schedules)
        .map_err(|error| format!("无法序列化本机定时计划：{error}"))?;
    if payload.len() > MAX_SCHEDULE_PAYLOAD_BYTES {
        return Err("本机定时计划不能超过 16 MB".to_string());
    }
    database
        .execute(
            "INSERT INTO local_schedule(employee_key, payload) VALUES (?1, ?2) ON CONFLICT(employee_key) DO UPDATE SET payload=excluded.payload",
            params![account, payload],
        )
        .map_err(database_error)?;
    Ok(())
}

#[tauri::command]
pub async fn load_local_task_queues(
    app: tauri::AppHandle,
    employee_id: String,
) -> Result<Value, String> {
    validate_employee_id(&employee_id)?;
    crate::dingtalk_auth::require_employee(&app, &employee_id).await?;
    with_database_async(app, move |database| {
        load_task_queue_payload(database, &account_key(&employee_id))
            .map(|value| value.unwrap_or(Value::Object(serde_json::Map::new())))
    })
    .await
}

#[tauri::command]
pub async fn save_local_task_queues(
    app: tauri::AppHandle,
    employee_id: String,
    queues: Value,
) -> Result<(), String> {
    validate_employee_id(&employee_id)?;
    crate::dingtalk_auth::require_employee(&app, &employee_id).await?;
    with_database_async(app, move |database| {
        write_task_queue_payload(database, &account_key(&employee_id), &queues)
    })
    .await
}

fn load_task_queue_payload(database: &Connection, account: &str) -> Result<Option<Value>, String> {
    database
        .query_row(
            "SELECT payload FROM local_task_queue WHERE employee_key = ?1",
            [account],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(database_error)?
        .map(|payload| {
            serde_json::from_str(&payload).map_err(|error| format!("本机消息队列数据无效：{error}"))
        })
        .transpose()
}

fn write_task_queue_payload(
    database: &Connection,
    account: &str,
    queues: &Value,
) -> Result<(), String> {
    let queues = queues
        .as_object()
        .filter(|queues| queues.len() <= 200)
        .ok_or("本机消息队列数据无效")?;
    for (task_id, queue) in queues {
        if task_id.trim().is_empty() || task_id.len() > 200 || task_id.chars().any(char::is_control)
        {
            return Err("本机消息队列任务标识无效".to_string());
        }
        let Some(queue) = queue.as_object() else {
            return Err("本机消息队列数据无效".to_string());
        };
        if !queue.get("paused").is_some_and(Value::is_boolean) {
            return Err("本机消息队列状态无效".to_string());
        }
        let Some(items) = queue.get("items").and_then(Value::as_array) else {
            return Err("本机消息队列内容无效".to_string());
        };
        if items.is_empty() || items.len() > 20 {
            return Err("本机消息队列内容无效".to_string());
        }
        for item in items {
            let Some(item) = item.as_object() else {
                return Err("本机消息队列内容无效".to_string());
            };
            let valid_text = |field: &str, limit: usize| {
                item.get(field)
                    .and_then(Value::as_str)
                    .is_some_and(|value| {
                        !value.trim().is_empty()
                            && value.len() <= limit
                            && !value.chars().any(char::is_control)
                    })
            };
            if !valid_text("id", 200) || !valid_text("text", 20_000) {
                return Err("本机消息队列内容无效".to_string());
            }
        }
    }
    let payload = serde_json::to_string(queues)
        .map_err(|error| format!("无法序列化本机消息队列：{error}"))?;
    if payload.len() > MAX_TASK_QUEUE_PAYLOAD_BYTES {
        return Err("本机消息队列不能超过 8 MB".to_string());
    }
    database
        .execute(
            "INSERT INTO local_task_queue(employee_key, payload) VALUES (?1, ?2) ON CONFLICT(employee_key) DO UPDATE SET payload=excluded.payload",
            params![account, payload],
        )
        .map_err(database_error)?;
    Ok(())
}

#[tauri::command]
pub async fn load_local_workspace_state(
    app: tauri::AppHandle,
    employee_id: String,
) -> Result<Value, String> {
    validate_employee_id(&employee_id)?;
    crate::dingtalk_auth::require_employee(&app, &employee_id).await?;
    with_database_async(app, move |database| {
        let account = account_key(&employee_id);
        load_workspace_state_payload(database, &account).map(|value| {
            value.unwrap_or_else(|| serde_json::json!({ "drafts": {}, "recentDirectories": [] }))
        })
    })
    .await
}

#[tauri::command]
pub async fn save_local_workspace_state(
    app: tauri::AppHandle,
    employee_id: String,
    state: Value,
) -> Result<(), String> {
    validate_employee_id(&employee_id)?;
    crate::dingtalk_auth::require_employee(&app, &employee_id).await?;
    with_database_async(app, move |database| {
        write_workspace_state_payload(database, &account_key(&employee_id), &state)
    })
    .await
}

fn load_workspace_state_payload(
    database: &Connection,
    account: &str,
) -> Result<Option<Value>, String> {
    database
        .query_row(
            "SELECT payload FROM local_workspace_state WHERE employee_key = ?1",
            [account],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(database_error)?
        .map(|payload| {
            serde_json::from_str(&payload).map_err(|error| format!("本机工作区状态无效：{error}"))
        })
        .transpose()
}

fn write_workspace_state_payload(
    database: &Connection,
    account: &str,
    state: &Value,
) -> Result<(), String> {
    let state = state.as_object().ok_or("本机工作区状态无效")?;
    let Some(drafts) = state.get("drafts").and_then(Value::as_object) else {
        return Err("本机工作区状态无效".to_string());
    };
    let Some(recent_directories) = state.get("recentDirectories").and_then(Value::as_array) else {
        return Err("本机工作区状态无效".to_string());
    };
    let string_array = |value: Option<&Value>| {
        value
            .and_then(Value::as_array)
            .is_some_and(|items| items.iter().all(Value::is_string))
    };
    let drafts_invalid = drafts.iter().any(|(id, draft)| {
        let Some(draft) = draft.as_object() else {
            return true;
        };
        id.trim().is_empty()
            || id.len() > 200
            || !draft.get("prompt").is_some_and(Value::is_string)
            || !draft.get("model").is_some_and(Value::is_string)
            || !draft.get("updatedAt").is_some_and(Value::is_number)
            || !draft.get("attachments").is_some_and(Value::is_array)
            || !draft.get("directories").is_some_and(Value::is_array)
            || !string_array(draft.get("knowledgeRefs"))
            || !string_array(draft.get("connectorIds"))
    });
    let directories_invalid = recent_directories.iter().any(|directory| {
        directory.as_object().is_none_or(|directory| {
            ["id", "name", "path"]
                .iter()
                .any(|field| !directory.get(*field).is_some_and(Value::is_string))
        })
    });
    if state.len() != 2
        || drafts.len() > 100
        || recent_directories.len() > 8
        || drafts_invalid
        || directories_invalid
    {
        return Err("本机工作区状态无效".to_string());
    }
    let payload = serde_json::to_string(state)
        .map_err(|error| format!("无法序列化本机工作区状态：{error}"))?;
    if payload.len() > MAX_WORKSPACE_STATE_PAYLOAD_BYTES {
        return Err("本机工作区状态不能超过 16 MB".to_string());
    }
    database
        .execute(
            "INSERT INTO local_workspace_state(employee_key, payload) VALUES (?1, ?2) ON CONFLICT(employee_key) DO UPDATE SET payload=excluded.payload",
            params![account, payload],
        )
        .map_err(database_error)?;
    Ok(())
}

#[tauri::command]
pub async fn load_local_tasks(
    app: tauri::AppHandle,
    employee_id: String,
    query: Option<TaskQuery>,
) -> Result<TaskPage, String> {
    validate_employee_id(&employee_id)?;
    crate::dingtalk_auth::require_employee(&app, &employee_id).await?;
    let query = query.unwrap_or(TaskQuery {
        query: String::new(),
        offset: 0,
        limit: DEFAULT_LIMIT,
        exclude_ids: Vec::new(),
    });
    with_database_async(app, move |database| {
        query_tasks(database, &account_key(&employee_id), query)
    })
    .await
}

fn query_tasks(database: &Connection, account: &str, query: TaskQuery) -> Result<TaskPage, String> {
    let limit = query.limit.clamp(1, MAX_LIMIT);
    let excluded = serde_json::to_string(&query.exclude_ids).map_err(|error| error.to_string())?;
    let pattern = format!("%{}%", escape_like(query.query.trim()));
    let (total, invalid_count) = database
            .query_row(
                &format!("SELECT COUNT(*) FILTER (WHERE {READABLE_TASK_SQL}), COUNT(*) FILTER (WHERE NOT ({READABLE_TASK_SQL})) FROM local_task WHERE employee_key = ?1 AND (?2 = '%%' OR name LIKE ?2 ESCAPE '\\' OR payload LIKE ?2 ESCAPE '\\') AND id NOT IN (SELECT value FROM json_each(?3))"),
                params![account, pattern, excluded],
                |row| Ok((row.get::<_, u64>(0)?, row.get::<_, u64>(1)?)),
            )
            .map_err(database_error)?;
    let mut statement = database
            .prepare(&format!("SELECT payload FROM local_task WHERE employee_key = ?1 AND (?2 = '%%' OR name LIKE ?2 ESCAPE '\\' OR payload LIKE ?2 ESCAPE '\\') AND id NOT IN (SELECT value FROM json_each(?5)) AND ({READABLE_TASK_SQL}) ORDER BY updated_at DESC, id DESC LIMIT ?3 OFFSET ?4"))
            .map_err(database_error)?;
    let values = statement
        .query_map(
            params![account, pattern, limit, query.offset, excluded],
            |row| row.get::<_, String>(0),
        )
        .map_err(database_error)?
        .map(|row| {
            let payload = row.map_err(database_error)?;
            serde_json::from_str(&payload).map_err(|error| format!("本地会话数据无效：{error}"))
        })
        .collect::<Result<Vec<Value>, String>>()?;
    Ok(TaskPage {
        items: values,
        total,
        invalid_count,
        offset: query.offset,
        limit,
    })
}

#[tauri::command]
pub async fn load_local_task(
    app: tauri::AppHandle,
    employee_id: String,
    id: String,
) -> Result<Option<Value>, String> {
    validate_employee_id(&employee_id)?;
    crate::dingtalk_auth::require_employee(&app, &employee_id).await?;
    with_database_async(app, move |database| {
        let payload: Option<String> = database
            .query_row(
                "SELECT payload FROM local_task WHERE employee_key = ?1 AND id = ?2",
                params![account_key(&employee_id), id],
                |row| row.get(0),
            )
            .optional()
            .map_err(database_error)?;
        payload
            .map(|value| {
                serde_json::from_str(&value).map_err(|error| format!("本地会话数据无效：{error}"))
            })
            .transpose()
    })
    .await
}

#[tauri::command]
pub async fn save_local_task(
    app: tauri::AppHandle,
    employee_id: String,
    task: Value,
) -> Result<(), String> {
    validate_employee_id(&employee_id)?;
    crate::dingtalk_auth::require_employee(&app, &employee_id).await?;
    with_database_async(app, move |database| {
        save_task_preserving_notices(database, &account_key(&employee_id), task)
    })
    .await
}

fn save_task_preserving_notices(
    database: &Connection,
    account: &str,
    mut task: Value,
) -> Result<(), String> {
    let (id, _, _, _) = task_index_fields(&task)?;
    let transaction = Transaction::new_unchecked(database, TransactionBehavior::Immediate)
        .map_err(database_error)?;
    let previous: Option<String> = transaction
        .query_row(
            "SELECT payload FROM local_task WHERE employee_key = ?1 AND id = ?2",
            params![account, id],
            |row| row.get(0),
        )
        .optional()
        .map_err(database_error)?;
    if let Some(previous) = previous.and_then(|value| serde_json::from_str::<Value>(&value).ok()) {
        let session_id = task
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string);
        if session_id.is_some()
            && session_id.as_deref() == previous.get("sessionId").and_then(Value::as_str)
        {
            let saved = task_notices(&previous)?;
            let incoming = task_notices(&task)?;
            let mut notices = Vec::new();
            for item in saved.iter().chain(incoming.iter()) {
                if item.get("sessionId").and_then(Value::as_str) == session_id.as_deref() {
                    upsert_task_notice(&mut notices, item);
                }
            }
            if !notices.is_empty() {
                task.as_object_mut()
                    .ok_or("本地会话格式无效")?
                    .insert("capabilityNotices".to_string(), Value::Array(notices));
            }
            let saved = task_interactions(&previous)?;
            let incoming = task_interactions(&task)?;
            let mut interactions = Vec::new();
            for item in saved.iter().chain(incoming.iter()) {
                if item.get("sessionId").and_then(Value::as_str) == session_id.as_deref() {
                    upsert_task_notice(&mut interactions, item);
                }
            }
            if !interactions.is_empty() {
                task.as_object_mut().ok_or("本地会话格式无效")?.insert(
                    "interactionSegments".to_string(),
                    Value::Array(interactions),
                );
            }
        }
    }
    let (id, name, status, updated_at) = task_index_fields(&task)?;
    let payload =
        serde_json::to_string(&task).map_err(|error| format!("无法序列化本地会话：{error}"))?;
    if payload.len() > MAX_TASK_PAYLOAD_BYTES {
        return Err("本地会话不能超过 16 MB".to_string());
    }
    write_local_task(
        &transaction,
        account,
        id,
        name,
        status,
        updated_at,
        &payload,
    )?;
    transaction.commit().map_err(database_error)
}

fn task_notices(value: &Value) -> Result<&[Value], String> {
    match value.get("capabilityNotices") {
        None => Ok(&[]),
        Some(Value::Array(items)) => Ok(items),
        _ => Err("本地会话告警格式无效".to_string()),
    }
}

fn task_interactions(value: &Value) -> Result<&[Value], String> {
    match value.get("interactionSegments") {
        None => Ok(&[]),
        Some(Value::Array(items)) if items.len() <= 100 => Ok(items),
        _ => Err("本地会话交互记录格式无效".to_string()),
    }
}

fn upsert_task_notice(items: &mut Vec<Value>, notice: &Value) {
    items.retain(|item| {
        !(item.get("turnId") == notice.get("turnId")
            && item.get("afterTurnId") == notice.get("afterTurnId")
            && item.get("segment").and_then(|value| value.get("id"))
                == notice.get("segment").and_then(|value| value.get("id")))
    });
    items.push(notice.clone());
    if items.len() > 100 {
        items.drain(..items.len() - 100);
    }
}

#[tauri::command]
pub async fn append_local_task_capability_notice(
    app: tauri::AppHandle,
    employee_id: String,
    id: String,
    notice: Value,
) -> Result<(), String> {
    validate_employee_id(&employee_id)?;
    crate::dingtalk_auth::require_employee(&app, &employee_id).await?;
    if id.trim().is_empty() || id.len() > 200 || id.chars().any(char::is_control) {
        return Err("会话标识无效".to_string());
    }
    with_database_async(app, move |database| {
        append_task_capability_notice(database, &account_key(&employee_id), &id, &notice)
    })
    .await
}

fn append_task_capability_notice(
    database: &Connection,
    account: &str,
    id: &str,
    notice: &Value,
) -> Result<(), String> {
    let field = |name: &str, max: usize| {
        notice
            .get(name)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= max)
    };
    let session_id = field("sessionId", 256).ok_or("能力告警会话无效")?;
    field("turnId", 200).ok_or("能力告警轮次无效")?;
    notice
        .get("afterTurnId")
        .map(|_| field("afterTurnId", 200).ok_or("能力告警轮次无效"))
        .transpose()?;
    let segment = notice.get("segment").ok_or("能力告警内容无效")?;
    segment
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 200)
        .ok_or("能力告警内容无效")?;
    let valid = notice.as_object().is_some_and(|value| {
        value.keys().all(|key| {
            matches!(
                key.as_str(),
                "sessionId" | "turnId" | "afterTurnId" | "segment"
            )
        })
    }) && segment.as_object().is_some_and(|value| {
        value
            .keys()
            .all(|key| matches!(key.as_str(), "kind" | "id" | "level" | "text"))
    }) && segment.get("kind").and_then(Value::as_str) == Some("notice")
        && matches!(
            segment.get("level").and_then(Value::as_str),
            Some("warning" | "error")
        )
        && segment
            .get("text")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty() && value.len() <= 6_000);
    if !valid {
        return Err("能力告警内容无效".to_string());
    }

    let transaction = Transaction::new_unchecked(database, TransactionBehavior::Immediate)
        .map_err(database_error)?;
    let payload: Option<String> = transaction
        .query_row(
            "SELECT payload FROM local_task WHERE employee_key = ?1 AND id = ?2",
            params![account, id],
            |row| row.get(0),
        )
        .optional()
        .map_err(database_error)?;
    let Some(payload) = payload else {
        return Ok(());
    };
    let mut task: Value =
        serde_json::from_str(&payload).map_err(|error| format!("本地会话数据无效：{error}"))?;
    if task.get("sessionId").and_then(Value::as_str) != Some(session_id) {
        return Ok(());
    }
    let mut items = match task.get("capabilityNotices") {
        None => Vec::new(),
        Some(Value::Array(items)) => items.clone(),
        _ => return Err("本地会话告警格式无效".to_string()),
    };
    items.retain(|item| item.get("sessionId").and_then(Value::as_str) == Some(session_id));
    upsert_task_notice(&mut items, notice);
    task.as_object_mut()
        .ok_or("本地会话格式无效")?
        .insert("capabilityNotices".to_string(), Value::Array(items));
    let serialized =
        serde_json::to_string(&task).map_err(|error| format!("无法序列化本地会话：{error}"))?;
    if serialized.len() > MAX_TASK_PAYLOAD_BYTES {
        return Err("本地会话不能超过 16 MB".to_string());
    }
    transaction
        .execute(
            "UPDATE local_task SET payload = ?1 WHERE employee_key = ?2 AND id = ?3",
            params![serialized, account, id],
        )
        .map_err(database_error)?;
    transaction.commit().map_err(database_error)
}

fn task_index_fields(task: &Value) -> Result<(&str, &str, &str, &str), String> {
    let object = task
        .as_object()
        .ok_or_else(|| "本地会话格式无效".to_string())?;
    if task_interactions(task)?.iter().any(|item| {
        item.get("sessionId").and_then(Value::as_str).is_none()
            || item.get("turnId").and_then(Value::as_str).is_none()
            || item.get("index").and_then(Value::as_u64).is_none()
            || !matches!(
                item.get("segment")
                    .and_then(|value| value.get("kind"))
                    .and_then(Value::as_str),
                Some("question" | "user")
            )
    }) {
        return Err("本地会话交互记录格式无效".to_string());
    }
    const FIELDS: &[&str] = &[
        "id",
        "source",
        "name",
        "status",
        "createdAt",
        "updatedAt",
        "lastOpenedAt",
        "archivedAt",
        "sessionId",
        "scheduleId",
        "scheduleRunId",
        "invocationTokens",
        "model",
        "reasoningEffort",
        "executionMode",
        "localDirectories",
        "capabilitySnapshot",
        "projection",
        "entries",
        "messagePreview",
        "processedImEventIds",
        "capabilityNotices",
        "interactionSegments",
    ];
    if object.keys().any(|key| !FIELDS.contains(&key.as_str())) {
        return Err("本地会话包含未知字段".to_string());
    }
    let text = |name: &str| {
        object
            .get(name)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| format!("本地会话缺少 {name}"))
    };
    let id = text("id")?;
    let source = text("source")?;
    let name = text("name")?;
    let status = text("status")?;
    let created_at = text("createdAt")?;
    let updated_at = text("updatedAt")?;
    if source != "DESKTOP" {
        return Err("本地会话来源无效".to_string());
    }
    if !matches!(status, "RUNNING" | "COMPLETED" | "FAILED" | "CANCELED") {
        return Err("本地会话状态无效".to_string());
    }
    let valid_entries = |list: &Value| {
        list.as_array().is_some_and(|items| {
            items.iter().all(|item| {
                item.as_object().is_some_and(|item| {
                    match item.get("role").and_then(Value::as_str) {
                        Some("user") => item.get("text").is_some_and(Value::is_string),
                        Some("assistant") => item.get("segments").is_some_and(Value::is_array),
                        _ => false,
                    }
                })
            })
        })
    };
    if !object.get("entries").is_some_and(&valid_entries) {
        return Err("本地会话消息无效".to_string());
    }
    let Some(projection) = object.get("projection").and_then(Value::as_object) else {
        return Err("本地会话缺少运行投影".to_string());
    };
    if !matches!(
        projection.get("status").and_then(Value::as_str),
        Some("idle" | "running" | "completed" | "failed" | "canceled")
    ) || !projection.get("activity").is_some_and(Value::is_string)
        || !projection.get("updatedAt").is_some_and(Value::is_string)
        || !projection.get("steps").is_some_and(Value::is_array)
        || !projection.get("artifacts").is_some_and(Value::is_array)
    {
        return Err("本地会话运行投影无效".to_string());
    }
    if id.len() > 200
        || name.len() > 500
        || status.len() > 32
        || created_at.len() > 64
        || updated_at.len() > 64
        || [id, source, name, status, created_at, updated_at]
            .iter()
            .any(|value| value.chars().any(char::is_control))
    {
        return Err("本地会话字段无效或过长".to_string());
    }
    Ok((id, name, status, updated_at))
}

fn write_local_task(
    database: &Connection,
    account: &str,
    id: &str,
    name: &str,
    status: &str,
    updated_at: &str,
    payload: &str,
) -> Result<(), String> {
    database.execute(
        "INSERT INTO local_task(employee_key, id, name, status, updated_at, payload) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(employee_key, id) DO UPDATE SET name=excluded.name, status=excluded.status, updated_at=excluded.updated_at, payload=excluded.payload",
        params![account, id, name, status, updated_at, payload],
    ).map_err(database_error)?;
    Ok(())
}

#[tauri::command]
pub async fn delete_local_task(
    app: tauri::AppHandle,
    employee_id: String,
    id: String,
) -> Result<(), String> {
    validate_employee_id(&employee_id)?;
    crate::dingtalk_auth::require_employee(&app, &employee_id).await?;
    if id.trim().is_empty() || id.len() > 200 || id.chars().any(char::is_control) {
        return Err("会话标识无效".to_string());
    }
    with_database_async(app, move |database| {
        database
            .execute(
                "DELETE FROM local_task WHERE employee_key = ?1 AND id = ?2",
                params![account_key(&employee_id), id],
            )
            .map_err(database_error)?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn load_enterprise_catalog_cache(
    app: tauri::AppHandle,
    employee_id: String,
) -> Result<Option<EnterpriseCatalogCache>, String> {
    validate_employee_id(&employee_id)?;
    crate::dingtalk_auth::require_employee(&app, &employee_id).await?;
    with_database_async(app, move |database| {
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
    .await
}

#[tauri::command]
pub async fn save_enterprise_catalog_cache(
    app: tauri::AppHandle,
    employee_id: String,
    cache: EnterpriseCatalogCache,
) -> Result<(), String> {
    validate_employee_id(&employee_id)?;
    crate::dingtalk_auth::require_employee(&app, &employee_id).await?;
    with_database_async(app, move |database| {
        let payload = serde_json::to_string(&cache)
            .map_err(|error| format!("无法序列化企业目录缓存：{error}"))?;
        if payload.len() > 16 * 1024 * 1024 {
            return Err("企业目录缓存不能超过 16 MB".to_string());
        }
        database.execute(
            "INSERT INTO enterprise_catalog_cache(employee_key, saved_at, payload) VALUES (?1, ?2, ?3) ON CONFLICT(employee_key) DO UPDATE SET saved_at=excluded.saved_at, payload=excluded.payload",
            params![account_key(&employee_id), cache.saved_at, payload],
        ).map_err(database_error)?;
        Ok(())
    })
    .await
}

async fn with_database_async<T: Send + 'static>(
    app: tauri::AppHandle,
    operation: impl FnOnce(&Connection) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || with_database(&app, operation))
        .await
        .map_err(|_| "本地数据处理线程异常".to_string())?
}

pub(crate) fn with_database<T>(
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
         );
         CREATE TABLE IF NOT EXISTS local_schedule (
           employee_key TEXT PRIMARY KEY,
           payload TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS local_task_queue (
           employee_key TEXT PRIMARY KEY,
           payload TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS local_workspace_state (
           employee_key TEXT PRIMARY KEY,
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

async fn require_storage_owner(app: &tauri::AppHandle, owner: &str) -> Result<(), String> {
    if owner.trim().is_empty() || owner.len() > 4096 || owner.chars().any(char::is_control) {
        return Err("本机数据命名空间无效".to_string());
    }
    let employee_id = crate::dingtalk_auth::current_employee(app).await?;
    if storage_owner_matches(&employee_id, owner) {
        Ok(())
    } else {
        Err("当前登录账号不能访问该本机数据".to_string())
    }
}

fn storage_owner_matches(employee_id: &str, owner: &str) -> bool {
    owner == employee_id
        || owner
            .strip_prefix(employee_id)
            .is_some_and(|scope| scope.starts_with(':') && scope.len() > 1)
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

    fn schedule_database() -> Connection {
        let database = Connection::open_in_memory().unwrap();
        database
            .execute_batch(
                "CREATE TABLE local_schedule (
                   employee_key TEXT PRIMARY KEY,
                   payload TEXT NOT NULL
                 );",
            )
            .unwrap();
        database
    }

    fn valid_schedule(id: &str) -> Value {
        serde_json::json!([{
            "id": id, "name": "日报", "prompt": "生成日报", "nextAt": "2026-09-14T01:00:00Z",
            "directories": [], "runs": []
        }])
    }

    fn task_queue_database() -> Connection {
        let database = Connection::open_in_memory().unwrap();
        database
            .execute_batch(
                "CREATE TABLE local_task_queue (
                   employee_key TEXT PRIMARY KEY,
                   payload TEXT NOT NULL
                 );",
            )
            .unwrap();
        database
    }

    fn valid_task_queue(id: &str) -> Value {
        serde_json::json!({
            "task": { "paused": true, "items": [{ "id": id, "text": "继续分析" }] }
        })
    }

    fn workspace_state_database() -> Connection {
        let database = Connection::open_in_memory().unwrap();
        database
            .execute_batch(
                "CREATE TABLE local_workspace_state (
                   employee_key TEXT PRIMARY KEY,
                   payload TEXT NOT NULL
                 );",
            )
            .unwrap();
        database
    }

    fn valid_workspace_state(text: &str) -> Value {
        serde_json::json!({
            "drafts": {"new-task": {
                "prompt": text, "model": "model-a", "updatedAt": 1,
                "attachments": [], "directories": [], "knowledgeRefs": [], "connectorIds": []
            }},
            "recentDirectories": [{"id": "root", "name": "工作", "path": "/work"}]
        })
    }

    #[test]
    fn workspace_state_is_isolated_and_invalid_writes_preserve_existing_data() {
        let database = workspace_state_database();
        let first = account_key("employee-a");
        let second = account_key("employee-b");
        let saved = valid_workspace_state("未发送的内容");
        write_workspace_state_payload(&database, &first, &saved).unwrap();
        write_workspace_state_payload(&database, &second, &valid_workspace_state("另一员工"))
            .unwrap();
        assert_eq!(
            load_workspace_state_payload(&database, &first).unwrap(),
            Some(saved.clone())
        );
        assert_eq!(
            load_workspace_state_payload(&database, &second)
                .unwrap()
                .unwrap()["drafts"]["new-task"]["prompt"],
            "另一员工"
        );
        for invalid in [
            serde_json::json!({"drafts": [], "recentDirectories": []}),
            serde_json::json!({"drafts": {"new-task": {}}, "recentDirectories": []}),
            serde_json::json!({"drafts": {}, "recentDirectories": [{}]}),
        ] {
            assert!(write_workspace_state_payload(&database, &first, &invalid).is_err());
        }
        assert_eq!(
            load_workspace_state_payload(&database, &first).unwrap(),
            Some(saved)
        );
    }

    #[test]
    fn schedules_are_isolated_by_employee_and_round_trip() {
        let database = schedule_database();
        let first = valid_schedule("first");
        let second = valid_schedule("second");
        let first_account = account_key("employee-a");
        let second_account = account_key("employee-b");
        assert_ne!(first_account, second_account);
        write_schedule_payload(&database, &first_account, &first).unwrap();
        write_schedule_payload(&database, &second_account, &second).unwrap();
        assert_eq!(
            load_schedule_payload(&database, &first_account).unwrap(),
            Some(first)
        );
        assert_eq!(
            load_schedule_payload(&database, &second_account).unwrap(),
            Some(second)
        );
        assert_eq!(
            load_schedule_payload(&database, &account_key("employee-c")).unwrap(),
            None
        );
    }

    #[test]
    fn invalid_or_excessive_schedule_collections_are_rejected() {
        let database = schedule_database();
        for invalid in [
            Value::Null,
            serde_json::json!([{}]),
            serde_json::json!([{"id":"id","name":"","prompt":"prompt","nextAt":"date","directories":[],"runs":[]}]),
            serde_json::json!([{"id":"id","name":"name","prompt":"prompt","nextAt":"date","runs":[]}]),
            serde_json::json!([{"id":"id","name":"name","prompt":"prompt","nextAt":"date","directories":[]}]),
        ] {
            assert!(write_schedule_payload(&database, "employee", &invalid).is_err());
        }
        let excessive = Value::Array(
            (0..101)
                .map(|index| valid_schedule(&index.to_string())[0].clone())
                .collect(),
        );
        assert!(write_schedule_payload(&database, "employee", &excessive).is_err());
        assert_eq!(load_schedule_payload(&database, "employee").unwrap(), None);
    }

    #[test]
    fn task_queues_are_isolated() {
        let database = task_queue_database();
        let first_account = account_key("employee-a");
        let second_account = account_key("employee-b");
        let native = valid_task_queue("native");
        write_task_queue_payload(&database, &first_account, &native).unwrap();
        let second = valid_task_queue("second");
        write_task_queue_payload(&database, &second_account, &second).unwrap();
        assert_eq!(
            load_task_queue_payload(&database, &second_account).unwrap(),
            Some(second)
        );
        assert_eq!(
            load_task_queue_payload(&database, &account_key("employee-c")).unwrap(),
            None
        );
    }

    #[test]
    fn invalid_or_excessive_task_queues_are_rejected() {
        let database = task_queue_database();
        for invalid in [
            Value::Null,
            serde_json::json!({"task": {"paused": true, "items": []}}),
            serde_json::json!({"task": {"paused": true, "items": [{"id": "id", "text": ""}]}}),
            serde_json::json!({"task": {"items": [{"id": "id", "text": "prompt"}]}}),
        ] {
            assert!(write_task_queue_payload(&database, "employee", &invalid).is_err());
        }
        let excessive = Value::Object(
            (0..201)
                .map(|index| {
                    (
                        format!("task-{index}"),
                        serde_json::json!({"paused": true, "items": [{"id": "id", "text": "prompt"}]}),
                    )
                })
                .collect(),
        );
        assert!(write_task_queue_payload(&database, "employee", &excessive).is_err());
        assert_eq!(
            load_task_queue_payload(&database, "employee").unwrap(),
            None
        );
    }

    fn valid_task_payload(id: &str, message_count: usize) -> String {
        serde_json::json!({
            "id": id, "source": "DESKTOP", "name": "任务", "status": "COMPLETED",
            "createdAt": "2026-09-13", "updatedAt": "2026-09-13", "lastOpenedAt": "2026-09-13",
            "projection": {"status": "completed", "activity": "完成", "updatedAt": "2026-09-13", "steps": [], "artifacts": []},
            "entries": (0..message_count).map(|turn| serde_json::json!({"id": format!("u{turn}"), "role": "user", "text": format!("原始要求 {turn}")})).collect::<Vec<_>>()
        }).to_string()
    }

    #[test]
    fn task_accepts_bounded_desktop_interactions() {
        let mut task: Value = serde_json::from_str(&valid_task_payload("interactive", 1)).unwrap();
        task["interactionSegments"] = serde_json::json!([{
            "sessionId": "session-1", "turnId": "turn:1", "index": 1,
            "segment": {"kind": "question", "id": "question:q1", "questionId": "q1", "label": "需要回答",
                "status": "completed", "questions": [{"id": "number", "question": "哪个数？"}],
                "answers": [{"id": "number", "selected": ["42"]}]}
        }]);
        assert!(task_index_fields(&task).is_ok());
        task["interactionSegments"][0]["segment"]["kind"] = Value::String("tool".into());
        assert!(task_index_fields(&task).is_err());
    }

    #[test]
    fn employee_and_like_values_are_validated() {
        assert!(validate_employee_id("employee-1").is_ok());
        assert!(validate_employee_id("employee\n1").is_err());
        assert_eq!(escape_like("50%_done\\"), "50\\%\\_done\\\\");
        assert!(storage_owner_matches("employee-1", "employee-1"));
        assert!(storage_owner_matches(
            "employee-1",
            "employee-1:https://control.example/api/v1/schedules"
        ));
        assert!(!storage_owner_matches(
            "employee-1",
            "employee-2:https://control.example"
        ));
        assert!(!storage_owner_matches(
            "employee-1",
            "employee-10:https://control.example"
        ));
        assert!(!storage_owner_matches("employee-1", "employee-1:"));
    }

    #[test]
    fn new_native_task_must_be_visible_to_the_projection_index() {
        let task = serde_json::json!({
            "id": "task", "source": "DESKTOP", "name": "新任务", "status": "COMPLETED",
            "createdAt": "2026-09-13", "updatedAt": "2026-09-13", "lastOpenedAt": "2026-09-13", "entries": [],
            "capabilityNotices": [{"sessionId": "session-1", "turnId": "turn:1",
                "segment": {"kind": "notice", "id": "notice:knowledge:scope",
                    "level": "warning", "text": "范围无效"}}],
            "projection": {"status": "completed", "activity": "完成", "updatedAt": "2026-09-13", "steps": [], "artifacts": []}
        });
        assert_eq!(
            task_index_fields(&task).unwrap(),
            ("task", "新任务", "COMPLETED", "2026-09-13")
        );
        let mut missing = task.clone();
        missing.as_object_mut().unwrap().remove("projection");
        assert!(
            task_index_fields(&missing)
                .unwrap_err()
                .contains("运行投影")
        );
        missing["projection"] = Value::Null;
        assert!(
            task_index_fields(&missing)
                .unwrap_err()
                .contains("运行投影")
        );
        let mut invalid = task.clone();
        invalid["status"] = Value::String("UNKNOWN".into());
        assert!(task_index_fields(&invalid).unwrap_err().contains("状态"));
        invalid = task.clone();
        invalid["entries"] = serde_json::json!([{"role": "system", "text": "hidden"}]);
        assert!(task_index_fields(&invalid).unwrap_err().contains("消息"));
        invalid = task;
        invalid["projection"]["steps"] = Value::Null;
        assert!(
            task_index_fields(&invalid)
                .unwrap_err()
                .contains("运行投影")
        );
        invalid["projection"]["steps"] = serde_json::json!([]);
        invalid["unexpected"] = Value::Bool(true);
        assert!(
            task_index_fields(&invalid)
                .unwrap_err()
                .contains("未知字段")
        );
    }

    fn task_database() -> Connection {
        let database = Connection::open_in_memory().unwrap();
        database
            .execute_batch(
                "CREATE TABLE local_task (
                   employee_key TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
                   status TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL,
                   PRIMARY KEY(employee_key, id)
                 );",
            )
            .unwrap();
        database
    }

    fn valid_local_task(id: &str) -> Value {
        serde_json::json!({
            "id": id, "source": "DESKTOP", "name": "测试任务", "status": "COMPLETED",
            "createdAt": "2026-09-13T00:00:00Z", "updatedAt": "2026-09-13T00:00:00Z",
            "entries": [], "projection": {"status": "completed", "activity": "完成",
                "updatedAt": "2026-09-13T00:00:00Z", "steps": [], "artifacts": []}
        })
    }

    #[test]
    fn capability_notice_is_appended_without_replacing_task_state_or_crossing_sessions() {
        let database = task_database();
        let account = account_key("employee-1");
        let other = account_key("employee-2");
        let mut task = valid_local_task("notice-task");
        task["sessionId"] = Value::String("session-1".into());
        task["status"] = Value::String("COMPLETED".into());
        let payload = task.to_string();
        write_local_task(
            &database,
            &account,
            "notice-task",
            "任务",
            "COMPLETED",
            "2026-09-13",
            &payload,
        )
        .unwrap();
        write_local_task(
            &database,
            &other,
            "notice-task",
            "任务",
            "COMPLETED",
            "2026-09-13",
            &payload,
        )
        .unwrap();
        let notice = serde_json::json!({"sessionId": "session-1", "turnId": "pending", "afterTurnId": "turn:1",
            "segment": {"kind": "notice", "id": "notice:connector:erp", "level": "warning", "text": "连接失败"}});
        append_task_capability_notice(&database, &account, "notice-task", &notice).unwrap();
        append_task_capability_notice(&database, &account, "notice-task", &notice).unwrap();
        let stored: Value = serde_json::from_str(
            &database
                .query_row(
                    "SELECT payload FROM local_task WHERE employee_key = ?1 AND id = 'notice-task'",
                    [&account],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(stored["capabilityNotices"], serde_json::json!([notice]));
        assert_eq!(stored["status"], "COMPLETED");
        let other_payload: Value = serde_json::from_str(
            &database
                .query_row(
                    "SELECT payload FROM local_task WHERE employee_key = ?1 AND id = 'notice-task'",
                    [&other],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
        )
        .unwrap();
        assert!(other_payload.get("capabilityNotices").is_none());

        let mut stale = notice.clone();
        stale["sessionId"] = Value::String("session-replaced".into());
        append_task_capability_notice(&database, &account, "notice-task", &stale).unwrap();
        let invalid = serde_json::json!({"sessionId": "session-1", "turnId": "turn:2",
            "segment": {"kind": "text", "id": "bad", "level": "warning", "text": "not a notice"}});
        assert!(
            append_task_capability_notice(&database, &account, "notice-task", &invalid).is_err()
        );
        let unchanged: Value = serde_json::from_str(
            &database
                .query_row(
                    "SELECT payload FROM local_task WHERE employee_key = ?1 AND id = 'notice-task'",
                    [&account],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(unchanged, stored);

        let mut stale_snapshot = task.clone();
        stale_snapshot["status"] = Value::String("FAILED".into());
        save_task_preserving_notices(&database, &account, stale_snapshot).unwrap();
        let after_save: Value = serde_json::from_str(
            &database
                .query_row(
                    "SELECT payload FROM local_task WHERE employee_key = ?1 AND id = 'notice-task'",
                    [&account],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(after_save["capabilityNotices"], stored["capabilityNotices"]);
        assert_eq!(after_save["status"], "FAILED");

        task["sessionId"] = Value::String("session-replaced".into());
        save_task_preserving_notices(&database, &account, task).unwrap();
        let replaced: Value = serde_json::from_str(
            &database
                .query_row(
                    "SELECT payload FROM local_task WHERE employee_key = ?1 AND id = 'notice-task'",
                    [&account],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
        )
        .unwrap();
        assert!(replaced.get("capabilityNotices").is_none());
    }

    #[test]
    fn history_is_not_subject_to_a_retention_count() {
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
                     VALUES (?1, ?2, 'task', 'COMPLETED', ?3, ?4)",
                    params![
                        "employee-1",
                        format!("task-{index:03}"),
                        format!("2026-09-04T00:{index:03}:00Z"),
                        valid_task_payload(&format!("task-{index:03}"), 160)
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
        assert_eq!(retained, 205);
        assert_eq!(oldest, "task-000");
        assert_eq!(other_retained, 1);

        let first = query_tasks(
            &database,
            "employee-1",
            TaskQuery {
                query: String::new(),
                offset: 0,
                limit: 200,
                exclude_ids: vec![],
            },
        )
        .unwrap();
        let seen: Vec<String> = first
            .items
            .iter()
            .map(|item| item["id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(first.items.len(), 200);
        assert_eq!(first.invalid_count, 0);
        assert_eq!(first.items[0]["entries"].as_array().unwrap().len(), 160);
        assert_eq!(first.items[0]["entries"][0]["text"], "原始要求 0");
        database
            .execute(
                "DELETE FROM local_task WHERE employee_key = 'employee-1' AND id = 'task-204'",
                [],
            )
            .unwrap();
        database.execute("UPDATE local_task SET updated_at = '2099-01-01' WHERE employee_key = 'employee-1' AND id = 'task-000'", []).unwrap();
        let second = query_tasks(
            &database,
            "employee-1",
            TaskQuery {
                query: String::new(),
                offset: 0,
                limit: 200,
                exclude_ids: seen.clone(),
            },
        )
        .unwrap();
        assert_eq!(second.total, 5);
        assert_eq!(second.invalid_count, 0);
        assert_eq!(second.items.len(), 5);
        assert_eq!(second.items[0]["id"], "task-000");
        assert!(
            second
                .items
                .iter()
                .all(|item| !seen.iter().any(|id| id == item["id"].as_str().unwrap()))
        );
    }

    #[test]
    fn unreadable_tasks_do_not_block_valid_history_or_change_original_rows() {
        let database = Connection::open_in_memory().unwrap();
        database
            .execute_batch(
                "CREATE TABLE local_task (
                   employee_key TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
                   status TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL,
                   PRIMARY KEY(employee_key, id)
                 );",
            )
            .unwrap();
        let mut unknown: Value = serde_json::from_str(&valid_task_payload("unknown", 0)).unwrap();
        unknown["unexpected"] = Value::Bool(true);
        let mut bad_message: Value =
            serde_json::from_str(&valid_task_payload("bad-message", 0)).unwrap();
        bad_message["messages"] = serde_json::json!([{"role": "system", "text": "hidden"}]);
        for (id, payload) in [
            ("old", r#"{"id":"old","source":"DESKTOP"}"#.to_string()),
            ("broken", "{broken".to_string()),
            ("unknown", unknown.to_string()),
            ("bad-message", bad_message.to_string()),
            ("valid", valid_task_payload("valid", 0)),
        ] {
            write_local_task(&database, "employee", id, id, "COMPLETED", id, &payload).unwrap();
        }

        let first = query_tasks(
            &database,
            "employee",
            TaskQuery {
                query: String::new(),
                offset: 0,
                limit: 1,
                exclude_ids: vec![],
            },
        )
        .unwrap();
        assert_eq!(first.total, 1);
        assert_eq!(first.invalid_count, 4);
        assert_eq!(first.items[0]["id"], "valid");
        let searched = query_tasks(
            &database,
            "employee",
            TaskQuery {
                query: "old".into(),
                offset: 0,
                limit: 1,
                exclude_ids: vec![],
            },
        )
        .unwrap();
        assert_eq!(searched.total, 0);
        assert_eq!(searched.invalid_count, 1);
        let original: String = database
            .query_row(
                "SELECT payload FROM local_task WHERE employee_key = 'employee' AND id = 'old'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(original, r#"{"id":"old","source":"DESKTOP"}"#);
    }

    #[test]
    fn failed_task_write_does_not_replace_the_previous_local_index() {
        let database = Connection::open_in_memory().unwrap();
        database
            .execute_batch(
                "CREATE TABLE local_task (
               employee_key TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
               status TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL,
               PRIMARY KEY(employee_key, id)
             );",
            )
            .unwrap();
        write_local_task(
            &database,
            "employee",
            "task",
            "旧任务",
            "RUNNING",
            "1",
            "{\"version\":1}",
        )
        .unwrap();
        database.execute_batch("PRAGMA query_only=ON;").unwrap();
        assert!(
            write_local_task(
                &database,
                "employee",
                "task",
                "新任务",
                "COMPLETED",
                "2",
                "{\"version\":2}"
            )
            .is_err()
        );
        let stored = database.query_row(
            "SELECT name, status, payload FROM local_task WHERE employee_key='employee' AND id='task'",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
        ).unwrap();
        assert_eq!(
            stored,
            ("旧任务".into(), "RUNNING".into(), "{\"version\":1}".into())
        );
    }
}
