use super::*;
use std::io::Read;

pub(super) fn load_and_validate_manifest(
    root: &Path,
    expected_kind: Option<&str>,
    expected_id: Option<&str>,
    expected_version: Option<&str>,
) -> Result<ExpertKitManifest, String> {
    let kit_manifest = root.join(KIT_MANIFEST_PATH);
    let skill_manifest = root.join(SKILL_MANIFEST_PATH);
    let (kind, manifest_path) = match (kit_manifest.is_file(), skill_manifest.is_file()) {
        (true, false) => ("expert-kit", kit_manifest),
        (false, true) => ("skill", skill_manifest),
        (true, true) => return Err("扩展不能同时包含专家套件和独立技能清单".to_string()),
        (false, false) => {
            return Err("扩展缺少 .xiaoyin-kit/kit.json 或 .xiaoyin-skill/skill.json".to_string());
        }
    };
    if expected_kind.is_some_and(|expected| expected != kind) {
        return Err("扩展类型与目录记录不一致".to_string());
    }
    let file = File::open(&manifest_path).map_err(|_| "无法打开扩展清单".to_string())?;
    let mut json = String::new();
    file.take(1024 * 1024)
        .read_to_string(&mut json)
        .map_err(|error| format!("无法读取扩展清单：{error}"))?;
    let mut value: serde_json::Value =
        serde_json::from_str(&json).map_err(|error| format!("扩展清单无效：{error}"))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| "扩展清单必须是 JSON 对象".to_string())?;
    if object.contains_key("kind")
        || object.contains_key("commands") && kind == "skill"
        || object.contains_key("skills") && kind == "skill"
    {
        return Err("独立技能与专家套件字段不能混用".to_string());
    }
    let schema = object
        .get("schemaVersion")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if (kind == "expert-kit" && schema != "2") || (kind == "skill" && schema != "1") {
        return Err("不支持的扩展 Schema 版本".to_string());
    }
    object.insert(
        "kind".to_string(),
        serde_json::Value::String(kind.to_string()),
    );
    if kind == "skill" {
        object.insert("commands".to_string(), serde_json::json!([]));
        object.insert("skills".to_string(), serde_json::json!([{ "id": object.get("id").cloned().unwrap_or_default(), "path": "SKILL.md" }]));
    }
    let manifest: ExpertKitManifest =
        serde_json::from_value(value).map_err(|error| format!("扩展清单字段无效：{error}"))?;
    validate_identifier(&manifest.id)?;
    Version::parse(&manifest.version).map_err(|error| format!("专家套件版本无效：{error}"))?;
    if expected_id.is_some_and(|id| id != manifest.id) {
        return Err("专家套件 ID 与目录记录不一致".to_string());
    }
    if expected_version.is_some_and(|version| version != manifest.version) {
        return Err("专家套件版本与目录记录不一致".to_string());
    }
    if manifest.name.trim().is_empty()
        || manifest.name.chars().count() > 80
        || manifest.summary.trim().is_empty()
        || manifest.summary.chars().count() > 300
        || manifest.skills.is_empty()
    {
        return Err("专家套件名称、简介和技能不能为空".to_string());
    }
    if manifest
        .author
        .as_ref()
        .is_some_and(|author| author.trim().is_empty() || author.chars().count() > 80)
    {
        return Err("扩展作者无效".to_string());
    }
    if !EXTENSION_CATEGORIES.contains(&manifest.category.as_str()) {
        return Err("扩展分类无效".to_string());
    }

    let mut triggers = HashSet::new();
    if (manifest.kind == "skill" && manifest.triggers.is_empty())
        || manifest.triggers.len() > 20
        || manifest.triggers.iter().any(|trigger| {
            !(2..=120).contains(&trigger.chars().count())
                || trigger.trim() != trigger
                || !triggers.insert(trigger)
        })
    {
        return Err("扩展触发场景声明无效".to_string());
    }

    let mut reference_ids = HashSet::new();
    for (reference, is_skill) in manifest
        .commands
        .iter()
        .map(|item| (item, false))
        .chain(manifest.skills.iter().map(|item| (item, true)))
    {
        if !valid_file_reference_id(&reference.id)
            || !reference_ids.insert((is_skill, &reference.id))
        {
            return Err("专家套件命令和技能 ID 不能为空或重复".to_string());
        }
        let path = Path::new(&reference.path);
        validate_relative_path(path)?;
        if !root.join(path).is_file() {
            return Err(format!("专家套件引用文件不存在：{}", reference.path));
        }
        if manifest.kind == "skill" && reference.path != "SKILL.md" {
            return Err("独立技能的入口必须是根目录 SKILL.md".to_string());
        }
        if manifest.kind == "expert-kit"
            && is_skill
            && Path::new(&reference.path)
                .file_name()
                .is_none_or(|name| name != "SKILL.md")
        {
            return Err(format!(
                "套件技能 {} 的入口文件必须命名为 SKILL.md",
                reference.id
            ));
        }
    }
    let mut tools = HashSet::new();
    for tool in &manifest.required_tools {
        if !valid_tool_name(tool) || !tools.insert(tool) {
            return Err(format!("专家套件工具声明无效：{tool}"));
        }
    }
    let mut connectors = HashSet::new();
    for connector in &manifest.connector_refs {
        if validate_identifier(connector).is_err() || !connectors.insert(connector) {
            return Err(format!("专家套件连接器引用无效：{connector}"));
        }
    }
    native_connectors::validate(root, &manifest.connector_refs, &manifest.commands)?;
    if let Some(knowledge_base_refs) = &manifest.knowledge_base_refs {
        if knowledge_base_refs.len() > 32 {
            return Err("专家套件知识库引用不能超过 32 个".to_string());
        }
        let minimum = Version::parse(&manifest.minimum_desktop_version)
            .map_err(|error| format!("最低桌面版本无效：{error}"))?;
        if minimum < Version::new(0, 1, 7) {
            return Err("使用知识库引用的专家套件必须要求桌面端 0.1.7 或更高版本".to_string());
        }
        let mut references = HashSet::new();
        for reference in knowledge_base_refs {
            if !valid_knowledge_base_reference(reference) || !references.insert(reference) {
                return Err(format!("专家套件知识库引用无效或重复：{reference}"));
            }
        }
    }
    Ok(manifest)
}

pub(super) fn ensure_supported_desktop_version(minimum: Option<&str>) -> Result<(), String> {
    let Some(minimum) = minimum.filter(|value| !value.trim().is_empty()) else {
        return Ok(());
    };
    let minimum = Version::parse(minimum).map_err(|error| format!("最低桌面版本无效：{error}"))?;
    let current = Version::parse(env!("CARGO_PKG_VERSION"))
        .map_err(|error| format!("当前桌面版本无效：{error}"))?;
    if current < minimum {
        return Err(format!("该套件需要小胤桌面端 {minimum} 或更高版本"));
    }
    Ok(())
}

pub(super) fn validate_identifier(value: &str) -> Result<(), String> {
    let valid = (3..=64).contains(&value.len())
        && value.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && value.bytes().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == b'-'
        });
    if valid {
        Ok(())
    } else {
        Err("专家套件 ID 无效".to_string())
    }
}

pub(super) fn validate_sha256(value: &str) -> Result<(), String> {
    if value.len() == 64 && value.bytes().all(|character| character.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("专家套件 SHA-256 无效".to_string())
    }
}

pub(super) fn validate_relative_path(path: &Path) -> Result<(), String> {
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("专家套件包含不安全路径".to_string());
    }
    Ok(())
}

pub(super) fn valid_tool_name(value: &str) -> bool {
    value.len() >= 2
        && value.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && value.bytes().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, b'_' | b'.' | b'-')
        })
}

fn valid_file_reference_id(value: &str) -> bool {
    (2..=64).contains(&value.len())
        && value.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && value.bytes().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == b'-'
        })
}

pub(super) fn valid_knowledge_base_reference(value: &str) -> bool {
    let Some((scope, key)) = value.split_once(':') else {
        return false;
    };
    matches!(scope, "personal" | "team" | "organization")
        && (3..=64).contains(&key.len())
        && key.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && key.bytes().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == b'-'
        })
}
