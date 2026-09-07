use base64::Engine;
use serde::Serialize;
use std::{fs::File, io::Read, path::Path};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackImage {
    name: String,
    media_type: String,
    data: String,
}

/// Reads only an explicit file selected/pasted/dropped for feedback, without
/// authorizing its directory for task execution or creating an attachment cache.
#[tauri::command]
pub fn read_feedback_image(path: String) -> Result<FeedbackImage, String> {
    let path = Path::new(&path);
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
    if !meta.is_file() || meta.len() == 0 || meta.len() > 5 * 1024 * 1024 {
        return Err("图片不能为空，单张不能超过 5 MB".into());
    }
    let mut data = Vec::new();
    file.take(5 * 1024 * 1024 + 1)
        .read_to_end(&mut data)
        .map_err(|_| "读取反馈图片失败")?;
    if data.len() > 5 * 1024 * 1024 {
        return Err("单张图片不能超过 5 MB".into());
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
        std::fs::write(&image, b"test image").unwrap();
        let result = read_feedback_image(image.to_string_lossy().into_owned()).unwrap();
        assert_eq!(result.media_type, "image/png");
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(result.data)
                .unwrap(),
            b"test image"
        );
        std::fs::write(&image, b"").unwrap();
        assert!(read_feedback_image(image.to_string_lossy().into_owned()).is_err());
        File::create(&image)
            .unwrap()
            .set_len(5 * 1024 * 1024 + 1)
            .unwrap();
        assert!(read_feedback_image(image.to_string_lossy().into_owned()).is_err());
        assert!(
            read_feedback_image(dir.join("secret.txt").to_string_lossy().into_owned()).is_err()
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
