use serde::Serialize;
use std::{fs, path::Path};
use tauri::Manager;
use uuid::Uuid;

const DEVICE_ID_PATH: &str = "device/device-id";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceProbe {
    device_id: String,
    desktop_version: &'static str,
    platform: &'static str,
    architecture: &'static str,
    display_count: usize,
    display_scale_percents: Vec<u32>,
}

#[tauri::command]
pub fn inspect_device_capabilities(app: tauri::AppHandle) -> Result<DeviceProbe, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法确定设备配置目录：{error}"))?;
    let device_id = load_or_create_device_id(&root)?;
    let monitors = app
        .available_monitors()
        .map_err(|error| format!("无法读取显示器信息：{error}"))?;
    let mut display_scale_percents = monitors
        .iter()
        .map(|monitor| (monitor.scale_factor() * 100.0).round() as u32)
        .collect::<Vec<_>>();
    display_scale_percents.sort_unstable();
    Ok(DeviceProbe {
        device_id,
        desktop_version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        display_count: monitors.len(),
        display_scale_percents,
    })
}

fn load_or_create_device_id(root: &Path) -> Result<String, String> {
    let path = root.join(DEVICE_ID_PATH);
    if path.exists() {
        let value =
            fs::read_to_string(&path).map_err(|error| format!("无法读取设备标识：{error}"))?;
        let normalized = value.trim();
        Uuid::parse_str(normalized).map_err(|_| "本机设备标识无效".to_string())?;
        return Ok(normalized.to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "设备配置目录无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建设备配置目录：{error}"))?;
    let value = Uuid::new_v4().to_string();
    fs::write(&path, format!("{value}\n")).map_err(|error| format!("无法保存设备标识：{error}"))?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn device_id_is_random_valid_and_stable() {
        let root = std::env::temp_dir().join(format!(
            "xiaoyin-device-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let first = load_or_create_device_id(&root).unwrap();
        let second = load_or_create_device_id(&root).unwrap();
        assert_eq!(first, second);
        assert!(Uuid::parse_str(&first).is_ok());
        fs::remove_dir_all(root).unwrap();
    }
}
