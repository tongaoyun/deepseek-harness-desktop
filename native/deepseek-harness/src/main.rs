use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const PROTOCOL: &str = "deepseek-harness.native.v1";

#[derive(Debug, Deserialize)]
struct Request {
    protocol: String,
    request_id: String,
    method: String,
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

fn data_root() -> Result<PathBuf, String> {
    let root = std::env::var_os("DEEPSEEK_HARNESS_NATIVE_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("deepseek-harness-native-data"));
    fs::create_dir_all(&root)
        .map_err(|error| format!("cannot create native data directory: {error}"))?;
    Ok(root)
}

fn device_identity(root: &Path) -> Result<Value, String> {
    let path = root.join("device").join("device-id");
    let id = match fs::read_to_string(&path) {
        Ok(value) => value.trim().to_owned(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(path.parent().ok_or("invalid device path")?)
                .map_err(|error| error.to_string())?;
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|error| error.to_string())?
                .as_nanos();
            let value = format!("deepseek-harness-{now:x}-{}", std::process::id());
            fs::write(&path, &value).map_err(|error| error.to_string())?;
            value
        }
        Err(error) => return Err(error.to_string()),
    };
    Ok(
        serde_json::json!({ "deviceId": id, "platform": std::env::consts::OS, "architecture": std::env::consts::ARCH }),
    )
}

fn response_ok(request_id: &str, result: Value) -> Response {
    Response {
        protocol: PROTOCOL.to_owned(),
        request_id: request_id.to_owned(),
        result: Some(result),
        error: None,
    }
}

fn response_error(request_id: &str, code: &'static str, message: impl Into<String>) -> Response {
    Response {
        protocol: PROTOCOL.to_owned(),
        request_id: request_id.to_owned(),
        result: None,
        error: Some(ErrorBody {
            code,
            message: message.into(),
        }),
    }
}

fn dispatch(request: Request) -> Response {
    if request.protocol != PROTOCOL {
        return response_error("", "INVALID_PROTOCOL", "unsupported native protocol");
    }
    if !matches!(request.method.as_str(), "health" | "device-identity.get") {
        return response_error(
            &request.request_id,
            "METHOD_NOT_ALLOWED",
            "native method is not enabled",
        );
    }
    let root = match data_root() {
        Ok(root) => root,
        Err(error) => return response_error(&request.request_id, "STORAGE_UNAVAILABLE", error),
    };
    let result = match request.method.as_str() {
        "health" => Ok(
            serde_json::json!({ "ready": true, "protocol": PROTOCOL, "capabilities": ["device-identity"] }),
        ),
        "device-identity.get" => device_identity(&root),
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
        }
    }

    #[test]
    fn health_is_protocol_scoped() {
        let response = dispatch(request(PROTOCOL, "health"));
        assert_eq!(response.protocol, PROTOCOL);
        assert_eq!(response.request_id, "test-request");
        assert_eq!(
            response
                .result
                .as_ref()
                .and_then(|value| value.get("ready")),
            Some(&Value::Bool(true))
        );
        assert_eq!(
            response
                .result
                .as_ref()
                .and_then(|value| value.get("capabilities")),
            Some(&serde_json::json!(["device-identity"]))
        );
        assert!(response.error.is_none());
    }

    #[test]
    fn unknown_methods_fail_closed() {
        let response = dispatch(request(PROTOCOL, "shell.exec"));
        assert!(response.result.is_none());
        assert_eq!(
            response.error.as_ref().map(|error| error.code),
            Some("METHOD_NOT_ALLOWED")
        );
    }

    #[test]
    fn wrong_protocol_is_rejected_before_dispatch() {
        let response = dispatch(request("deepseek-harness.native.v0", "health"));
        assert!(response.result.is_none());
        assert_eq!(
            response.error.as_ref().map(|error| error.code),
            Some("INVALID_PROTOCOL")
        );
        assert_eq!(response.request_id, "");
    }

    #[test]
    fn retired_product_methods_are_rejected() {
        for method in [
            "filesystem.list",
            "filesystem.read",
            "filesystem.write",
            "secure-storage.get",
            "secure-storage.set",
            "secure-storage.delete",
            "sqlite.query",
            "sqlite.execute",
            "dingtalk-auth.state",
            "attachments.put",
            "attachments.get",
            "attachments.list",
            "file-undo.record",
            "file-undo.undo",
            "image-preview.inspect",
        ] {
            let response = dispatch(request(PROTOCOL, method));
            assert!(response.result.is_none(), "{method}");
            assert_eq!(
                response.error.as_ref().map(|error| error.code),
                Some("METHOD_NOT_ALLOWED"),
                "{method}"
            );
        }
    }

    #[test]
    fn device_identity_preserves_existing_installations() {
        let root = std::env::temp_dir().join(format!(
            "deepseek-harness-identity-test-{}",
            std::process::id()
        ));
        fs::create_dir_all(root.join("device")).unwrap();
        fs::write(root.join("device/device-id"), "existing-installation-id\n").unwrap();
        assert_eq!(
            device_identity(&root).unwrap()["deviceId"],
            "existing-installation-id"
        );
        assert_eq!(
            fs::read_to_string(root.join("device/device-id")).unwrap(),
            "existing-installation-id\n"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
