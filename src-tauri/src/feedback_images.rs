use base64::Engine;
use serde::Serialize;
use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
const GRANT_AGE: Duration = Duration::from_secs(120);

#[derive(Default)]
pub struct FeedbackImageGrants(Mutex<Vec<FeedbackImageGrant>>);

struct FeedbackImageGrant {
    path: PathBuf,
    epoch: u64,
    created_at: Instant,
}

impl FeedbackImageGrants {
    pub fn register(&self, paths: &[PathBuf], epoch: u64) {
        if paths.len() > 32 {
            return;
        }
        if let Ok(mut grants) = self.0.lock() {
            grants.retain(|grant| grant.epoch == epoch && grant.created_at.elapsed() < GRANT_AGE);
            for path in paths {
                grants.retain(|grant| grant.path != *path);
                grants.push(FeedbackImageGrant {
                    path: path.clone(),
                    epoch,
                    created_at: Instant::now(),
                });
            }
            // Only the most recent native selections need to remain eligible.
            if grants.len() > 32 {
                let excess = grants.len() - 32;
                grants.drain(..excess);
            }
        }
    }

    fn consume(&self, path: &Path, epoch: u64) -> Result<(), String> {
        let mut grants = self.0.lock().map_err(|_| "无法核实反馈图片来源")?;
        grants.retain(|grant| grant.epoch == epoch && grant.created_at.elapsed() < GRANT_AGE);
        let index = grants
            .iter()
            .position(|grant| grant.path == path)
            .ok_or("请重新拖入或粘贴反馈图片")?;
        grants.remove(index);
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackImage {
    name: String,
    media_type: String,
    data: String,
}

/// Native drops and clipboard file URLs grant a single short-lived image read.
/// Browser file-picker and in-page paste files are read through File instead.
#[tauri::command]
pub async fn read_feedback_image(
    app: tauri::AppHandle,
    grants: tauri::State<'_, FeedbackImageGrants>,
    path: String,
) -> Result<FeedbackImage, String> {
    crate::dingtalk_auth::current_employee(&app).await?;
    let epoch = crate::dingtalk_auth::mcp::session_epoch();
    let path = PathBuf::from(path);
    grants.consume(&path, epoch)?;
    let image = tauri::async_runtime::spawn_blocking(move || read_image(&path))
        .await
        .map_err(|_| "读取反馈图片失败")??;
    crate::dingtalk_auth::current_employee(&app).await?;
    if crate::dingtalk_auth::mcp::session_epoch() != epoch {
        return Err("当前登录账号已变更，请重新添加图片".into());
    }
    Ok(image)
}

fn read_image(path: &Path) -> Result<FeedbackImage, String> {
    let media_type = match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => return Err("请选择 PNG、JPEG 或 WebP 图片".into()),
    };
    let file = File::open(path).map_err(|_| "无法读取反馈图片")?;
    let meta = file.metadata().map_err(|_| "无法读取反馈图片信息")?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_IMAGE_BYTES {
        return Err("图片不能为空，单张不能超过 5 MB".into());
    }
    let mut data = Vec::new();
    file.take(MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(|_| "读取反馈图片失败")?;
    if data.len() as u64 > MAX_IMAGE_BYTES {
        return Err("单张图片不能超过 5 MB".into());
    }
    let valid = match media_type {
        "image/png" => data.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => data.starts_with(&[0xff, 0xd8, 0xff]),
        "image/webp" => data.len() >= 12 && data.starts_with(b"RIFF") && &data[8..12] == b"WEBP",
        _ => false,
    };
    if !valid {
        return Err("图片内容与格式不符".into());
    }
    Ok(FeedbackImage {
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        media_type: media_type.into(),
        data: base64::engine::general_purpose::STANDARD.encode(data),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_explicit_images_and_rejects_empty_oversized_or_other_files() {
        let dir =
            std::env::temp_dir().join(format!("xiaoyin-feedback-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let image = dir.join("截图.PNG");
        let png = b"\x89PNG\r\n\x1a\nimage data";
        std::fs::write(&image, png).unwrap();
        let result = read_image(&image).unwrap();
        assert_eq!(result.media_type, "image/png");
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(result.data)
                .unwrap(),
            png
        );
        std::fs::write(&image, b"not an image").unwrap();
        assert!(read_image(&image).is_err());
        std::fs::write(&image, b"").unwrap();
        assert!(read_image(&image).is_err());
        File::create(&image)
            .unwrap()
            .set_len(5 * 1024 * 1024 + 1)
            .unwrap();
        assert!(read_image(&image).is_err());
        assert!(read_image(&dir.join("secret.txt")).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn grants_are_single_use_and_bound_to_login_epoch() {
        let grants = FeedbackImageGrants::default();
        let image = PathBuf::from("/tmp/feedback-image.png");
        let other = PathBuf::from("/tmp/unselected.png");
        let epoch = crate::dingtalk_auth::mcp::session_epoch();
        grants.register(std::slice::from_ref(&image), epoch);
        assert!(grants.consume(&other, epoch).is_err());
        assert!(grants.consume(&image, epoch.wrapping_add(1)).is_err());
        grants.register(std::slice::from_ref(&image), epoch);
        grants.consume(&image, epoch).unwrap();
        assert!(grants.consume(&image, epoch).is_err());
    }

    #[test]
    fn grants_expire_before_read() {
        let grants = FeedbackImageGrants::default();
        let path = PathBuf::from("/tmp/expired.png");
        let epoch = crate::dingtalk_auth::mcp::session_epoch();
        grants.0.lock().unwrap().push(FeedbackImageGrant {
            path: path.clone(),
            epoch,
            created_at: Instant::now() - GRANT_AGE,
        });
        assert!(grants.consume(&path, epoch).is_err());
    }
}
