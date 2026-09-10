use super::*;
use serde_json::{Value, json};

const QODER_MANIFEST_PATH: &str = ".qoder-plugin/plugin.json";

pub(super) fn has_import_entry(root: &Path) -> bool {
    root.join("SKILL.md").is_file() || root.join(QODER_MANIFEST_PATH).is_file()
}

pub(super) fn import(root: &Path, expected_kind: Option<&str>) -> Result<(), String> {
    if root.join(KIT_MANIFEST_PATH).is_file() || root.join(SKILL_MANIFEST_PATH).is_file() {
        return Ok(());
    }
    if root.join(QODER_MANIFEST_PATH).is_file() {
        import_kit(root, expected_kind)
    } else if root.join("SKILL.md").is_file() {
        import_skill(root, expected_kind)
    } else {
        Err("未找到 SKILL.md 或 .qoder-plugin/plugin.json".into())
    }
}

fn import_kit(root: &Path, expected_kind: Option<&str>) -> Result<(), String> {
    if expected_kind == Some("skill") {
        return Err("这是专家套件，请从专家套件入口导入".into());
    }
    let plugin = native_connectors::read_json(&root.join(QODER_MANIFEST_PATH))?;
    reject_unsupported_features(root, &plugin)?;
    let source_name = required_string(&plugin, "name", "plugin.json 必须包含 name")?;
    let id = native_connectors::portable_id(source_name);
    let name = optional_string(&plugin, "displayName")
        .or_else(|| optional_string(&plugin, "nameZh"))
        .unwrap_or(source_name);
    let summary = optional_string(&plugin, "descriptionZh")
        .or_else(|| optional_string(&plugin, "description"))
        .unwrap_or(name);
    let author = plugin.get("author").and_then(|value| {
        value
            .as_str()
            .or_else(|| value.get("name").and_then(Value::as_str))
    });
    let version = optional_string(&plugin, "version").unwrap_or("1.0.0");
    Version::parse(version).map_err(|error| format!("套件版本无效：{error}"))?;

    let mut skills = Vec::new();
    for path in paths(&plugin, "skills", "skills")? {
        if plugin.get("skills").is_some() && !root.join(&path).exists() {
            return Err(format!("skills 引用不存在：{path}"));
        }
        collect_skills(root, &root.join(path), &mut skills, 0)?;
    }
    let mut commands = Vec::new();
    for path in paths(&plugin, "commands", "commands")? {
        if plugin.get("commands").is_some() && !root.join(&path).exists() {
            return Err(format!("commands 引用不存在：{path}"));
        }
        collect_commands(root, &root.join(path), &mut commands, 0)?;
    }
    ensure_unique_ids(&skills, "技能")?;
    ensure_unique_ids(&commands, "命令")?;
    for command in &commands {
        rewrite_qoder_root(root, &command.path)?;
    }
    if skills.is_empty() {
        let path = "skills/main/SKILL.md";
        write_file(
            root,
            path,
            format!(
                "---\nname: main\ndescription: {}\n---\n\n# {name}\n\n{summary}\n",
                serde_json::to_string(summary).unwrap()
            )
            .as_bytes(),
        )?;
        skills.push(FileReference {
            id: "main".into(),
            path: path.into(),
            skill_id: None,
        });
    }
    let connector_refs = convert_connectors(root, &plugin)?;
    let mut manifest = json!({
        "schemaVersion": "2",
        "id": id,
        "name": name,
        "version": version,
        "summary": summary,
        "category": category(&plugin),
        "minimumDesktopVersion": "0.1.30",
        "commands": commands,
        "skills": skills,
        "requiredTools": [],
        "connectorRefs": connector_refs
    });
    if let Some(author) = author.filter(|value| !value.trim().is_empty()) {
        manifest["author"] = json!(author.trim());
    }
    native_connectors::write_json(root, KIT_MANIFEST_PATH, &manifest)?;
    remove_qoder_metadata(root)?;
    Ok(())
}

fn import_skill(root: &Path, expected_kind: Option<&str>) -> Result<(), String> {
    if expected_kind == Some("expert-kit") {
        return Err("这是独立技能，请从技能入口导入".into());
    }
    let content = fs::read_to_string(root.join("SKILL.md")).map_err(|error| error.to_string())?;
    let fallback = format!("skill-{:x}", Sha256::digest(content.as_bytes()));
    let source_name = workbench::metadata(&content, "name").unwrap_or_else(|| {
        content
            .lines()
            .find_map(|line| line.strip_prefix("# ").map(str::to_owned))
            .unwrap_or_else(|| fallback[..22].into())
    });
    let name = workbench::document_name(&content, &source_name);
    let summary = workbench::metadata(&content, "description").unwrap_or_else(|| name.clone());
    let trigger = if (2..=120).contains(&summary.chars().count()) {
        summary.clone()
    } else if name.chars().count() <= 116 {
        format!("使用{name}")
    } else {
        "使用此技能".to_string()
    };
    let mut manifest = json!({
        "schemaVersion": "1",
        "id": native_connectors::portable_id(&source_name),
        "name": name,
        "version": "1.0.0",
        "summary": summary,
        "category": "other",
        "triggers": [trigger],
        "minimumDesktopVersion": "0.1.30",
        "requiredTools": [],
        "connectorRefs": []
    });
    if let Some(author) =
        workbench::metadata(&content, "author").filter(|value| !value.trim().is_empty())
    {
        manifest["author"] = json!(author.trim());
    }
    native_connectors::write_json(root, SKILL_MANIFEST_PATH, &manifest)
}

/// Qoder's own taxonomy, plus the ids Xiaoyin already uses so a native value passes through.
/// Anything unknown or missing stays "other" — the employee can set it after import.
const QODER_CATEGORIES: [(&str, &str); 22] = [
    ("engineering", "code-development"),
    ("development", "code-development"),
    ("coding", "code-development"),
    ("review", "code-review"),
    ("security", "security-testing"),
    ("testing", "security-testing"),
    ("data", "database-analysis"),
    ("database", "database-analysis"),
    ("analytics", "database-analysis"),
    ("devops", "operations-deployment"),
    ("operations", "operations-deployment"),
    ("tools", "developer-tools"),
    ("productivity", "office-productivity"),
    ("office", "office-productivity"),
    ("writing", "content-creation"),
    ("content", "content-creation"),
    ("commerce", "ecommerce-retail"),
    ("ecommerce", "ecommerce-retail"),
    ("retail", "ecommerce-retail"),
    ("hr", "recruiting"),
    ("product", "product-management"),
    ("research", "knowledge-research"),
];

fn category(plugin: &Value) -> &'static str {
    let Some(value) = optional_string(plugin, "category") else {
        return "other";
    };
    let value = value.to_ascii_lowercase();
    if let Some(native) = EXTENSION_CATEGORIES
        .iter()
        .find(|category| **category == value)
    {
        return native;
    }
    QODER_CATEGORIES
        .iter()
        .find(|(source, _)| *source == value)
        .map_or("other", |(_, target)| *target)
}

fn reject_unsupported_features(root: &Path, plugin: &Value) -> Result<(), String> {
    for feature in ["hooks", "agents", "lspServers"] {
        if plugin.get(feature).is_some_and(|value| !value.is_null()) || root.join(feature).exists()
        {
            return Err(format!("该 Qoder 套件包含尚不支持的 {feature}"));
        }
    }
    Ok(())
}

fn required_string<'a>(value: &'a Value, key: &str, message: &str) -> Result<&'a str, String> {
    optional_string(value, key).ok_or_else(|| message.to_owned())
}

fn optional_string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn paths(plugin: &Value, field: &str, default: &str) -> Result<Vec<String>, String> {
    let values = match plugin.get(field) {
        None => vec![Value::String(default.into())],
        Some(Value::String(value)) => vec![Value::String(value.clone())],
        Some(Value::Array(values)) => values.clone(),
        _ => return Err(format!("{field} 只支持相对路径或路径数组")),
    };
    values
        .into_iter()
        .map(|value| {
            let path = value
                .as_str()
                .ok_or_else(|| format!("{field} 路径必须是字符串"))?;
            let path = path.strip_prefix("./").unwrap_or(path);
            validate_relative_path(Path::new(path))?;
            Ok(path.to_owned())
        })
        .collect()
}

fn collect_skills(
    root: &Path,
    directory: &Path,
    result: &mut Vec<FileReference>,
    depth: usize,
) -> Result<(), String> {
    if !directory.exists() {
        return Ok(());
    }
    if depth > 8 {
        return Err("技能目录层级过深".into());
    }
    if directory.join("SKILL.md").is_file() {
        let content =
            fs::read_to_string(directory.join("SKILL.md")).map_err(|error| error.to_string())?;
        let folder = directory
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let name = workbench::metadata(&content, "name").unwrap_or_else(|| folder.clone());
        // A display name is often Chinese and would hash into an unreadable id, while the folder
        // beside it is usually the identifier the package's own cross-references already use.
        let id = usable_identifier(&name)
            .or_else(|| usable_identifier(&folder))
            .unwrap_or_else(|| native_connectors::portable_id(&name));
        result.push(FileReference {
            id,
            path: relative(root, &directory.join("SKILL.md"))?,
            skill_id: None,
        });
    } else if directory.is_dir() {
        for child in child_directories(directory)? {
            collect_skills(root, &child, result, depth + 1)?;
        }
    } else {
        return Err("skills 路径必须指向包含 SKILL.md 的目录".into());
    }
    Ok(())
}

fn usable_identifier(value: &str) -> Option<String> {
    // Skill and command entries answer to the file-reference rule, which is looser than a kit id.
    manifest::valid_file_reference_id(value).then(|| value.to_owned())
}

fn collect_commands(
    root: &Path,
    path: &Path,
    result: &mut Vec<FileReference>,
    depth: usize,
) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    if depth > 8 {
        return Err("命令目录层级过深".into());
    }
    if path.is_dir() {
        for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
            collect_commands(
                root,
                &entry.map_err(|error| error.to_string())?.path(),
                result,
                depth + 1,
            )?;
        }
    } else if path.extension().is_some_and(|value| value == "md") {
        result.push(FileReference {
            id: native_connectors::portable_id(
                &path.file_stem().unwrap_or_default().to_string_lossy(),
            ),
            path: relative(root, path)?,
            skill_id: None,
        });
    }
    Ok(())
}

fn ensure_unique_ids(references: &[FileReference], label: &str) -> Result<(), String> {
    let mut seen = HashSet::new();
    for reference in references {
        if !seen.insert(&reference.id) {
            return Err(format!("重复的{label}名称：{}", reference.id));
        }
    }
    Ok(())
}

fn relative(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .map_err(|error| error.to_string())
}

fn connector_config(root: &Path, plugin: &Value) -> Result<Value, String> {
    match plugin.get("mcpServers") {
        Some(Value::String(path)) => {
            let path = path.strip_prefix("./").unwrap_or(path);
            validate_relative_path(Path::new(path))?;
            native_connectors::read_json(&root.join(path))
        }
        Some(value) if value.is_object() => Ok(value.clone()),
        Some(_) => Err("mcpServers 只支持对象或配置文件路径".into()),
        None if root.join(".mcp.json").is_file() => {
            native_connectors::read_json(&root.join(".mcp.json"))
        }
        None => Ok(Value::Null),
    }
}

/// Bundled connectors are the desktop's own connectors: the MCP server name is the shared id, so a
/// server another kit already installed and authorized is reused instead of duplicated per kit.
fn convert_connectors(root: &Path, plugin: &Value) -> Result<Vec<String>, String> {
    let config = connector_config(root, plugin)?;
    if config.is_null() {
        return Ok(Vec::new());
    }
    let servers = config
        .get("mcpServers")
        .unwrap_or(&config)
        .as_object()
        .ok_or("MCP 配置必须是对象")?;
    let mut converted = serde_json::Map::new();
    let mut ids = Vec::new();
    for (name, config) in servers {
        let id = native_connectors::portable_id(name);
        let mut server = config.as_object().ok_or("MCP 服务配置必须是对象")?.clone();
        if server.contains_key("oauth") {
            return Err("该套件的 OAuth 连接器需要单独接入".into());
        }
        if server.get("oauthBaseUrl").and_then(Value::as_str).is_some()
            && !server.contains_key("authMode")
        {
            server.insert("authMode".into(), json!("oauth"));
        }
        // Qoder writes MCP's own `type`; the kit contract names the field `transport` and uses
        // the transport ids the connector runtime understands.
        if let Some(transport) = server
            .remove("type")
            .as_ref()
            .and_then(Value::as_str)
            .map(|value| {
                if value == "http" {
                    "streamable-http"
                } else {
                    value
                }
            })
            .map(str::to_owned)
            && !server.contains_key("transport")
        {
            server.insert("transport".into(), json!(transport));
        }
        let mut server = Value::Object({
            server.insert("id".into(), json!(id));
            server.insert("name".into(), json!(name));
            server
        });
        native_connectors::replace_root_variable(
            &mut server,
            "${QODER_PLUGIN_ROOT}",
            native_connectors::EXTENSION_ROOT_VARIABLE,
        );
        converted.insert(id.clone(), server);
        ids.push(id);
    }
    native_connectors::write_json(
        root,
        native_connectors::CONNECTORS_PATH,
        &json!({"mcpServers": converted}),
    )?;
    Ok(ids)
}

fn remove_qoder_metadata(root: &Path) -> Result<(), String> {
    for directory in [".qoder-plugin", ".claude-plugin", ".qwen-plugin"] {
        let path = root.join(directory);
        if path.exists() {
            fs::remove_dir_all(path).map_err(|error| format!("无法清理外部平台清单：{error}"))?;
        }
    }
    match fs::remove_file(root.join(".mcp.json")) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法清理 Qoder 连接器清单：{error}")),
    }
}

fn rewrite_qoder_root(root: &Path, relative: &str) -> Result<(), String> {
    let path = root.join(relative);
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("无法读取 Qoder 命令 {relative}：{error}"))?;
    let converted = content.replace(
        "${QODER_PLUGIN_ROOT}",
        native_connectors::EXTENSION_ROOT_VARIABLE,
    );
    if converted != content {
        fs::write(path, converted)
            .map_err(|error| format!("无法转换 Qoder 命令 {relative}：{error}"))?;
    }
    Ok(())
}

fn write_file(root: &Path, relative: &str, bytes: &[u8]) -> Result<(), String> {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().ok_or("文件路径无效")?).map_err(|error| error.to_string())?;
    fs::write(path, bytes).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    static NEXT_FIXTURE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "xiaoyin-qoder-import-{}-{}",
                std::process::id(),
                NEXT_FIXTURE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }

        fn write(&self, relative: &str, content: &str) {
            write_file(&self.0, relative, content.as_bytes()).unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn converts_qoder_kit_to_native_contract_once() {
        let root = Fixture::new();
        root.write(
            QODER_MANIFEST_PATH,
            r#"{"name":"product-design","displayName":"产品设计","descriptionZh":"完成产品设计","version":"1.2.3","author":{"name":"InStudio"},"commands":["commands"],"skills":["skills"]}"#,
        );
        root.write(
            "skills/research/SKILL.md",
            "---\nname: research\n---\n# 用户研究",
        );
        root.write(
            "commands/start.md",
            "读取 ${QODER_PLUGIN_ROOT}/templates/input.md\n\n$ARGUMENTS",
        );
        root.write(".mcp.json", r#"{"mcpServers":{"design":{"command":"node","args":["${QODER_PLUGIN_ROOT}/server.js"]},"buyer":{"type":"streamable-http","url":"https://mcp.example.com","oauthBaseUrl":"https://auth.example.com"}}}"#);

        import(&root.0, Some("expert-kit")).unwrap();

        let manifest = native_connectors::read_json(&root.0.join(KIT_MANIFEST_PATH)).unwrap();
        assert_eq!(manifest["name"], "产品设计");
        assert_eq!(manifest["author"], "InStudio");
        assert!(!root.0.join(".qoder-plugin").exists());
        assert!(!root.0.join(".mcp.json").exists());
        assert!(
            fs::read_to_string(root.0.join("commands/start.md"))
                .unwrap()
                .contains(native_connectors::EXTENSION_ROOT_VARIABLE)
        );
        let connectors =
            fs::read_to_string(root.0.join(native_connectors::CONNECTORS_PATH)).unwrap();
        assert!(connectors.contains(native_connectors::EXTENSION_ROOT_VARIABLE));
        assert!(!connectors.contains("QODER_PLUGIN_ROOT"));
        let connectors: Value = serde_json::from_str(&connectors).unwrap();
        assert_eq!(connectors["mcpServers"]["buyer"]["authMode"], "oauth");
        assert_eq!(
            connectors["mcpServers"]["buyer"]["transport"],
            "streamable-http"
        );
        assert!(connectors["mcpServers"]["buyer"]["type"].is_null());
    }

    #[test]
    fn keeps_the_folder_identifier_behind_a_chinese_skill_name() {
        let root = Fixture::new();
        root.write(
            QODER_MANIFEST_PATH,
            r#"{"name":"product-design","displayName":"产品设计","category":"engineering","skills":["./skills/qa","./skills/prd","./skills/写PRD"]}"#,
        );
        root.write(
            "skills/qa/SKILL.md",
            "---\nname: 设计验收\ndescription: 对比设计与实现\n---\n# 设计验收",
        );
        root.write(
            "skills/prd/SKILL.md",
            "---\nname: 写PRD\ndescription: 输出需求文档\n---\n# 写PRD",
        );
        root.write(
            "skills/写PRD/SKILL.md",
            "---\nname: 出方案\ndescription: 输出设计方案\n---\n# 出方案",
        );

        import(&root.0, Some("expert-kit")).unwrap();

        let manifest = native_connectors::read_json(&root.0.join(KIT_MANIFEST_PATH)).unwrap();
        // The readable folder wins over a hash of the display name; a Chinese folder still hashes.
        // A two-letter folder is a valid skill reference even though it is too short for a kit id.
        assert_eq!(manifest["skills"][0]["id"], "qa");
        assert_eq!(manifest["skills"][1]["id"], "prd");
        assert!(
            manifest["skills"][2]["id"]
                .as_str()
                .unwrap()
                .starts_with("ext-")
        );
        assert_eq!(manifest["category"], "code-development");
    }

    #[test]
    fn two_kits_declaring_the_same_server_share_one_connector() {
        let ids = ["writer-kit", "planner-kit"].map(|kit| {
            let root = Fixture::new();
            root.write(
                QODER_MANIFEST_PATH,
                &format!(r#"{{"name":"{kit}","displayName":"套件","skills":["./skills/main"]}}"#),
            );
            root.write("skills/main/SKILL.md", "---\nname: main\n---\n# 主技能");
            root.write(
                ".mcp.json",
                r#"{"mcpServers":{"notion":{"type":"http","url":"https://mcp.notion.com/mcp"}}}"#,
            );

            import(&root.0, Some("expert-kit")).unwrap();

            let manifest = native_connectors::read_json(&root.0.join(KIT_MANIFEST_PATH)).unwrap();
            let connectors =
                native_connectors::read_json(&root.0.join(native_connectors::CONNECTORS_PATH))
                    .unwrap();
            assert!(connectors["mcpServers"]["notion"]["url"].is_string());
            manifest["connectorRefs"].clone()
        });
        // The id names the shared desktop connector, so the second kit reuses whatever the
        // employee already configured instead of asking for its own copy.
        assert_eq!(ids[0], json!(["notion"]));
        assert_eq!(ids[0], ids[1]);
    }

    #[test]
    fn unknown_and_missing_categories_stay_in_other() {
        assert_eq!(category(&json!({"category": "design"})), "design");
        assert_eq!(
            category(&json!({"category": "ENGINEERING"})),
            "code-development"
        );
        assert_eq!(category(&json!({"category": "spaceflight"})), "other");
        assert_eq!(category(&json!({})), "other");
    }

    #[test]
    fn creates_required_trigger_for_root_skill() {
        let root = Fixture::new();
        root.write(
            "SKILL.md",
            "---\nname: order-review\ndescription: 检查订单风险\n---\n# 订单检查",
        );

        import(&root.0, Some("skill")).unwrap();

        let manifest = native_connectors::read_json(&root.0.join(SKILL_MANIFEST_PATH)).unwrap();
        assert_eq!(manifest["triggers"], json!(["检查订单风险"]));
    }
}
