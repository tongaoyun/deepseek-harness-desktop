use keyring::Entry;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, io::Write, path::PathBuf};
use tauri::Manager;

const KEYRING_SERVICE: &str = "com.instudio.xiaoyin.connector-secret";
const MAX_SECRET_CHARS: usize = 2_048;
const MAX_FIELDS_PER_CONNECTOR: usize = 64;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectorSecretValues {
    #[serde(default)]
    environment: BTreeMap<String, String>,
    #[serde(default)]
    headers: BTreeMap<String, String>,
}

type ConnectorSecretStore = BTreeMap<String, ConnectorSecretValues>;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecretFieldIndex {
    #[serde(default)]
    environment: Vec<String>,
    #[serde(default)]
    headers: Vec<String>,
}

type SecretIndex = BTreeMap<String, SecretFieldIndex>;

#[tauri::command]
pub async fn load_connector_secrets(
    app: tauri::AppHandle,
    employee_id: String,
) -> Result<ConnectorSecretStore, String> {
    validate_identifier("员工标识", &employee_id)?;
    crate::dingtalk_auth::require_employee(&app, &employee_id).await?;
    tauri::async_runtime::spawn_blocking(move || load_store(&app, &employee_id))
        .await
        .map_err(|_| "连接器凭据读取线程异常".to_string())?
}

#[tauri::command]
pub async fn save_connector_secret(
    app: tauri::AppHandle,
    employee_id: String,
    connector_id: String,
    values: ConnectorSecretValues,
) -> Result<ConnectorSecretStore, String> {
    validate_identifier("员工标识", &employee_id)?;
    crate::dingtalk_auth::require_employee(&app, &employee_id).await?;
    validate_identifier("连接器标识", &connector_id)?;
    validate_values(&values)?;
    tauri::async_runtime::spawn_blocking(move || {
        save_values(&app, &employee_id, &connector_id, &values)?;
        load_store(&app, &employee_id)
    })
    .await
    .map_err(|_| "连接器凭据保存线程异常".to_string())?
}

#[tauri::command]
pub async fn delete_connector_secret(
    app: tauri::AppHandle,
    employee_id: String,
    connector_id: String,
) -> Result<ConnectorSecretStore, String> {
    validate_identifier("员工标识", &employee_id)?;
    crate::dingtalk_auth::require_employee(&app, &employee_id).await?;
    validate_identifier("连接器标识", &connector_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        delete_values(&app, &employee_id, &connector_id)?;
        load_store(&app, &employee_id)
    })
    .await
    .map_err(|_| "连接器凭据删除线程异常".to_string())?
}

fn load_store(app: &tauri::AppHandle, employee_id: &str) -> Result<ConnectorSecretStore, String> {
    let index = load_index(app, employee_id)?;
    let mut store = ConnectorSecretStore::new();
    for (connector_id, fields) in index {
        let mut values = ConnectorSecretValues::default();
        for key in fields.environment {
            if let Some(value) = load_field(employee_id, &connector_id, "env", &key)? {
                values.environment.insert(key, value);
            }
        }
        for key in fields.headers {
            if let Some(value) = load_field(employee_id, &connector_id, "header", &key)? {
                values.headers.insert(key, value);
            }
        }
        if !values.environment.is_empty() || !values.headers.is_empty() {
            store.insert(connector_id, values);
        }
    }
    Ok(store)
}

fn save_values(
    app: &tauri::AppHandle,
    employee_id: &str,
    connector_id: &str,
    values: &ConnectorSecretValues,
) -> Result<(), String> {
    validate_values(values)?;
    let mut index = load_index(app, employee_id)?;
    let previous = index.get(connector_id).cloned().unwrap_or_default();
    let next = SecretFieldIndex {
        environment: non_empty_keys(&values.environment),
        headers: non_empty_keys(&values.headers),
    };

    for key in &next.environment {
        store_field(
            employee_id,
            connector_id,
            "env",
            key,
            &values.environment[key],
        )?;
    }
    for key in &next.headers {
        store_field(
            employee_id,
            connector_id,
            "header",
            key,
            &values.headers[key],
        )?;
    }
    delete_removed_fields(
        employee_id,
        connector_id,
        "env",
        &previous.environment,
        &next.environment,
    )?;
    delete_removed_fields(
        employee_id,
        connector_id,
        "header",
        &previous.headers,
        &next.headers,
    )?;

    if next.environment.is_empty() && next.headers.is_empty() {
        index.remove(connector_id);
    } else {
        index.insert(connector_id.to_string(), next);
    }
    save_index(app, employee_id, &index)
}

fn delete_values(
    app: &tauri::AppHandle,
    employee_id: &str,
    connector_id: &str,
) -> Result<(), String> {
    let mut index = load_index(app, employee_id)?;
    if let Some(fields) = index.remove(connector_id) {
        delete_removed_fields(employee_id, connector_id, "env", &fields.environment, &[])?;
        delete_removed_fields(employee_id, connector_id, "header", &fields.headers, &[])?;
        save_index(app, employee_id, &index)?;
    }
    Ok(())
}

fn non_empty_keys(values: &BTreeMap<String, String>) -> Vec<String> {
    values
        .iter()
        .filter(|(_, value)| !value.is_empty())
        .map(|(key, _)| key.clone())
        .collect()
}

fn validate_values(values: &ConnectorSecretValues) -> Result<(), String> {
    if values.environment.len() + values.headers.len() > MAX_FIELDS_PER_CONNECTOR {
        return Err("单个连接器的密钥字段过多".to_string());
    }
    for (key, value) in values.environment.iter().chain(values.headers.iter()) {
        validate_identifier("密钥字段", key)?;
        if value.chars().count() > MAX_SECRET_CHARS
            || value.chars().any(|character| character == '\0')
        {
            return Err(format!("密钥字段 {key} 超出系统凭据库限制"));
        }
    }
    Ok(())
}

fn validate_identifier(label: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        Err(format!("{label}无效"))
    } else {
        Ok(())
    }
}

fn entry(employee_id: &str, connector_id: &str, scope: &str, key: &str) -> Result<Entry, String> {
    let account = digest(&format!("{employee_id}\0{connector_id}\0{scope}\0{key}"));
    Entry::new(KEYRING_SERVICE, &account).map_err(|error| format!("无法访问系统凭据库：{error}"))
}

fn store_field(
    employee_id: &str,
    connector_id: &str,
    scope: &str,
    key: &str,
    value: &str,
) -> Result<(), String> {
    entry(employee_id, connector_id, scope, key)?
        .set_password(value)
        .map_err(|error| format!("无法保存连接器凭据：{error}"))
}

fn load_field(
    employee_id: &str,
    connector_id: &str,
    scope: &str,
    key: &str,
) -> Result<Option<String>, String> {
    match entry(employee_id, connector_id, scope, key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("无法读取连接器凭据：{error}")),
    }
}

fn delete_removed_fields(
    employee_id: &str,
    connector_id: &str,
    scope: &str,
    previous: &[String],
    next: &[String],
) -> Result<(), String> {
    for key in previous.iter().filter(|key| !next.contains(key)) {
        match entry(employee_id, connector_id, scope, key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(error) => return Err(format!("无法删除连接器凭据：{error}")),
        }
    }
    Ok(())
}

fn index_path(app: &tauri::AppHandle, employee_id: &str) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("无法定位本机数据目录：{error}"))?
        .join("connector-secrets")
        .join(format!("{}.json", digest(employee_id))))
}

fn load_index(app: &tauri::AppHandle, employee_id: &str) -> Result<SecretIndex, String> {
    let path = index_path(app, employee_id)?;
    if !path.exists() {
        return Ok(SecretIndex::new());
    }
    let bytes = fs::read(path).map_err(|error| format!("无法读取连接器凭据索引：{error}"))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("连接器凭据索引无效：{error}"))
}

fn save_index(
    app: &tauri::AppHandle,
    employee_id: &str,
    index: &SecretIndex,
) -> Result<(), String> {
    let path = index_path(app, employee_id)?;
    let parent = path
        .parent()
        .ok_or_else(|| "连接器凭据索引路径无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建连接器凭据索引目录：{error}"))?;
    let temporary = path.with_extension("json.tmp");
    let bytes =
        serde_json::to_vec(index).map_err(|error| format!("无法生成连接器凭据索引：{error}"))?;
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("无法保存连接器凭据索引：{error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("无法保存连接器凭据索引：{error}"))?;
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(&path).map_err(|error| format!("无法替换连接器凭据索引：{error}"))?;
    }
    fs::rename(temporary, path).map_err(|error| format!("无法提交连接器凭据索引：{error}"))
}

fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_oversized_secret_values() {
        let values = ConnectorSecretValues {
            environment: BTreeMap::from([("TOKEN".to_string(), "x".repeat(MAX_SECRET_CHARS + 1))]),
            headers: BTreeMap::new(),
        };
        assert!(
            validate_values(&values)
                .unwrap_err()
                .contains("系统凭据库限制")
        );
    }
}
