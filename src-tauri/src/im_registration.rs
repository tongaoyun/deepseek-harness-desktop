//! DingTalk device registration, using the public protocol from the official connector.
//! No application is created here without the user scanning and confirming in DingTalk.
use serde_json::{Value, json};
use std::time::Duration;

async fn registration_request(action: &str, body: Value) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法初始化扫码连接")?;
    let response = client
        .post(format!(
            "https://oapi.dingtalk.com/app/registration/{action}"
        ))
        .json(&body)
        .send()
        .await
        .map_err(|_| "钉钉扫码服务暂不可达，请重试或使用手动配置")?;
    if !response.status().is_success() {
        return Err("钉钉扫码服务返回异常，请重试".into());
    }
    let value: Value = response.json().await.map_err(|_| "扫码服务响应无效")?;
    if value["errcode"].as_i64() != Some(0) {
        return Err("钉钉未接受扫码请求，请刷新或使用手动配置".into());
    }
    Ok(value)
}

#[tauri::command]
pub async fn begin_dingtalk_registration() -> Result<Value, String> {
    let init = registration_request("init", json!({"source":"XIAOYIN"})).await?;
    let nonce = required(&init, "nonce")?;
    let begin = registration_request("begin", json!({"nonce":nonce})).await?;
    registration_session(&begin)
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
pub async fn poll_dingtalk_registration(device_code: String) -> Result<Value, String> {
    if device_code.trim().is_empty() || device_code.len() > 4096 {
        return Err("扫码会话无效".into());
    }
    let value = registration_request("poll", json!({"device_code":device_code})).await?;
    registration_result(&value)
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
