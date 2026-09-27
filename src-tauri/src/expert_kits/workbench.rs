use super::*;
use pulldown_cmark::{Event, HeadingLevel, Parser, Tag, TagEnd};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionDocument {
    id: String,
    name: String,
    summary: String,
    argument_hint: String,
    user_invocable: bool,
    path: String,
    content: String,
}

#[derive(Serialize)]
pub struct ExtensionContents {
    readme: String,
    skills: Vec<ExtensionDocument>,
    commands: Vec<ExtensionDocument>,
}

fn installed_directory(
    app: &tauri::AppHandle,
    kind: &str,
    id: &str,
    version: &str,
) -> Result<PathBuf, String> {
    validate_artifact_kind(kind)?;
    validate_identifier(id)?;
    Version::parse(version).map_err(|error| format!("扩展版本无效：{error}"))?;
    let directory = extensions_root(app)?.join(kind).join(id).join(version);
    load_and_validate_manifest(&directory, Some(kind), Some(id), Some(version))?;
    Ok(directory)
}

#[tauri::command]
pub async fn set_extension_enabled(
    app: tauri::AppHandle,
    kind: String,
    id: String,
    version: String,
    enabled: bool,
) -> Result<(), String> {
    crate::dingtalk_auth::current_employee(&app).await?;
    let directory = installed_directory(&app, &kind, &id, &version)?;
    set_enabled_marker(directory.parent().ok_or("扩展目录无效")?, enabled)
}

fn set_enabled_marker(parent: &Path, enabled: bool) -> Result<(), String> {
    let marker = parent.join(".disabled");
    if enabled {
        match fs::remove_file(marker) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("无法启用扩展：{error}")),
        }
    } else {
        fs::write(marker, b"disabled").map_err(|error| format!("无法停用扩展：{error}"))
    }
}

#[tauri::command]
pub async fn read_extension_contents(
    app: tauri::AppHandle,
    kind: String,
    id: String,
    version: String,
) -> Result<ExtensionContents, String> {
    crate::dingtalk_auth::current_employee(&app).await?;
    let directory = installed_directory(&app, &kind, &id, &version)?;
    let manifest = load_and_validate_manifest(&directory, Some(&kind), Some(&id), Some(&version))?;
    let read = |references: &[FileReference]| -> Result<Vec<ExtensionDocument>, String> {
        references
            .iter()
            .map(|entry| {
                validate_relative_path(Path::new(&entry.path))?;
                let path = directory.join(&entry.path);
                let content = fs::read_to_string(path)
                    .map_err(|error| format!("无法读取 {}：{error}", entry.path))?;
                Ok(ExtensionDocument {
                    id: entry.id.clone(),
                    name: document_name(&content, &entry.id),
                    summary: summary(&content),
                    argument_hint: metadata(&content, "argument-hint").unwrap_or_default(),
                    user_invocable: metadata(&content, "user-invocable")
                        .is_none_or(|value| value.trim() != "false"),
                    path: entry.path.clone(),
                    content,
                })
            })
            .collect()
    };
    let readme = ["README.md", "readme.md"]
        .iter()
        .find_map(|name| fs::read_to_string(directory.join(name)).ok())
        .unwrap_or_default();
    Ok(ExtensionContents {
        readme,
        skills: read(&manifest.skills)?,
        commands: read(&manifest.commands)?,
    })
}

/// A description doubles as the trigger text the model matches on, so a long one contributes only
/// its opening sentence to the summary shown beside the skill.
pub(super) fn summary(content: &str) -> String {
    let description = metadata(content, "description").unwrap_or_default();
    let text = description.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= 300 {
        return text;
    }
    let sentence = text
        .char_indices()
        .find(|(_, character)| matches!(character, '。' | '．' | '.' | '!' | '?' | '！' | '？'))
        .map(|(index, character)| text[..index + character.len_utf8()].to_owned())
        .filter(|value| value.chars().count() <= 300);
    sentence.unwrap_or_else(|| format!("{}…", text.chars().take(299).collect::<String>()))
}

pub(super) fn document_name(content: &str, fallback: &str) -> String {
    let field = |key| {
        metadata(content, key)
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    };
    let name = field("name");
    field("displayName")
        .or_else(|| {
            name.clone().filter(|value| {
                !value
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
            })
        })
        .or_else(|| document_heading(content))
        .or(name)
        .unwrap_or_else(|| fallback.to_owned())
}

pub(super) fn metadata(content: &str, key: &str) -> Option<String> {
    let mut lines = content.trim_start_matches('\u{feff}').lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    let lines: Vec<_> = lines.take_while(|line| line.trim() != "---").collect();
    for (index, line) in lines.iter().enumerate() {
        if let Some(value) = line.strip_prefix(&format!("{key}:")) {
            let value = value.trim();
            if value.starts_with(['>', '|']) {
                return Some(
                    lines[index + 1..]
                        .iter()
                        .take_while(|line| line.starts_with(' ') || line.is_empty())
                        .map(|line| line.trim())
                        .collect::<Vec<_>>()
                        .join(" "),
                );
            }
            return Some(
                serde_json::from_str::<String>(value)
                    .unwrap_or_else(|_| value.trim_matches('\'').to_owned()),
            );
        }
    }
    None
}

fn document_heading(content: &str) -> Option<String> {
    let content = content.trim_start_matches('\u{feff}');
    let mut lines = content.split_inclusive('\n');
    let first = lines.next()?;
    let body = if first.trim() == "---" {
        let mut offset = first.len();
        for line in lines {
            offset += line.len();
            if line.trim() == "---" {
                break;
            }
        }
        content.get(offset..).unwrap_or_default()
    } else {
        content
    };
    let mut title = String::new();
    let mut heading = false;
    for event in Parser::new(body) {
        match event {
            Event::Start(Tag::Heading {
                level: HeadingLevel::H1,
                ..
            }) => heading = true,
            Event::End(TagEnd::Heading(HeadingLevel::H1)) if heading => {
                if !title.trim().is_empty() {
                    return Some(title.trim().to_owned());
                }
                heading = false;
            }
            Event::Text(text) | Event::Code(text) if heading => title.push_str(&text),
            Event::SoftBreak | Event::HardBreak if heading => title.push(' '),
            _ => {}
        }
    }
    None
}

#[tauri::command]
pub async fn reveal_extension_directory(
    app: tauri::AppHandle,
    kind: String,
    id: String,
    version: String,
) -> Result<(), String> {
    crate::dingtalk_auth::current_employee(&app).await?;
    let directory = installed_directory(&app, &kind, &id, &version)?;
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = std::process::Command::new("explorer.exe");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = std::process::Command::new("xdg-open");
    let status = command
        .arg(directory)
        .status()
        .map_err(|error| format!("无法打开扩展文件夹：{error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("系统未能打开扩展文件夹".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn document_names_keep_human_labels_separate_from_execution_ids() {
        assert_eq!(
            document_name("---\nname: 问题定义\n---\n# 正文", "ext-123"),
            "问题定义"
        );
        assert_eq!(
            document_name("---\nname: frame\ndisplayName: 问题定义\n---", "frame"),
            "问题定义"
        );
        assert_eq!(document_name("# 市场分析\n内容", "ext-123"), "市场分析");
        assert_eq!(document_name("内容", "frame"), "frame");
        assert_eq!(
            document_name("---\nname: api-design\n---\n# API接口设计", "api-design"),
            "API接口设计"
        );
        assert_eq!(
            document_name(
                "---\r\nname: review\r\ndisplayName: ''\r\n---\r\n# **代码**审查",
                "review"
            ),
            "代码审查"
        );
        assert_eq!(
            document_name("```md\n# 假标题\n```\n# 真标题", "id"),
            "真标题"
        );
        assert_eq!(document_name("接口设计\n===\n", "id"), "接口设计");
        assert_eq!(
            document_name("---\nname: api-design\n---\n正文", "id"),
            "api-design"
        );
    }

    #[test]
    fn activation_is_version_independent_and_reversible() {
        let parent = std::env::temp_dir().join(format!(
            "xiaoyin-activation-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(parent.join("1.0.0")).unwrap();
        set_enabled_marker(&parent, false).unwrap();
        fs::create_dir_all(parent.join("2.0.0")).unwrap();
        assert!(parent.join(".disabled").exists());
        set_enabled_marker(&parent, true).unwrap();
        set_enabled_marker(&parent, true).unwrap();
        assert!(!parent.join(".disabled").exists());
        fs::remove_dir_all(parent).unwrap();
    }
}
