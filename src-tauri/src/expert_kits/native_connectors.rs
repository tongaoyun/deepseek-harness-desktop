use super::*;
use serde_json::Value;

pub(super) const CONNECTORS_PATH: &str = ".xiaoyin-kit/connectors.json";
pub(super) const EXTENSION_ROOT_VARIABLE: &str = "${XIAOYIN_EXTENSION_ROOT}";
const FOREIGN_ROOT_VARIABLES: [&str; 3] = [
    "${CLAUDE_PLUGIN_ROOT}",
    "${QWEN_PLUGIN_ROOT}",
    "${QODER_PLUGIN_ROOT}",
];

pub(super) fn validate(
    root: &Path,
    connector_refs: &[String],
    commands: &[FileReference],
) -> Result<(), String> {
    for command in commands {
        let content = fs::read_to_string(root.join(&command.path))
            .map_err(|error| format!("无法读取专家套件命令 {}：{error}", command.id))?;
        reject_foreign_root_variables(&Value::String(content))?;
    }
    let path = root.join(CONNECTORS_PATH);
    if !path.is_file() {
        return Ok(());
    }
    let config = read_json(&path)?;
    reject_foreign_root_variables(&config)?;
    let servers = config
        .get("mcpServers")
        .and_then(Value::as_object)
        .ok_or("套件连接器配置必须包含 mcpServers 对象")?;
    for (id, server) in servers {
        validate_identifier(id)?;
        let server = server.as_object().ok_or("套件连接器必须是 JSON 对象")?;
        if server.get("id").and_then(Value::as_str) != Some(id) {
            return Err(format!("套件连接器 ID 与配置键不一致：{id}"));
        }
        if !connector_refs.iter().any(|reference| reference == id) {
            return Err(format!("套件连接器未在 connectorRefs 中声明：{id}"));
        }
    }
    Ok(())
}

pub(super) fn bundled_connectors(directory: &Path) -> Option<Value> {
    let mut config = read_json(&directory.join(CONNECTORS_PATH)).ok()?;
    replace_root_variable(
        &mut config,
        EXTENSION_ROOT_VARIABLE,
        &directory.to_string_lossy(),
    );
    Some(config)
}

pub(super) fn portable_id(name: &str) -> String {
    if validate_identifier(name).is_ok() {
        return name.to_owned();
    }
    let slug: String = name
        .chars()
        .take(36)
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let digest = format!("{:x}", Sha256::digest(name.as_bytes()));
    let slug = slug.trim_matches('-').replace("--", "-");
    let slug = if slug.is_empty() { "extension" } else { &slug };
    format!("ext-{slug}-{}", &digest[..10])
}

pub(super) fn replace_root_variable(value: &mut Value, variable: &str, replacement: &str) {
    match value {
        Value::String(text) => *text = text.replace(variable, replacement),
        Value::Array(values) => values
            .iter_mut()
            .for_each(|value| replace_root_variable(value, variable, replacement)),
        Value::Object(values) => values
            .values_mut()
            .for_each(|value| replace_root_variable(value, variable, replacement)),
        _ => {}
    }
}

fn reject_foreign_root_variables(value: &Value) -> Result<(), String> {
    match value {
        Value::String(text)
            if FOREIGN_ROOT_VARIABLES
                .iter()
                .any(|variable| text.contains(variable)) =>
        {
            Err("原生扩展只能使用 ${XIAOYIN_EXTENSION_ROOT}".into())
        }
        Value::Array(values) => values.iter().try_for_each(reject_foreign_root_variables),
        Value::Object(values) => values.values().try_for_each(reject_foreign_root_variables),
        _ => Ok(()),
    }
}

pub(super) fn read_json(path: &Path) -> Result<Value, String> {
    let value: Value =
        serde_json::from_slice(&fs::read(path).map_err(|error| format!("读取配置失败：{error}"))?)
            .map_err(|error| format!("JSON 配置无效：{error}"))?;
    if !value.is_object() {
        return Err("配置必须是 JSON 对象".into());
    }
    Ok(value)
}

pub(super) fn write_json(root: &Path, relative: &str, value: &Value) -> Result<(), String> {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().ok_or("配置路径无效")?).map_err(|error| error.to_string())?;
    fs::write(path, serde_json::to_vec_pretty(value).unwrap()).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn expands_only_the_native_root_variable() {
        let mut value = json!({
            "native": "${XIAOYIN_EXTENSION_ROOT}/server.js",
            "foreign": "${QODER_PLUGIN_ROOT}/server.js"
        });
        replace_root_variable(&mut value, EXTENSION_ROOT_VARIABLE, "/extensions/example");
        assert_eq!(value["native"], "/extensions/example/server.js");
        assert_eq!(value["foreign"], "${QODER_PLUGIN_ROOT}/server.js");
    }

    #[test]
    fn rejects_foreign_root_variables() {
        let error = reject_foreign_root_variables(&json!({
            "command": "${CLAUDE_PLUGIN_ROOT}/server.js"
        }))
        .unwrap_err();
        assert!(error.contains("XIAOYIN_EXTENSION_ROOT"));
    }
}
