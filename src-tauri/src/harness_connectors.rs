use crate::expert_kits;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[cfg(test)]
mod timeout_tests {
    use super::*;

    #[test]
    fn configured_timeout_is_validated_and_forwarded() {
        let mut connector: ConnectorDefinition = serde_json::from_value(serde_json::json!({
            "id": "test-server", "name": "Test", "status": "ready", "version": "1",
            "transport": "stdio", "url": "", "authMode": "none", "command": "node",
            "timeoutSeconds": 120
        }))
        .unwrap();
        let runtime = diagnostic_connectors(&[connector.clone()]).unwrap();
        assert_eq!(
            serde_json::to_value(&runtime[0]).unwrap()["timeoutSeconds"],
            120
        );
        connector.timeout_seconds = Some(601);
        assert!(validate_connector_catalog(&[connector.clone()]).is_err());
        connector.timeout_seconds = None;
        assert!(validate_connector_catalog(&[connector]).is_ok());
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectorDefinition {
    #[serde(default)]
    pub(crate) timeout_seconds: Option<u64>,
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) status: String,
    pub(crate) version: String,
    pub(crate) transport: String,
    pub(crate) url: String,
    pub(crate) auth_mode: String,
    #[serde(default)]
    pub(crate) command: String,
    #[serde(default)]
    pub(crate) arguments: Vec<String>,
    #[serde(default)]
    pub(crate) environment: HashMap<String, String>,
    #[serde(default)]
    pub(crate) headers: HashMap<String, String>,
    #[serde(default)]
    pub(crate) tool_names: Vec<String>,
    #[serde(default)]
    pub(crate) enabled: bool,
}

#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConnector {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) timeout_seconds: Option<u64>,
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) version: String,
    pub(crate) transport: String,
    pub(crate) url: String,
    pub(crate) auth_mode: String,
    pub(crate) command: String,
    pub(crate) arguments: Vec<String>,
    pub(crate) environment: HashMap<String, String>,
    pub(crate) headers: HashMap<String, String>,
    pub(crate) allowed_tools: Vec<String>,
    pub(crate) required_tools: Vec<String>,
    pub(crate) allow_write: bool,
    pub(crate) require_write_approval: bool,
    pub(crate) required: bool,
}

pub(crate) fn diagnostic_connectors(
    catalog: &[ConnectorDefinition],
) -> Result<Vec<RuntimeConnector>, String> {
    validate_connector_catalog(catalog)?;
    Ok(catalog
        .iter()
        .filter(|connector| connector.status == "ready" && connector.transport != "desktop")
        .map(|connector| RuntimeConnector {
            timeout_seconds: connector.timeout_seconds,
            id: connector.id.clone(),
            name: connector.name.clone(),
            version: connector.version.clone(),
            transport: connector.transport.clone(),
            url: connector.url.clone(),
            auth_mode: connector.auth_mode.clone(),
            command: connector.command.clone(),
            arguments: connector.arguments.clone(),
            environment: connector.environment.clone(),
            headers: connector.headers.clone(),
            allowed_tools: connector.tool_names.clone(),
            required_tools: connector.tool_names.clone(),
            allow_write: true,
            require_write_approval: false,
            required: true,
        })
        .collect())
}

pub(crate) fn runtime_connectors(
    catalog: &[ConnectorDefinition],
    profile: &expert_kits::ExpertKitHarnessProfile,
    allow_write: bool,
) -> Result<Vec<RuntimeConnector>, String> {
    validate_connector_catalog(catalog)?;
    let selected = catalog
        .iter()
        .filter(|connector| {
            connector.enabled && connector.transport != "desktop" && connector.status == "ready"
        })
        .collect::<Vec<_>>();
    let connector_tools = selected
        .iter()
        .map(|connector| (connector.id.as_str(), connector.tool_names.to_vec()))
        .collect::<HashMap<_, _>>();
    Ok(selected
        .into_iter()
        .map(|connector| RuntimeConnector {
            timeout_seconds: connector.timeout_seconds,
            id: connector.id.clone(),
            name: connector.name.clone(),
            version: connector.version.clone(),
            transport: connector.transport.clone(),
            url: connector.url.clone(),
            auth_mode: connector.auth_mode.clone(),
            command: connector.command.clone(),
            arguments: connector.arguments.clone(),
            environment: connector.environment.clone(),
            headers: connector.headers.clone(),
            allowed_tools: connector_tools
                .get(connector.id.as_str())
                .expect("selected connector tools were computed")
                .clone(),
            required_tools: profile
                .required_connector_tools
                .iter()
                .filter(|tool| connector.tool_names.contains(*tool))
                .cloned()
                .collect(),
            allow_write,
            require_write_approval: true,
            required: false,
        })
        .collect())
}

pub(crate) fn validate_connector_catalog(connectors: &[ConnectorDefinition]) -> Result<(), String> {
    let mut connector_ids = HashSet::new();
    for connector in connectors {
        if connector
            .timeout_seconds
            .is_some_and(|seconds| !(1..=600).contains(&seconds))
        {
            return Err(format!("连接器超时时间须为 1–600 秒：{}", connector.id));
        }
        if !valid_identifier(&connector.id) || !connector_ids.insert(connector.id.as_str()) {
            return Err(format!("连接器 ID 无效或重复：{}", connector.id));
        }
        if connector.name.trim().is_empty() || connector.name.len() > 200 {
            return Err(format!("连接器名称无效：{}", connector.id));
        }
        if connector.version.trim().is_empty() || connector.version.len() > 100 {
            return Err(format!("连接器版本无效：{}", connector.id));
        }
        if !matches!(
            connector.status.as_str(),
            "ready" | "needs-configuration" | "unavailable" | "disabled"
        ) {
            return Err(format!("连接器状态无效：{}", connector.id));
        }
        if !matches!(
            connector.transport.as_str(),
            "streamable-http" | "sse" | "stdio" | "desktop"
        ) {
            return Err(format!("连接器传输方式无效：{}", connector.id));
        }
        if !matches!(connector.auth_mode.as_str(), "employee-bearer" | "none") {
            return Err(format!("连接器认证方式无效：{}", connector.id));
        }
        if connector.transport == "desktop" {
            if !connector.url.is_empty() {
                return Err(format!("桌面内置连接器不能配置远程地址：{}", connector.id));
            }
        } else if connector.transport == "stdio" {
            if connector.command.trim().is_empty() {
                return Err(format!("stdio 连接器缺少启动命令：{}", connector.id));
            }
        } else if connector.status == "ready" {
            validate_http_url("连接器", &connector.url)?;
        }
        if connector.tool_names.len() > 512 {
            return Err(format!("连接器工具数量超限：{}", connector.id));
        }
        let mut tools = HashSet::new();
        for tool in &connector.tool_names {
            if !valid_identifier(tool) || !tools.insert(tool.as_str()) {
                return Err(format!("连接器工具名称无效或重复：{tool}"));
            }
        }
    }
    Ok(())
}

pub(crate) fn desktop_connector_enabled(catalog: &[ConnectorDefinition], id: &str) -> bool {
    catalog.iter().any(|connector| {
        connector.id == id
            && connector.enabled
            && connector.status == "ready"
            && connector.transport == "desktop"
    })
}

pub(crate) fn validate_http_url(name: &str, value: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(value).map_err(|error| format!("{name} 地址无效：{error}"))?;
    if matches!(url.scheme(), "http" | "https") {
        Ok(())
    } else {
        Err(format!("{name} 只允许 HTTP(S) 地址"))
    }
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'.' | b'_' | b'-'))
}
