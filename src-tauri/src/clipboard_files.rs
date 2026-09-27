/// Read file references only in response to a user paste; never poll or modify the clipboard.
#[tauri::command]
pub async fn clipboard_file_paths(
    app: tauri::AppHandle,
    grants: tauri::State<'_, crate::feedback_images::FeedbackImageGrants>,
) -> Result<Vec<String>, String> {
    crate::dingtalk_auth::current_employee(&app).await?;
    let epoch = crate::dingtalk_auth::mcp::session_epoch();
    let paths = platform_paths()?;
    crate::dingtalk_auth::current_employee(&app).await?;
    if crate::dingtalk_auth::mcp::session_epoch() != epoch {
        return Err("当前登录账号已变更，请重新粘贴文件".into());
    }
    grants.register(
        &paths
            .iter()
            .map(std::path::PathBuf::from)
            .collect::<Vec<_>>(),
        epoch,
    );
    Ok(paths)
}

#[cfg(target_os = "macos")]
fn platform_paths() -> Result<Vec<String>, String> {
    read_macos_files(&objc2_app_kit::NSPasteboard::generalPasteboard())
}

#[cfg(target_os = "macos")]
fn read_macos_files(board: &objc2_app_kit::NSPasteboard) -> Result<Vec<String>, String> {
    use objc2_app_kit::NSPasteboardTypeFileURL;
    use objc2_foundation::NSURL;
    let Some(items) = board.pasteboardItems() else {
        return Ok(Vec::new());
    };
    let mut paths = Vec::new();
    for item in items.iter() {
        // AppKit's constant is immutable and available for the process lifetime.
        if let Some(value) = item.stringForType(unsafe { NSPasteboardTypeFileURL }) {
            let url = NSURL::URLWithString(&value).ok_or("剪贴板文件地址无效")?;
            if !url.isFileURL() {
                continue;
            }
            let path = url.path().ok_or("剪贴板文件路径无效")?.to_string();
            if !paths.contains(&path) {
                paths.push(path);
            }
            if paths.len() > 32 {
                return Err("单次最多粘贴 32 个文件或文件夹".into());
            }
        }
    }
    Ok(paths)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeFileURL, NSPasteboardTypeString};
    use objc2_foundation::NSString;

    #[test]
    fn reads_native_file_urls_without_treating_plain_paths_as_files() {
        // A private pasteboard leaves the user's general clipboard untouched.
        let board = NSPasteboard::pasteboardWithUniqueName();
        board.clearContents();
        board.setString_forType(&NSString::from_str("/tmp/a.txt"), unsafe {
            NSPasteboardTypeString
        });
        assert!(read_macos_files(&board).unwrap().is_empty());
        board.clearContents();
        board.setString_forType(
            &NSString::from_str("file:///tmp/My%20Files/%E6%8A%A5%E5%91%8A.pdf"),
            unsafe { NSPasteboardTypeFileURL },
        );
        assert_eq!(
            read_macos_files(&board).unwrap(),
            vec!["/tmp/My Files/报告.pdf"]
        );
        board.clearContents();
    }
}

#[cfg(target_os = "windows")]
fn platform_paths() -> Result<Vec<String>, String> {
    use std::ffi::c_void;
    #[link(name = "user32")]
    unsafe extern "system" {
        fn OpenClipboard(window: *mut c_void) -> i32;
        fn CloseClipboard() -> i32;
        fn IsClipboardFormatAvailable(format: u32) -> i32;
        fn GetClipboardData(format: u32) -> *mut c_void;
    }
    #[link(name = "shell32")]
    unsafe extern "system" {
        fn DragQueryFileW(drop: *mut c_void, index: u32, buffer: *mut u16, length: u32) -> u32;
    }
    struct Clipboard;
    impl Drop for Clipboard {
        fn drop(&mut self) {
            unsafe {
                CloseClipboard();
            }
        }
    }
    // CF_HDROP is owned by the clipboard. Query while open; do not free its handle.
    unsafe {
        if IsClipboardFormatAvailable(15) == 0 {
            return Ok(Vec::new());
        }
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return Err("剪贴板正被占用，请重试粘贴".into());
        }
        let _guard = Clipboard;
        let handle = GetClipboardData(15);
        if handle.is_null() {
            return Err("无法读取剪贴板文件".into());
        }
        let count = DragQueryFileW(handle, u32::MAX, std::ptr::null_mut(), 0);
        if count > 32 {
            return Err("单次最多粘贴 32 个文件或文件夹".into());
        }
        let mut paths = Vec::new();
        for index in 0..count {
            let size = DragQueryFileW(handle, index, std::ptr::null_mut(), 0);
            if size == 0 || size > 32768 {
                return Err("剪贴板文件路径无效".into());
            }
            let mut buffer = vec![0u16; size as usize + 1];
            let read = DragQueryFileW(handle, index, buffer.as_mut_ptr(), buffer.len() as u32);
            if read != size {
                return Err("剪贴板文件路径读取不完整".into());
            }
            let path =
                String::from_utf16(&buffer[..read as usize]).map_err(|_| "剪贴板文件路径无效")?;
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
        Ok(paths)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_paths() -> Result<Vec<String>, String> {
    Ok(Vec::new())
}
