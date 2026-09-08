use super::*;
use serde_json::{Value, json};

pub(super) const CONNECTORS_PATH: &str = ".xiaoyin-kit/connectors.json";
const PLUGIN_PATHS: [&str; 3] = [
    ".qoder-plugin/plugin.json",
    ".claude-plugin/plugin.json",
    ".qwen-plugin/plugin.json",
];

pub(super) fn has_portable_entry(root: &Path) -> bool {
    root.join("SKILL.md").is_file() || PLUGIN_PATHS.iter().any(|path| root.join(path).is_file())
}

/// Convert only local imports. Catalog artifacts keep their original manifest contract.
pub(super) fn normalize_package(root: &Path, kind: Option<&str>) -> Result<(), String> {
    if root.join(KIT_MANIFEST_PATH).is_file() || root.join(SKILL_MANIFEST_PATH).is_file() {
        return Ok(());
    }
    if let Some(plugin) = portable_plugin(root)? {
        if kind == Some("skill") {
            return Err("这是专家套件，请从专家套件入口导入".into());
        }
        let name = plugin
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.trim().is_empty())
            .ok_or("plugin.json 必须包含 name")?;
        let id = portable_id(name);
        let display_name = plugin_display_name(&plugin).unwrap_or(name);
        let summary = plugin
            .get("descriptionZh")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .or_else(|| plugin.get("description").and_then(Value::as_str))
            .unwrap_or(name);
        let version = plugin
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or("1.0.0");
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
        let mut seen = HashSet::new();
        for skill in &skills {
            if !seen.insert(skill.id.clone()) {
                return Err(format!("重复的技能名称：{}", skill.id));
            }
        }
        seen.clear();
        for command in &commands {
            if !seen.insert(command.id.clone()) {
                return Err(format!("重复的命令名称：{}", command.id));
            }
        }
        if skills.is_empty() {
            let path = "skills/main/SKILL.md";
            write_file(root, path, format!("---\nname: main\ndescription: {}\n---\n\n# {name}\n\n{summary}\n\n按用户选择的套件命令执行，结合可用连接器完成任务。", serde_json::to_string(summary).unwrap()).as_bytes())?;
            skills.push(FileReference {
                id: "main".into(),
                path: path.into(),
            });
        }
        let connector_refs = convert_connectors(root, &plugin, &id)?;
        let manifest = json!({"schemaVersion":"2", "id":id, "name":display_name, "version":version,
            "summary":summary, "minimumDesktopVersion":"0.1.30", "category":"other",
            "skills":skills, "commands":commands, "connectorRefs":connector_refs});
        write_file(
            root,
            KIT_MANIFEST_PATH,
            &serde_json::to_vec_pretty(&manifest).unwrap(),
        )?;
    } else if root.join("SKILL.md").is_file() {
        if kind == Some("expert-kit") {
            return Err("这是独立技能，请从技能入口导入".into());
        }
        let content =
            fs::read_to_string(root.join("SKILL.md")).map_err(|error| error.to_string())?;
        let fallback = format!("skill-{:x}", Sha256::digest(content.as_bytes()));
        let name = metadata(&content, "name").unwrap_or_else(|| {
            content
                .lines()
                .find_map(|line| line.strip_prefix("# ").map(str::to_owned))
                .unwrap_or(fallback[..22].into())
        });
        let display_name = workbench::document_name(&content, &name);
        let summary = metadata(&content, "description").unwrap_or_else(|| display_name.clone());
        let manifest = json!({"schemaVersion":"1", "id":portable_id(&name), "name":display_name,
            "version":"1.0.0", "summary":summary, "minimumDesktopVersion":"0.1.30", "category":"other"});
        write_file(
            root,
            SKILL_MANIFEST_PATH,
            &serde_json::to_vec_pretty(&manifest).unwrap(),
        )?;
    } else {
        return Err("未找到 SKILL.md 或支持的套件清单".into());
    }
    Ok(())
}

fn plugin_display_name(plugin: &Value) -> Option<&str> {
    plugin
        .get("displayName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
}

// Platform metadata may differ; executable content must describe the same package.
fn portable_plugin(root: &Path) -> Result<Option<Value>, String> {
    let plugins = PLUGIN_PATHS
        .iter()
        .filter(|path| root.join(path).is_file())
        .map(|path| read_json(&root.join(path)))
        .collect::<Result<Vec<_>, _>>()?;
    let Some(selected) = plugins.first() else {
        return Ok(None);
    };
    let signature = |plugin: &Value| -> Result<Value, String> {
        for feature in ["hooks", "agents", "lspServers"] {
            if plugin.get(feature).is_some_and(|value| !value.is_null())
                || root.join(feature).exists()
            {
                return Err(format!(
                    "该套件包含尚不支持转换的 {feature}，未安装任何内容"
                ));
            }
        }
        let normalized_paths = |field| -> Result<Vec<String>, String> {
            let mut values = paths(plugin, field, field)?;
            values.sort();
            values.dedup();
            Ok(values)
        };
        Ok(
            json!({"name":plugin.get("name"), "version":plugin.get("version").unwrap_or(&json!("1.0.0")),
            "skills":normalized_paths("skills")?, "commands":normalized_paths("commands")?,
            "mcpServers":connector_config(root, plugin)?}),
        )
    };
    let expected = signature(selected)?;
    for plugin in plugins.iter().skip(1) {
        if signature(plugin)? != expected {
            return Err("多个平台清单的名称、版本或执行内容不一致，请明确套件入口后导入".into());
        }
    }
    Ok(Some(selected.clone()))
}

pub(super) fn apply_presentation(root: &Path, manifest: &mut ExpertKitManifest) {
    if manifest.kind == "skill" {
        if let Ok(content) = fs::read_to_string(root.join("SKILL.md"))
            && (manifest.name == manifest.id
                || metadata(&content, "name").as_ref() == Some(&manifest.name))
        {
            manifest.name = workbench::document_name(&content, &manifest.name);
        }
        return;
    }
    let Some(plugin) = portable_plugin(root).ok().flatten() else {
        return;
    };
    if plugin
        .get("name")
        .and_then(Value::as_str)
        .map(portable_id)
        .as_ref()
        != Some(&manifest.id)
        || plugin
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or("1.0.0")
            != manifest.version
    {
        return;
    }
    if manifest.name == manifest.id
        && let Some(name) = plugin_display_name(&plugin)
    {
        manifest.name = name.to_owned();
    }
    if plugin.get("description").and_then(Value::as_str) == Some(manifest.summary.as_str())
        && let Some(summary) = plugin
            .get("descriptionZh")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
    {
        manifest.summary = summary.to_owned();
    }
}

fn read_json(path: &Path) -> Result<Value, String> {
    let value: Value =
        serde_json::from_slice(&fs::read(path).map_err(|error| format!("读取配置失败：{error}"))?)
            .map_err(|error| format!("JSON 配置无效：{error}"))?;
    if !value.is_object() {
        return Err("配置必须是 JSON 对象".into());
    }
    Ok(value)
}

fn paths(plugin: &Value, field: &str, default: &str) -> Result<Vec<String>, String> {
    let values = match plugin.get(field) {
        None => vec![Value::String(default.into())],
        Some(Value::String(value)) => vec![Value::String(value.clone())],
        Some(Value::Array(values)) => values.clone(),
        _ => return Err(format!("{field} 只支持相对路径或路径数组")),
    };
    values
        .iter()
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
        let name = metadata(&content, "name").unwrap_or_else(|| {
            directory
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        });
        result.push(FileReference {
            id: portable_id(&name),
            path: relative(root, &directory.join("SKILL.md"))?,
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
            id: portable_id(&path.file_stem().unwrap_or_default().to_string_lossy()),
            path: relative(root, path)?,
        });
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
            read_json(&root.join(path))
        }
        Some(value) if value.is_object() => Ok(value.clone()),
        Some(_) => Err("mcpServers 只支持对象或配置文件路径".into()),
        None if root.join(".mcp.json").is_file() => read_json(&root.join(".mcp.json")),
        None => Ok(Value::Null),
    }
}

fn convert_connectors(root: &Path, plugin: &Value, kit_id: &str) -> Result<Vec<String>, String> {
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
        let id = portable_id(&format!("{kit_id}-{name}"));
        let mut server = config.as_object().ok_or("MCP 服务配置必须是对象")?.clone();
        if server.contains_key("oauth") {
            return Err("该套件的 OAuth 连接器需要单独接入，暂不支持直接转换".into());
        }
        server.insert("id".into(), json!(id));
        server.insert("name".into(), json!(name));
        converted.insert(id.clone(), Value::Object(server));
        ids.push(id);
    }
    write_file(
        root,
        CONNECTORS_PATH,
        &serde_json::to_vec_pretty(&json!({"mcpServers":converted})).unwrap(),
    )?;
    Ok(ids)
}

pub(super) fn bundled_connectors(directory: &Path) -> Option<Value> {
    let mut config = read_json(&directory.join(CONNECTORS_PATH)).ok()?;
    fn expand(value: &mut Value, root: &str) {
        match value {
            Value::String(text) => {
                *text = text
                    .replace("${CLAUDE_PLUGIN_ROOT}", root)
                    .replace("${QWEN_PLUGIN_ROOT}", root)
                    .replace("${QODER_PLUGIN_ROOT}", root)
            }
            Value::Array(values) => values.iter_mut().for_each(|value| expand(value, root)),
            Value::Object(values) => values.values_mut().for_each(|value| expand(value, root)),
            _ => {}
        }
    }
    expand(&mut config, &directory.to_string_lossy());
    Some(config)
}

pub(super) fn rekey_bundled_connectors(
    root: &Path,
    manifest: &mut Value,
    new_id: &str,
) -> Result<(), String> {
    if !root.join(CONNECTORS_PATH).is_file() {
        return Ok(());
    }
    let config = read_json(&root.join(CONNECTORS_PATH))?;
    let servers = config["mcpServers"]
        .as_object()
        .ok_or("套件 MCP 配置无效")?;
    let mut converted = serde_json::Map::new();
    let mut mapping = std::collections::HashMap::new();
    for (old_id, server) in servers {
        let id = portable_id(&format!("{new_id}-{old_id}"));
        let mut server = server.clone();
        server["id"] = json!(id);
        mapping.insert(old_id.clone(), id.clone());
        converted.insert(id, server);
    }
    if let Some(refs) = manifest["connectorRefs"].as_array_mut() {
        for reference in refs {
            if let Some(id) = reference.as_str().and_then(|id| mapping.get(id)) {
                *reference = json!(id);
            }
        }
    }
    write_file(
        root,
        CONNECTORS_PATH,
        &serde_json::to_vec_pretty(&json!({"mcpServers":converted})).unwrap(),
    )
}

fn write_file(root: &Path, relative: &str, bytes: &[u8]) -> Result<(), String> {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().unwrap()).map_err(|error| error.to_string())?;
    fs::write(path, bytes).map_err(|error| error.to_string())
}

pub(super) fn portable_id(name: &str) -> String {
    if validate_identifier(name).is_ok() {
        return name.to_owned();
    }
    let slug: String = name
        .chars()
        .take(36)
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let digest = format!("{:x}", Sha256::digest(name.as_bytes()));
    format!("ext-{}-{}", slug.trim_matches('-'), &digest[..10]).replace("--", "-")
}

/// Only presentation metadata is extracted; the original Skill document remains intact.
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

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    static NEXT_FIXTURE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "xiaoyin-compat-{}-{}-{}",
                std::process::id(),
                NEXT_FIXTURE.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }
        fn write(&self, path: &str, content: &str) {
            write_file(&self.0, path, content.as_bytes()).unwrap();
        }
        fn zip(&self) -> Vec<u8> {
            let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
            append_directory_to_zip(
                &mut zip,
                &self.0,
                &self.0,
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            zip.finish().unwrap().into_inner()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn equivalent_platform_manifests_preserve_display_names_and_original_files() {
        let source = Fixture::new();
        let claude = r#"{"name":"product-design","displayName":"Design","version":"0.5.10","skills":["skills/frame"]}"#;
        let qoder = r#"{"name":"product-design","displayName":"产品设计","version":"0.5.10","skills":["./skills/frame"],"qoderMarket":{"source":"apphub"}}"#;
        source.write(".claude-plugin/plugin.json", claude);
        source.write(".qoder-plugin/plugin.json", qoder);
        source.write(
            "skills/frame/SKILL.md",
            "---\nname: 问题定义\n---\n# 问题定义",
        );
        source.write("skills/frame/references/template.md", "原始模板");
        let root = Fixture::new();
        let installed = install_package_bytes(
            &root.0,
            &source.zip(),
            Some("expert-kit"),
            None,
            None,
            None,
            InstallSource::Developer,
        )
        .unwrap();
        assert_eq!(installed.manifest.id, "product-design");
        assert_eq!(installed.manifest.name, "产品设计");
        assert_eq!(installed.manifest.skills.len(), 1);
        let directory = Path::new(&installed.install_path);
        assert_eq!(
            fs::read_to_string(directory.join(".claude-plugin/plugin.json")).unwrap(),
            claude
        );
        assert_eq!(
            fs::read_to_string(directory.join(".qoder-plugin/plugin.json")).unwrap(),
            qoder
        );
        assert_eq!(
            fs::read_to_string(directory.join("skills/frame/references/template.md")).unwrap(),
            "原始模板"
        );
        let mut manifest = installed.manifest.clone();
        manifest.name = manifest.id.clone();
        let before = fs::read(directory.join(KIT_MANIFEST_PATH)).unwrap();
        assert_eq!(
            installed_kit(manifest.clone(), directory, InstallSource::Developer)
                .manifest
                .name,
            "产品设计"
        );
        assert_eq!(
            installed_kit(manifest.clone(), directory, InstallSource::Catalog)
                .manifest
                .name,
            "product-design"
        );
        manifest.name = "我的设计套件".into();
        assert_eq!(
            installed_kit(manifest, directory, InstallSource::Developer)
                .manifest
                .name,
            "我的设计套件"
        );
        assert_eq!(fs::read(directory.join(KIT_MANIFEST_PATH)).unwrap(), before);
    }

    #[test]
    fn conflicting_platform_manifests_and_secondary_unsupported_features_are_rejected() {
        for other in [
            r#"{"name":"other"}"#,
            r#"{"name":"product-design","version":"2.0.0"}"#,
            r#"{"name":"product-design","skills":"other-skills"}"#,
            r#"{"name":"product-design","commands":"other-commands"}"#,
            r#"{"name":"product-design","mcpServers":{"api":{"url":"https://example.com/mcp"}}}"#,
            r#"{"name":"product-design","hooks":{}}"#,
        ] {
            let source = Fixture::new();
            source.write(".qoder-plugin/plugin.json", r#"{"name":"product-design"}"#);
            source.write(".claude-plugin/plugin.json", other);
            assert!(normalize_package(&source.0, Some("expert-kit")).is_err());
            assert!(!source.0.join(KIT_MANIFEST_PATH).exists());
        }
    }

    #[test]
    fn presentation_uses_localized_metadata_without_changing_ids_or_custom_labels() {
        let source = Fixture::new();
        source.write(".qoder-plugin/plugin.json", r#"{"name":"developer","displayName":"开发专家","description":"Development","descriptionZh":"开发与测试"}"#);
        source.write(
            "skills/api/SKILL.md",
            "---\nname: api-design\n---\n# API接口设计",
        );
        normalize_package(&source.0, Some("expert-kit")).unwrap();
        let mut manifest =
            load_and_validate_manifest(&source.0, Some("expert-kit"), None, None).unwrap();
        assert_eq!(manifest.summary, "开发与测试");
        manifest.name = "developer".into();
        manifest.summary = "Development".into();
        apply_presentation(&source.0, &mut manifest);
        assert_eq!(manifest.name, "开发专家");
        assert_eq!(manifest.summary, "开发与测试");
        assert_eq!(manifest.id, "developer");
        assert_eq!(manifest.skills[0].id, "api-design");
        manifest.name = "团队专家".into();
        manifest.summary = "团队规范".into();
        apply_presentation(&source.0, &mut manifest);
        assert_eq!(manifest.name, "团队专家");
        assert_eq!(manifest.summary, "团队规范");

        let standalone = Fixture::new();
        standalone.write("SKILL.md", "---\nname: api-design\n---\n# API接口设计");
        normalize_package(&standalone.0, Some("skill")).unwrap();
        let mut skill =
            load_and_validate_manifest(&standalone.0, Some("skill"), None, None).unwrap();
        assert_eq!(skill.id, "api-design");
        assert_eq!(skill.name, "API接口设计");
        skill.name = "api-design".into();
        apply_presentation(&standalone.0, &mut skill);
        assert_eq!(skill.name, "API接口设计");
    }

    #[test]
    fn portable_skill_install_export_roundtrip_retains_resources() {
        let source = Fixture::new();
        source.write("my-skill/SKILL.md", "---\nname: 工作报告\ndescription: >\n  汇总数据\n  输出报告\n---\n# 报告\n参考 templates/report.md");
        source.write("my-skill/templates/report.md", "# 输出模板");
        source.write("my-skill/scripts/report.js", "export const report = true");
        let install = Fixture::new();
        let installed = install_package_bytes(
            &install.0,
            &source.zip(),
            Some("skill"),
            None,
            None,
            None,
            InstallSource::Developer,
        )
        .unwrap();
        assert_eq!(installed.manifest.name, "工作报告");
        assert_eq!(installed.manifest.summary, "汇总数据 输出报告");
        validate_identifier(&installed.manifest.id).unwrap();
        let exported = Fixture::new();
        write_extension_zip(
            Path::new(&installed.install_path),
            &exported.0.join("share.zip"),
        )
        .unwrap();
        let target = Fixture::new();
        let restored = install_package_bytes(
            &target.0,
            &fs::read(exported.0.join("share.zip")).unwrap(),
            Some("skill"),
            None,
            None,
            None,
            InstallSource::Developer,
        )
        .unwrap();
        assert_eq!(restored.manifest.id, installed.manifest.id);
        assert_eq!(
            fs::read_to_string(Path::new(&restored.install_path).join("templates/report.md"))
                .unwrap(),
            "# 输出模板"
        );
        assert!(
            Path::new(&restored.install_path)
                .join("scripts/report.js")
                .is_file()
        );
    }

    #[test]
    fn plugin_conversion_preserves_paths_commands_and_bundled_connectors() {
        for plugin_path in PLUGIN_PATHS {
            let source = Fixture::new();
            source.write(
                plugin_path,
                r#"{"name":"report-kit","skills":"./methods","commands":"./commands"}"#,
            );
            source.write(
                "methods/review/SKILL.md",
                "---\nname: review\ndescription: Review reports\n---\n# Review",
            );
            source.write("methods/review/templates/output.md", "Template");
            source.write(
                "commands/review.md",
                "Review $ARGUMENTS using ${CLAUDE_PLUGIN_ROOT}/data",
            );
            source.write("commands/other.md", "UNSELECTED_COMMAND_BODY");
            source.write(".mcp.json", r#"{"mcpServers":{"reports":{"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/server.js"]}}}"#);
            source.write("server.js", "// MCP server");
            let install = Fixture::new();
            let installed = install_package_bytes(
                &install.0,
                &source.zip(),
                Some("expert-kit"),
                None,
                None,
                None,
                InstallSource::Developer,
            )
            .unwrap();
            assert_eq!(installed.manifest.skills[0].path, "methods/review/SKILL.md");
            assert_eq!(
                installed.manifest.connector_refs,
                vec!["report-kit-reports"]
            );
            assert_eq!(
                installed.bundled_connectors.as_ref().unwrap()["mcpServers"]["report-kit-reports"]
                    ["args"][0],
                format!("{}/server.js", installed.install_path)
            );
            let context =
                load_command_context(&installed, "/kit:report-kit:review quarterly sales").unwrap();
            assert!(context.contains("Review quarterly sales"));
            assert!(!context.contains("UNSELECTED_COMMAND_BODY"));
            assert!(load_command_context(&installed, "/kit:report-kit:missing").is_err());
            let mut files = Vec::new();
            collect_payload_files(
                Path::new(&installed.install_path),
                Path::new(&installed.install_path),
                Path::new(""),
                &mut files,
            )
            .unwrap();
            assert!(files.iter().any(|(path, _)| path == CONNECTORS_PATH));
            let package = build_developer_package(&installed.manifest, "", &files).unwrap();
            let restored = Fixture::new();
            let reinstalled = install_package_bytes(
                &restored.0,
                &package,
                Some("expert-kit"),
                None,
                None,
                None,
                InstallSource::Developer,
            )
            .unwrap();
            assert!(reinstalled.bundled_connectors.is_some());
            assert!(
                Path::new(&reinstalled.install_path)
                    .join("methods/review/templates/output.md")
                    .is_file()
            );
        }
    }

    #[test]
    fn unsupported_plugin_features_and_broken_references_are_explicit_errors() {
        for manifest in [
            r#"{"name":"report-kit","hooks":{}}"#,
            r#"{"name":"report-kit","agents":"./agents"}"#,
            r#"{"name":"report-kit","skills":"../outside"}"#,
            r#"{"name":"report-kit","skills":"./missing"}"#,
            r#"{"name":"report-kit","mcpServers":{"api":{"oauth":{}}}}"#,
        ] {
            let source = Fixture::new();
            source.write(PLUGIN_PATHS[0], manifest);
            let installed = Fixture::new();
            assert!(
                install_package_bytes(
                    &installed.0,
                    &source.zip(),
                    Some("expert-kit"),
                    None,
                    None,
                    None,
                    InstallSource::Developer
                )
                .is_err()
            );
            assert!(!installed.0.join("report-kit").exists());
        }
    }

    #[test]
    fn catalog_does_not_auto_convert_portable_packages() {
        let source = Fixture::new();
        source.write(
            "SKILL.md",
            "---\nname: report\ndescription: Report\n---\n# Report",
        );
        let installed = Fixture::new();
        assert!(
            install_package_bytes(
                &installed.0,
                &source.zip(),
                Some("skill"),
                None,
                None,
                None,
                InstallSource::Catalog
            )
            .is_err()
        );
    }

    #[test]
    fn customized_bundle_uses_its_own_connector_ids() {
        let root = Fixture::new();
        root.write(CONNECTORS_PATH, r#"{"mcpServers":{"original-api":{"id":"original-api","command":"node","args":["${CLAUDE_PLUGIN_ROOT}/server.js"]}}}"#);
        let mut manifest = json!({"connectorRefs":["original-api", "company-erp"]});
        rekey_bundled_connectors(&root.0, &mut manifest, "custom-kit").unwrap();
        assert_eq!(
            manifest["connectorRefs"],
            json!(["custom-kit-original-api", "company-erp"])
        );
        let config = bundled_connectors(&root.0).unwrap();
        assert!(config["mcpServers"].get("original-api").is_none());
        assert_eq!(
            config["mcpServers"]["custom-kit-original-api"]["args"][0],
            format!("{}/server.js", root.0.display())
        );
    }

    #[test]
    fn generated_kit_keeps_guide_and_selected_skill_resources() {
        let manifest: ExpertKitManifest = serde_json::from_value(json!({"schemaVersion":"2", "kind":"expert-kit", "id":"report-kit", "name":"报告专家", "version":"1.0.0", "summary":"分析报告", "minimumDesktopVersion":"0.1.30", "skills":[{"id":"guide-report-kit", "path":"skills/kit-guide/SKILL.md"}, {"id":"reports", "path":"skills/reports/SKILL.md"}], "commands":[{"id":"start", "path":"commands/start.md"}]})).unwrap();
        let bytes = build_developer_package(
            &manifest,
            "# 岗位工作流程",
            &[
                ("skills/reports/SKILL.md".into(), b"# Reports".to_vec()),
                ("skills/reports/template.md".into(), b"Template".to_vec()),
            ],
        )
        .unwrap();
        let installed = Fixture::new();
        let kit = install_package_bytes(
            &installed.0,
            &bytes,
            Some("expert-kit"),
            None,
            None,
            None,
            InstallSource::Developer,
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(Path::new(&kit.install_path).join("skills/kit-guide/SKILL.md"))
                .unwrap(),
            "# 岗位工作流程"
        );
        assert!(
            Path::new(&kit.install_path)
                .join("skills/reports/template.md")
                .is_file()
        );
        assert!(
            load_command_context(&kit, "/kit:report-kit:start 本周销售")
                .unwrap()
                .contains("本周销售")
        );
    }
}
