use rusqlite::{params_from_iter, types::ValueRef, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const PROTOCOL: &str = "xiaoyin.native.v1";

#[derive(Debug, Deserialize)]
struct Request {
    protocol: String,
    request_id: String,
    method: String,
    #[serde(default, rename = "payload")]
    _payload: Value,
}

#[derive(Debug, Serialize)]
struct Response {
    protocol: String,
    request_id: String,
    result: Option<Value>,
    error: Option<ErrorBody>,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
}

const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;

fn data_root() -> Result<PathBuf, String> {
    let root = std::env::var_os("XIAOYIN_NATIVE_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("xiaoyin-native-data"));
    fs::create_dir_all(&root).map_err(|error| format!("cannot create native data directory: {error}"))?;
    Ok(root)
}

fn payload_object(payload: &Value) -> Result<&Map<String, Value>, String> {
    payload.as_object().ok_or_else(|| "payload must be an object".to_owned())
}

fn text(payload: &Map<String, Value>, key: &str, required: bool) -> Result<String, String> {
    match payload.get(key).and_then(Value::as_str) {
        Some(value) if value.len() <= MAX_TEXT_BYTES && !value.chars().any(char::is_control) => Ok(value.to_owned()),
        Some(_) => Err(format!("{key} is too long or contains control characters")),
        None if required => Err(format!("{key} is required")),
        None => Ok(String::new()),
    }
}

fn safe_relative(root: &Path, value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if path.is_absolute() || value.is_empty() {
        return Err("path must be a non-empty relative path".to_owned());
    }
    for component in path.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err("path must not contain . or ..".to_owned());
        }
    }
    Ok(root.join(path))
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        result.push(HEX[(byte >> 4) as usize] as char);
        result.push(HEX[(byte & 0x0f) as usize] as char);
    }
    result
}

fn hex_decode(value: &str) -> Result<Vec<u8>, String> {
    if value.len() % 2 != 0 || value.len() > MAX_TEXT_BYTES * 2 {
        return Err("hex data has an invalid size".to_owned());
    }
    value.as_bytes().chunks_exact(2).map(|pair| {
        let high = (pair[0] as char).to_digit(16).ok_or_else(|| "invalid hex data".to_owned())?;
        let low = (pair[1] as char).to_digit(16).ok_or_else(|| "invalid hex data".to_owned())?;
        Ok(((high << 4) | low) as u8)
    }).collect()
}

fn json_sql_value(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(value) => Value::from(value),
        ValueRef::Real(value) => Value::from(value),
        ValueRef::Text(value) => Value::String(String::from_utf8_lossy(value).into_owned()),
        ValueRef::Blob(value) => Value::String(hex_encode(value)),
    }
}

fn database_path(root: &Path, payload: &Map<String, Value>) -> Result<PathBuf, String> {
    let name = text(payload, "database", false)?;
    let name = if name.is_empty() { "product.sqlite" } else { name.as_str() };
    let path = safe_relative(&root.join("sqlite"), name)?;
    if path.extension().and_then(|extension| extension.to_str()) != Some("sqlite") {
        return Err("database must use a .sqlite file".to_owned());
    }
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
    Ok(path)
}

fn sql_params(payload: &Map<String, Value>) -> Result<Vec<String>, String> {
    payload.get("params").map_or_else(|| Ok(Vec::new()), |value| {
        value.as_array().ok_or_else(|| "params must be an array".to_owned())?.iter().map(|value| {
            value.as_str().map(str::to_owned).ok_or_else(|| "sql params must be strings".to_owned())
        }).collect()
    })
}

fn sqlite_query(root: &Path, payload: &Map<String, Value>) -> Result<Value, String> {
    let sql = text(payload, "sql", true)?;
    if !sql.trim_start().to_ascii_lowercase().starts_with("select") {
        return Err("sqlite.query only accepts SELECT statements".to_owned());
    }
    let params = sql_params(payload)?;
    let database = Connection::open(database_path(root, payload)?).map_err(|error| error.to_string())?;
    let mut statement = database.prepare(&sql).map_err(|error| error.to_string())?;
    let names = statement.column_names().iter().map(|name| (*name).to_owned()).collect::<Vec<_>>();
    let rows = statement.query_map(params_from_iter(params.iter()), |row| {
        let mut result = Map::new();
        for (index, name) in names.iter().enumerate() {
            result.insert(name.clone(), json_sql_value(row.get_ref(index)?));
        }
        Ok(Value::Object(result))
    }).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    Ok(Value::Array(rows))
}

fn sqlite_execute(root: &Path, payload: &Map<String, Value>) -> Result<Value, String> {
    let sql = text(payload, "sql", true)?;
    let params = sql_params(payload)?;
    let database = Connection::open(database_path(root, payload)?).map_err(|error| error.to_string())?;
    let changed = database.execute(&sql, params_from_iter(params.iter())).map_err(|error| error.to_string())?;
    Ok(serde_json::json!({ "rowsAffected": changed }))
}

fn filesystem_list(root: &Path, payload: &Map<String, Value>) -> Result<Value, String> {
    let relative = text(payload, "path", false)?;
    let directory = if relative.is_empty() { root.to_owned() } else { safe_relative(root, &relative)? };
    let mut entries = fs::read_dir(directory).map_err(|error| error.to_string())?.map(|entry| {
        let entry = entry.map_err(|error| error.to_string())?;
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        Ok(serde_json::json!({ "name": entry.file_name().to_string_lossy(), "directory": metadata.is_dir(), "bytes": metadata.len() }))
    }).collect::<Result<Vec<_>, String>>()?;
    entries.sort_by(|left, right| left["name"].as_str().cmp(&right["name"].as_str()));
    Ok(Value::Array(entries))
}

fn filesystem_read(root: &Path, payload: &Map<String, Value>) -> Result<Value, String> {
    let path = safe_relative(root, &text(payload, "path", true)?)?;
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_TEXT_BYTES { return Err("file exceeds the native size limit".to_owned()); }
    Ok(serde_json::json!({ "encoding": "hex", "data": hex_encode(&bytes), "bytes": bytes.len() }))
}

fn filesystem_write(root: &Path, payload: &Map<String, Value>) -> Result<Value, String> {
    let path = safe_relative(root, &text(payload, "path", true)?)?;
    let data = hex_decode(&text(payload, "data", true)?)?;
    if data.len() > MAX_TEXT_BYTES { return Err("file exceeds the native size limit".to_owned()); }
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
    let temporary = path.with_extension("xiaoyin.tmp");
    fs::write(&temporary, &data).map_err(|error| error.to_string())?;
    fs::rename(temporary, &path).map_err(|error| error.to_string())?;
    Ok(serde_json::json!({ "bytes": data.len() }))
}

fn secure_storage(_root: &Path, payload: &Map<String, Value>) -> Result<Value, String> {
    let key = text(payload, "key", true)?;
    if key.len() > 200 || key.contains('/') || key.contains('\\') {
        return Err("secure storage key is invalid".to_owned());
    }
    let entry = keyring::Entry::new("com.instudio.xiaoyin", &key).map_err(|error| error.to_string())?;
    match payload.get("value") {
        None if payload.get("delete").and_then(Value::as_bool) == Some(true) => {
            match entry.delete_credential() {
                Ok(()) => Ok(serde_json::json!({ "deleted": true })),
                Err(keyring::Error::NoEntry) => Ok(serde_json::json!({ "deleted": false })),
                Err(error) => Err(error.to_string()),
            }
        }
        Some(value) if !value.is_string() => Err("secure storage value must be text".to_owned()),
        Some(value) => {
            entry.set_password(value.as_str().unwrap_or_default()).map_err(|error| error.to_string())?;
            Ok(serde_json::json!({ "stored": true }))
        }
        None => match entry.get_password() {
            Ok(value) => Ok(serde_json::json!({ "value": value })),
            Err(keyring::Error::NoEntry) => Ok(Value::Null),
            Err(error) => Err(error.to_string()),
        },
    }
}

fn device_identity(root: &Path) -> Result<Value, String> {
    let path = root.join("device").join("device-id");
    let id = match fs::read_to_string(&path) {
        Ok(value) => value.trim().to_owned(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(path.parent().ok_or("invalid device path")?).map_err(|error| error.to_string())?;
            let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_nanos();
            let value = format!("xiaoyin-{now:x}-{}", std::process::id());
            fs::write(&path, &value).map_err(|error| error.to_string())?;
            value
        }
        Err(error) => return Err(error.to_string()),
    };
    Ok(serde_json::json!({ "deviceId": id, "platform": std::env::consts::OS, "architecture": std::env::consts::ARCH }))
}

fn image_preview(root: &Path, payload: &Map<String, Value>) -> Result<Value, String> {
    let path = safe_relative(root, &text(payload, "path", true)?)?;
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") { "image/png" }
        else if bytes.starts_with(b"\xff\xd8\xff") { "image/jpeg" }
        else if bytes.starts_with(b"GIF8") { "image/gif" }
        else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") { "image/webp" }
        else { "application/octet-stream" };
    Ok(serde_json::json!({ "mimeType": mime, "bytes": bytes.len(), "previewable": mime.starts_with("image/") }))
}

fn attachments(root: &Path, method: &str, payload: &Map<String, Value>) -> Result<Value, String> {
    let directory = root.join("attachments");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    match method {
        "attachments.put" => {
            let name = text(payload, "name", true)?;
            let path = safe_relative(&directory, &name)?;
            let data = hex_decode(&text(payload, "data", true)?)?;
            if data.len() > MAX_TEXT_BYTES { return Err("attachment exceeds the native size limit".to_owned()); }
            if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
            fs::write(&path, data).map_err(|error| error.to_string())?;
            Ok(serde_json::json!({ "name": name }))
        }
        "attachments.get" => {
            let name = text(payload, "name", true)?;
            let bytes = fs::read(safe_relative(&directory, &name)?).map_err(|error| error.to_string())?;
            if bytes.len() > MAX_TEXT_BYTES { return Err("attachment exceeds the native size limit".to_owned()); }
            Ok(serde_json::json!({ "name": name, "encoding": "hex", "data": hex_encode(&bytes), "bytes": bytes.len() }))
        }
        "attachments.list" => {
            let mut names = Vec::new();
            for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
                let entry = entry.map_err(|error| error.to_string())?;
                if entry.file_type().map_err(|error| error.to_string())?.is_file() {
                    names.push(entry.file_name().to_string_lossy().into_owned());
                }
            }
            names.sort();
            Ok(Value::Array(names.into_iter().map(Value::String).collect()))
        }
        _ => Err("attachment method is not enabled".to_owned()),
    }
}

fn file_undo(root: &Path, method: &str, payload: &Map<String, Value>) -> Result<Value, String> {
    let directory = root.join("undo");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    match method {
        "file-undo.record" => {
            let source = text(payload, "path", true)?;
            let source_path = safe_relative(root, &source)?;
            let id = format!("{}-{}", SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_nanos(), std::process::id());
            let backup = directory.join(&id);
            fs::copy(&source_path, &backup).map_err(|error| error.to_string())?;
            fs::write(directory.join(format!("{id}.source")), source.as_bytes()).map_err(|error| error.to_string())?;
            Ok(serde_json::json!({ "undoId": id }))
        }
        "file-undo.undo" => {
            let id = text(payload, "undoId", true)?;
            let source = fs::read_to_string(directory.join(format!("{id}.source"))).map_err(|error| error.to_string())?;
            let source_path = safe_relative(root, source.trim())?;
            fs::copy(directory.join(&id), &source_path).map_err(|error| error.to_string())?;
            Ok(serde_json::json!({ "restored": true }))
        }
        _ => Err("undo method is not enabled".to_owned()),
    }
}

fn dingtalk_auth_state(root: &Path, payload: &Map<String, Value>) -> Result<Value, String> {
    let path = root.join("auth").join("dingtalk-state.json");
    if let Some(value) = payload.get("value") {
        if !value.is_object() { return Err("DingTalk auth state must be an object".to_owned()); }
        if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
        fs::write(&path, serde_json::to_vec(value).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
        return Ok(serde_json::json!({ "stored": true }));
    }
    match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| error.to_string()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Value::Null),
        Err(error) => Err(error.to_string()),
    }
}

fn response_ok(request_id: &str, result: Value) -> Response {
    Response { protocol: PROTOCOL.to_owned(), request_id: request_id.to_owned(), result: Some(result), error: None }
}

fn response_error(request_id: &str, code: &'static str, message: impl Into<String>) -> Response {
    Response { protocol: PROTOCOL.to_owned(), request_id: request_id.to_owned(), result: None,
        error: Some(ErrorBody { code, message: message.into() }) }
}

fn dispatch(request: Request) -> Response {
    if request.protocol != PROTOCOL {
        return response_error("", "INVALID_PROTOCOL", "unsupported native protocol");
    }
    let root = match data_root() { Ok(root) => root, Err(error) => return response_error(&request.request_id, "STORAGE_UNAVAILABLE", error) };
    const METHODS: &[&str] = &[
        "health", "filesystem.list", "filesystem.read", "filesystem.write", "secure-storage.get",
        "secure-storage.set", "secure-storage.delete", "device-identity.get", "image-preview.inspect", "sqlite.query",
        "sqlite.execute", "dingtalk-auth.state",
        "attachments.put", "attachments.get", "attachments.list", "file-undo.record", "file-undo.undo",
    ];
    if !METHODS.contains(&request.method.as_str()) {
        return response_error(&request.request_id, "METHOD_NOT_ALLOWED", "native method is not enabled");
    }
    let result = match request.method.as_str() {
        "health" => Ok(serde_json::json!({ "ready": true, "protocol": PROTOCOL, "capabilities": ["filesystem", "secure-storage", "sqlite", "dingtalk-auth", "attachments", "file-undo", "device-identity", "image-preview"] })),
        "filesystem.list" => payload_object(&request._payload).and_then(|payload| filesystem_list(&root, payload)),
        "filesystem.read" => payload_object(&request._payload).and_then(|payload| filesystem_read(&root, payload)),
        "filesystem.write" => payload_object(&request._payload).and_then(|payload| filesystem_write(&root, payload)),
        "secure-storage.get" | "secure-storage.set" => payload_object(&request._payload).and_then(|payload| secure_storage(&root, payload)),
        "secure-storage.delete" => payload_object(&request._payload).and_then(|payload| secure_storage(&root, &Map::from_iter([
            ("key".to_owned(), payload.get("key").cloned().unwrap_or(Value::Null)),
            ("delete".to_owned(), Value::Bool(true)),
        ]))),
        "device-identity.get" => device_identity(&root),
        "image-preview.inspect" => payload_object(&request._payload).and_then(|payload| image_preview(&root, payload)),
        "sqlite.query" => payload_object(&request._payload).and_then(|payload| sqlite_query(&root, payload)),
        "sqlite.execute" => payload_object(&request._payload).and_then(|payload| sqlite_execute(&root, payload)),
        "dingtalk-auth.state" => payload_object(&request._payload).and_then(|payload| dingtalk_auth_state(&root, payload)),
        "attachments.put" | "attachments.get" | "attachments.list" => payload_object(&request._payload).and_then(|payload| attachments(&root, request.method.as_str(), payload)),
        "file-undo.record" | "file-undo.undo" => payload_object(&request._payload).and_then(|payload| file_undo(&root, request.method.as_str(), payload)),
        _ => unreachable!("method list is checked before dispatch"),
    };
    match result {
        Ok(result) => response_ok(&request.request_id, result),
        Err(error) => response_error(&request.request_id, "NATIVE_OPERATION_FAILED", error),
    }
}

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) if !line.trim().is_empty() => line,
            _ => continue,
        };
        let response = match serde_json::from_str::<Request>(&line) {
            Ok(request) => dispatch(request),
            Err(error) => response_error("", "INVALID_REQUEST", error.to_string()),
        };
        if serde_json::to_writer(&mut stdout, &response).is_err() || writeln!(stdout).is_err() {
            break;
        }
        let _ = stdout.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(protocol: &str, method: &str) -> Request {
        Request {
            protocol: protocol.to_owned(),
            request_id: "test-request".to_owned(),
            method: method.to_owned(),
            _payload: Value::Null,
        }
    }

    #[test]
    fn health_is_protocol_scoped() {
        let response = dispatch(request(PROTOCOL, "health"));
        assert_eq!(response.protocol, PROTOCOL);
        assert_eq!(response.request_id, "test-request");
        assert_eq!(response.result.as_ref().and_then(|value| value.get("ready")), Some(&Value::Bool(true)));
        assert!(response.result.as_ref().and_then(|value| value.get("capabilities")).is_some());
        assert!(response.error.is_none());
    }

    #[test]
    fn unknown_methods_fail_closed() {
        let response = dispatch(request(PROTOCOL, "shell.exec"));
        assert!(response.result.is_none());
        assert_eq!(response.error.as_ref().map(|error| error.code), Some("METHOD_NOT_ALLOWED"));
    }

    #[test]
    fn wrong_protocol_is_rejected_before_dispatch() {
        let response = dispatch(request("xiaoyin.native.v0", "health"));
        assert!(response.result.is_none());
        assert_eq!(response.error.as_ref().map(|error| error.code), Some("INVALID_PROTOCOL"));
        assert_eq!(response.request_id, "");
    }

    #[test]
    fn filesystem_round_trip_is_bounded() {
        let root = std::env::temp_dir().join(format!("xiaoyin-native-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let payload = serde_json::json!({ "path": "nested/value.bin", "data": "68656c6c6f" });
        filesystem_write(&root, payload.as_object().unwrap()).unwrap();
        let read = filesystem_read(&root, serde_json::json!({ "path": "nested/value.bin" }).as_object().unwrap()).unwrap();
        assert_eq!(read["data"], "68656c6c6f");
        assert!(filesystem_read(&root, serde_json::json!({ "path": "../escape" }).as_object().unwrap()).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sqlite_query_and_execute_stay_inside_the_sidecar_root() {
        let root = std::env::temp_dir().join(format!("xiaoyin-sqlite-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        sqlite_execute(&root, serde_json::json!({ "sql": "CREATE TABLE values_table (value TEXT)", "database": "test.sqlite" }).as_object().unwrap()).unwrap();
        sqlite_execute(&root, serde_json::json!({ "sql": "INSERT INTO values_table(value) VALUES (?)", "params": ["ok"], "database": "test.sqlite" }).as_object().unwrap()).unwrap();
        let result = sqlite_query(&root, serde_json::json!({ "sql": "SELECT value FROM values_table", "database": "test.sqlite" }).as_object().unwrap()).unwrap();
        assert_eq!(result, serde_json::json!([{ "value": "ok" }]));
        assert!(sqlite_query(&root, serde_json::json!({ "sql": "DELETE FROM values_table", "database": "test.sqlite" }).as_object().unwrap()).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
