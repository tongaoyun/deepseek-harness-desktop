//! DingTalk device registration, using the public protocol from the official connector.
//! No application is created here without the user scanning and confirming in DingTalk.
use serde_json::{Value, json};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

static REGISTRATION: Mutex<RegistrationState> = Mutex::new(RegistrationState {
    revision: 0,
    lease: None,
});

struct RegistrationState {
    revision: u64,
    lease: Option<RegistrationLease>,
}

const MAX_REGISTRATION_RESPONSE_BYTES: usize = 64 * 1024;

enum RegistrationRequestError {
    Temporary(&'static str),
    Invalid(&'static str),
}

impl RegistrationRequestError {
    fn message(self) -> String {
        match self {
            Self::Temporary(message) | Self::Invalid(message) => message.to_string(),
        }
    }
}

struct RegistrationLease {
    employee_id: String,
    session_epoch: u64,
    device_code: String,
    expires_at: Instant,
}

impl RegistrationLease {
    fn allows(&self, employee_id: &str, session_epoch: u64, device_code: &str) -> bool {
        self.employee_id == employee_id
            && self.session_epoch == session_epoch
            && self.device_code == device_code
            && Instant::now() < self.expires_at
    }
}

async fn registration_request(
    action: &str,
    body: Value,
) -> Result<Value, RegistrationRequestError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| RegistrationRequestError::Invalid("无法初始化扫码连接"))?;
    let mut response = client
        .post(format!(
            "https://oapi.dingtalk.com/app/registration/{action}"
        ))
        .json(&body)
        .send()
        .await
        .map_err(|_| {
            RegistrationRequestError::Temporary("钉钉扫码服务暂不可达，请重试或使用手动配置")
        })?;
    if !response.status().is_success() {
        return Err(if response.status().is_server_error() {
            RegistrationRequestError::Temporary("钉钉扫码服务返回异常，请重试")
        } else {
            RegistrationRequestError::Invalid("钉钉未接受扫码请求，请刷新或使用手动配置")
        });
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| RegistrationRequestError::Temporary("扫码服务响应暂时无法读取"))?
    {
        append_response_chunk(&mut bytes, &chunk)
            .map_err(|_| RegistrationRequestError::Invalid("扫码服务响应过大"))?;
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| RegistrationRequestError::Invalid("扫码服务响应无效"))?;
    if value["errcode"].as_i64() != Some(0) {
        return Err(RegistrationRequestError::Invalid(
            "钉钉未接受扫码请求，请刷新或使用手动配置",
        ));
    }
    Ok(value)
}

fn append_response_chunk(bytes: &mut Vec<u8>, chunk: &[u8]) -> Result<(), String> {
    if bytes.len().saturating_add(chunk.len()) > MAX_REGISTRATION_RESPONSE_BYTES {
        return Err("扫码服务响应过大".into());
    }
    bytes.extend_from_slice(chunk);
    Ok(())
}

#[tauri::command]
pub async fn begin_dingtalk_registration(app: tauri::AppHandle) -> Result<Value, String> {
    let employee_id = crate::dingtalk_auth::current_employee(&app).await?;
    let session_epoch = crate::dingtalk_auth::mcp::session_epoch();
    let revision = {
        let mut state = REGISTRATION.lock().map_err(|_| "扫码状态不可用")?;
        state.revision = state.revision.wrapping_add(1);
        state.lease = None;
        state.revision
    };
    let init = registration_request("init", json!({"source":"XIAOYIN"}))
        .await
        .map_err(RegistrationRequestError::message)?;
    let nonce = required(&init, "nonce")?;
    let begin = registration_request("begin", json!({"nonce":nonce}))
        .await
        .map_err(RegistrationRequestError::message)?;
    let session = registration_session(&begin)?;
    if crate::dingtalk_auth::current_employee(&app).await? != employee_id
        || crate::dingtalk_auth::mcp::session_epoch() != session_epoch
    {
        return Err("登录账号已切换，请重新获取二维码".into());
    }
    let mut state = REGISTRATION.lock().map_err(|_| "扫码状态不可用")?;
    if state.revision != revision {
        return Err("二维码已刷新，请使用新二维码".into());
    }
    state.lease = Some(RegistrationLease {
        employee_id,
        session_epoch,
        device_code: required(&session, "deviceCode")?.to_string(),
        expires_at: Instant::now()
            + Duration::from_secs(session["expiresIn"].as_u64().unwrap_or(7200)),
    });
    Ok(session)
}

fn registration_session(begin: &Value) -> Result<Value, String> {
    let device_code = required(begin, "device_code")?;
    let uri = required(begin, "verification_uri_complete")?;
    let parsed = reqwest::Url::parse(uri).map_err(|_| "扫码地址无效")?;
    if parsed.scheme() != "https"
        || !parsed
            .host_str()
            .is_some_and(|host| host == "dingtalk.com" || host.ends_with(".dingtalk.com"))
    {
        return Err("扫码地址不是钉钉官方地址".into());
    }
    Ok(json!({"deviceCode":device_code,"verificationUri":uri,
        "expiresIn":begin["expires_in"].as_u64().unwrap_or(7200).clamp(1,7200),
        "interval":begin["interval"].as_u64().unwrap_or(3).clamp(2,60)}))
}

#[tauri::command]
pub async fn poll_dingtalk_registration(
    app: tauri::AppHandle,
    device_code: String,
) -> Result<Value, String> {
    if device_code.trim().is_empty() || device_code.len() > 4096 {
        return Err("扫码会话无效".into());
    }
    let employee_id = crate::dingtalk_auth::current_employee(&app).await?;
    let session_epoch = crate::dingtalk_auth::mcp::session_epoch();
    {
        let state = REGISTRATION.lock().map_err(|_| "扫码状态不可用")?;
        if !state
            .lease
            .as_ref()
            .is_some_and(|value| value.allows(&employee_id, session_epoch, &device_code))
        {
            return Err("扫码会话已失效，请重新获取二维码".into());
        }
    }
    let value = match registration_request("poll", json!({"device_code":device_code})).await {
        Ok(value) => value,
        Err(RegistrationRequestError::Temporary(_)) => return Ok(json!({"status":"RETRY"})),
        Err(error) => return Err(error.message()),
    };
    if crate::dingtalk_auth::current_employee(&app).await? != employee_id
        || crate::dingtalk_auth::mcp::session_epoch() != session_epoch
    {
        return Err("登录账号已切换，请重新获取二维码".into());
    }
    let mut state = REGISTRATION.lock().map_err(|_| "扫码状态不可用")?;
    if !state
        .lease
        .as_ref()
        .is_some_and(|value| value.allows(&employee_id, session_epoch, &device_code))
    {
        return Err("扫码会话已失效，请重新获取二维码".into());
    }
    let result = registration_result(&value)?;
    if result["status"] != "WAITING" {
        state.lease = None;
    }
    Ok(result)
}

fn registration_result(value: &Value) -> Result<Value, String> {
    match value["status"]
        .as_str()
        .unwrap_or("")
        .to_uppercase()
        .as_str()
    {
        "SUCCESS" => Ok(
            json!({"status":"SUCCESS", "clientId":required(value,"client_id")?, "clientSecret":required(value,"client_secret")?}),
        ),
        "WAITING" => Ok(json!({"status":"WAITING"})),
        "EXPIRED" => Ok(json!({"status":"EXPIRED"})),
        "FAIL" => Ok(json!({"status":"FAIL"})),
        _ => Err("扫码状态无法识别，请刷新二维码".into()),
    }
}

fn required<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value[field]
        .as_str()
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| "扫码服务返回的数据不完整".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn registration_response_is_bounded_even_when_sent_in_chunks() {
        let mut bytes = vec![0; MAX_REGISTRATION_RESPONSE_BYTES - 1];
        append_response_chunk(&mut bytes, &[0]).unwrap();
        assert!(append_response_chunk(&mut bytes, &[0]).is_err());
        assert_eq!(bytes.len(), MAX_REGISTRATION_RESPONSE_BYTES);
    }
    #[test]
    fn registration_lease_rejects_another_employee_session_code_or_expired_qr() {
        let lease = RegistrationLease {
            employee_id: "employee-1".into(),
            session_epoch: 2,
            device_code: "device-1".into(),
            expires_at: Instant::now() + Duration::from_secs(60),
        };
        assert!(lease.allows("employee-1", 2, "device-1"));
        assert!(!lease.allows("employee-2", 2, "device-1"));
        assert!(!lease.allows("employee-1", 4, "device-1"));
        assert!(!lease.allows("employee-1", 2, "device-2"));
        let expired = RegistrationLease {
            expires_at: Instant::now() - Duration::from_secs(1),
            ..lease
        };
        assert!(!expired.allows("employee-1", 2, "device-1"));
    }
    #[test]
    fn rejects_non_official_urls_and_incomplete_credentials() {
        assert!(registration_session(&json!({"device_code":"one","verification_uri_complete":"https://dingtalk.com.evil.test"})).is_err());
        assert!(registration_result(&json!({"status":"SUCCESS","client_id":"one"})).is_err());
        assert_eq!(
            registration_result(&json!({"status":"EXPIRED"})).unwrap()["status"],
            "EXPIRED"
        );
    }
    #[test]
    fn normalizes_session_intervals_and_returns_only_registration_fields() {
        let value = registration_session(&json!({"device_code":"one","verification_uri_complete":"https://open.dingtalk.com/registration","interval":0,"expires_in":99999})).unwrap();
        assert_eq!(value["interval"], 2);
        assert_eq!(value["expiresIn"], 7200);
        assert!(value.get("clientSecret").is_none());
    }
}
