use crate::expert_kits;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectorDefinition {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) status: String,
    pub(crate) version: String,
    pub(crate) transport: String,
    pub(crate) url: String,
    pub(crate) auth_mode: String,
    #[serde(default)]
    pub(crate) tool_names: Vec<String>,
}

#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConnector {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) version: String,
    pub(crate) transport: String,
    pub(crate) url: String,
    pub(crate) auth_mode: String,
    pub(crate) allowed_tools: Vec<String>,
    pub(crate) required_tools: Vec<String>,
    pub(crate) allow_write: bool,
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
            id: connector.id.clone(),
            name: connector.name.clone(),
            version: connector.version.clone(),
            transport: connector.transport.clone(),
            url: connector.url.clone(),
            auth_mode: connector.auth_mode.clone(),
            allowed_tools: connector.tool_names.clone(),
            required_tools: connector.tool_names.clone(),
            allow_write: true,
            required: true,
        })
        .collect())
}

pub(crate) fn runtime_connectors(
    catalog: &[ConnectorDefinition],
    profile: &expert_kits::ExpertKitHarnessProfile,
) -> Result<Vec<RuntimeConnector>, String> {
    validate_connector_catalog(catalog)?;
    let by_id = catalog
        .iter()
        .map(|connector| (connector.id.as_str(), connector))
        .collect::<HashMap<_, _>>();
    for connector_id in &profile.connector_refs {
        let connector = by_id
            .get(connector_id.as_str())
            .ok_or_else(|| format!("扩展引用了未发布的连接器：{connector_id}"))?;
        if connector.status != "ready" {
            return Err(format!("扩展依赖的连接器尚未就绪：{}", connector.name));
        }
    }
    let selected = catalog
        .iter()
        .filter(|connector| connector.transport != "desktop" && connector.status == "ready")
        .collect::<Vec<_>>();
    let connector_tools = selected
        .iter()
        .map(|connector| (connector.id.as_str(), connector.tool_names.to_vec()))
        .collect::<HashMap<_, _>>();
    let desktop_tools = catalog
        .iter()
        .filter(|connector| connector.transport == "desktop" && connector.status == "ready")
        .flat_map(|connector| connector.tool_names.iter().cloned())
        .collect::<HashSet<_>>();
    let mut claimed_tools = HashMap::<String, String>::new();
    for connector in &selected {
        for tool in connector_tools
            .get(connector.id.as_str())
            .expect("selected connector tools were computed")
        {
            if let Some(owner) = claimed_tools.insert(tool.clone(), connector.id.clone()) {
                return Err(format!(
                    "连接器工具名冲突：{tool} 同时由 {owner} 和 {} 提供",
                    connector.id
                ));
            }
        }
    }
    let available_tools = claimed_tools
        .keys()
        .cloned()
        .chain(desktop_tools)
        .collect::<HashSet<_>>();
    let missing = profile
        .required_connector_tools
        .iter()
        .filter(|tool| !available_tools.contains(*tool))
        .cloned()
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(format!(
            "专家套件缺少可用连接器工具：{}",
            missing.join(", ")
        ));
    }

    Ok(selected
        .into_iter()
        .map(|connector| RuntimeConnector {
            id: connector.id.clone(),
            name: connector.name.clone(),
            version: connector.version.clone(),
            transport: connector.transport.clone(),
            url: connector.url.clone(),
            auth_mode: connector.auth_mode.clone(),
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
            allow_write: profile.allow_connector_write,
            required: profile.connector_refs.contains(&connector.id),
        })
        .collect())
}

pub(crate) fn validate_connector_catalog(connectors: &[ConnectorDefinition]) -> Result<(), String> {
    if connectors.len() > 32 {
        return Err("连接器数量不能超过 32 个".to_string());
    }
    let mut connector_ids = HashSet::new();
    for connector in connectors {
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
            "streamable-http" | "sse" | "desktop"
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
