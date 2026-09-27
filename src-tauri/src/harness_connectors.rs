use crate::expert_kits;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[cfg(test)]
mod timeout_tests {
    use super::*;

    #[test]
    fn erp_cookie_mode_is_forwarded_only_for_remote_connectors_without_static_auth() {
        let mut connector: ConnectorDefinition = serde_json::from_value(serde_json::json!({
            "id": "erp", "name": "ERP", "status": "ready", "version": "1",
            "transport": "streamable-http", "url": "https://erp.example/mcp", "authMode": "erp-cookie"
        }))
        .unwrap();
        assert_eq!(
            diagnostic_connectors(&[connector.clone()]).unwrap()[0].auth_mode,
            "erp-cookie"
        );
        connector.headers.insert("cOoKiE".into(), "secret".into());
        assert!(validate_connector_catalog(&[connector.clone()]).is_err());
        connector.headers.clear();
        connector.transport = "stdio".into();
        connector.command = "node".into();
        assert!(validate_connector_catalog(&[connector]).is_err());
    }

    #[test]
    fn diagnostic_and_chat_share_the_tool_policy_and_differ_only_in_probing() {
        let connector: ConnectorDefinition = serde_json::from_value(serde_json::json!({
            "id": "erp-mcp", "name": "erp-mcp", "status": "ready", "version": "1",
            "transport": "streamable-http", "url": "http://erp.example/mcp", "authMode": "none",
            "enabled": true, "toolNames": ["order.get", "order.cancel"], "readOnlyTools": ["order.get"]
        }))
        .unwrap();
        let profile = expert_kits::ExpertKitHarnessProfile {
            skill_directories: Vec::new(),
            knowledge_base_refs: None,
            required_connector_tools: vec!["order.get".into()],
            allowed_computer_tools: Vec::new(),
            prompt: String::new(),
        };
        let chat =
            &runtime_connectors(std::slice::from_ref(&connector), &profile, true).unwrap()[0];
        let probe = &diagnostic_connectors(&[connector]).unwrap()[0];
        // A connector that diagnoses as ready must behave the same way in a
        // task: same allow-list, same read-only classification, same write
        // permission, same timeout.
        assert_eq!(chat.allowed_tools, vec!["order.get"]);
        assert_eq!(probe.allowed_tools, vec!["order.get", "order.cancel"]);
        assert_eq!(chat.read_only_tools, probe.read_only_tools);
        assert_eq!(chat.allow_write, probe.allow_write);
        assert_eq!(chat.timeout_seconds, probe.timeout_seconds);
        assert_eq!(chat.url, probe.url);
        assert_eq!(chat.transport, probe.transport);
        // Exactly two deliberate probe differences: the probe fails loudly
        // instead of skipping the connector, and it does not require an
        // approval it can never ask for because it only lists tools.
        assert!(probe.required && !chat.required);
        assert!(!probe.require_write_approval && chat.require_write_approval);
    }

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

    #[test]
    fn read_only_snapshot_must_reference_a_declared_tool() {
        let connector: ConnectorDefinition = serde_json::from_value(serde_json::json!({
            "id": "erp-mcp", "name": "ERP", "status": "ready", "version": "1",
            "transport": "streamable-http", "url": "http://erp.example/mcp", "authMode": "none",
            "toolNames": [], "readOnlyTools": ["store.sales_summary"]
        }))
        .unwrap();
        assert!(validate_connector_catalog(&[connector]).is_err());
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
    pub(crate) read_only_tools: Vec<String>,
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
    pub(crate) read_only_tools: Vec<String>,
    pub(crate) allow_write: bool,
    pub(crate) require_write_approval: bool,
    pub(crate) required: bool,
}

/// One connector's tool policy. Both the chat runtime and the connector
/// diagnostic build their entry here, so a connector that diagnoses as ready
/// behaves the same way in a task: same allow-list, same write classification,
/// same approval requirement.
struct ConnectorPolicy<'a> {
    allowed_tools: &'a [String],
    required_tools: Vec<String>,
    allow_write: bool,
    require_write_approval: bool,
    required: bool,
}

fn connector_entry(
    connector: &ConnectorDefinition,
    policy: ConnectorPolicy<'_>,
) -> RuntimeConnector {
    RuntimeConnector {
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
        allowed_tools: policy.allowed_tools.to_vec(),
        required_tools: policy.required_tools,
        read_only_tools: connector.read_only_tools.clone(),
        allow_write: policy.allow_write,
        require_write_approval: policy.require_write_approval,
        required: policy.required,
    }
}

/// The connector diagnostic answers "will this work in a task?", so it keeps the
/// task tool policy and differs only where a probe must: it fails loudly instead
/// of skipping the connector, and it never waits for an approval it cannot ask
/// for because it lists tools without calling one.
pub(crate) fn diagnostic_connectors(
    catalog: &[ConnectorDefinition],
) -> Result<Vec<RuntimeConnector>, String> {
    validate_connector_catalog(catalog)?;
    Ok(catalog
        .iter()
        .filter(|connector| connector.status == "ready")
        .map(|connector| {
            connector_entry(
                connector,
                ConnectorPolicy {
                    allowed_tools: &connector.tool_names,
                    required_tools: connector.tool_names.clone(),
                    allow_write: true,
                    require_write_approval: false,
                    required: true,
                },
            )
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
        .filter(|connector| connector.enabled && connector.status == "ready")
        .collect::<Vec<_>>();
    Ok(selected
        .into_iter()
        .map(|connector| {
            let allowed_tools = if profile.required_connector_tools.is_empty() {
                connector.tool_names.clone()
            } else {
                connector
                    .tool_names
                    .iter()
                    .filter(|tool| profile.required_connector_tools.contains(*tool))
                    .cloned()
                    .collect::<Vec<_>>()
            };
            connector_entry(
                connector,
                ConnectorPolicy {
                    allowed_tools: &allowed_tools,
                    required_tools: profile
                        .required_connector_tools
                        .iter()
                        .filter(|tool| connector.tool_names.contains(*tool))
                        .cloned()
                        .collect(),
                    allow_write,
                    require_write_approval: true,
                    required: false,
                },
            )
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
        if !matches!(connector.transport.as_str(), "streamable-http" | "stdio") {
            return Err(format!("连接器传输方式无效：{}", connector.id));
        }
        if !matches!(
            connector.auth_mode.as_str(),
            "employee-bearer" | "erp-cookie" | "oauth" | "none"
        ) {
            return Err(format!("连接器认证方式无效：{}", connector.id));
        }
        if matches!(connector.auth_mode.as_str(), "erp-cookie" | "oauth") {
            if connector.transport != "streamable-http" {
                return Err("动态授权仅支持 Streamable HTTP 连接器".into());
            }
            if connector.headers.keys().any(|key| {
                key.eq_ignore_ascii_case("cookie") || key.eq_ignore_ascii_case("authorization")
            }) {
                return Err("动态授权不能同时配置 Cookie 或 Authorization 请求头".into());
            }
        }
        if connector.transport == "stdio" {
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
        let mut read_only_tools = HashSet::new();
        if connector.read_only_tools.iter().any(|tool| {
            !valid_identifier(tool)
                || !read_only_tools.insert(tool.as_str())
                || !tools.contains(tool.as_str())
        }) {
            return Err(format!(
                "连接器只读工具未在工具清单中声明：{}",
                connector.id
            ));
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
