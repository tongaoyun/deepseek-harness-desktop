use flate2::read::GzDecoder;
use futures_util::StreamExt;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{Cursor, Read},
    path::{Component, Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const MAX_PACKAGE_BYTES: usize = 32 * 1024 * 1024;
const MAX_EXTRACTED_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 1024;
const MANIFEST_PATH: &str = ".xiaoyin-plugin/plugin.json";
const INSTALL_RECORD_PATH: &str = ".xiaoyin-plugin/install.json";
const DESKTOP_OFFICE_TOOLS: [&str; 4] = [
    "office.document.read",
    "office.docx.create",
    "office.xlsx.create",
    "office.pdf.create",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpertKitInstallRequest {
    id: String,
    version: String,
    sha256: String,
    url: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpertKitManifest {
    schema_version: String,
    id: String,
    name: String,
    version: String,
    summary: String,
    #[serde(default)]
    minimum_desktop_version: String,
    #[serde(default)]
    commands: Vec<FileReference>,
    skills: Vec<FileReference>,
    #[serde(default)]
    required_tools: Vec<String>,
    #[serde(default)]
    connector_refs: Vec<String>,
    permissions: Permissions,
    #[serde(default)]
    server_workflows: Vec<ServerWorkflow>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileReference {
    id: String,
    path: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Permissions {
    local_files: PermissionMode,
    shell: PermissionMode,
    erp_read: PermissionMode,
    erp_write: PermissionMode,
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum PermissionMode {
    Deny,
    Allow,
    Approval,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServerWorkflow {
    id: String,
    name: String,
    workflow_type: String,
    version: String,
    #[serde(default)]
    inputs: Vec<ServerWorkflowInput>,
    #[serde(default)]
    steps: Vec<ServerWorkflowStep>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServerWorkflowInput {
    name: String,
    label: String,
    #[serde(rename = "type")]
    input_type: String,
    required: bool,
    #[serde(default)]
    description: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServerWorkflowStep {
    id: String,
    tool: String,
    #[serde(default)]
    arguments: serde_json::Map<String, serde_json::Value>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstallRecord {
    package_sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledExpertKit {
    manifest: ExpertKitManifest,
    install_path: String,
}

pub struct ExpertKitHarnessProfile {
    pub skill_directories: Vec<String>,
    pub allowed_erp_tools: Vec<String>,
    pub required_erp_tools: Vec<String>,
    pub allow_local_files: bool,
    pub allow_shell: bool,
    pub allow_erp_write: bool,
    pub prompt: String,
}

#[tauri::command]
pub fn list_installed_expert_kits(
    app: tauri::AppHandle,
) -> Result<Vec<InstalledExpertKit>, String> {
    let root = expert_kits_root(&app)?;
    if !root.exists() {
        return Ok(Vec::new());
    }

    let mut installed = Vec::new();
    for kit_directory in child_directories(&root)? {
        let Some(directory_name) = kit_directory.file_name().and_then(|value| value.to_str())
        else {
            continue;
        };
        if directory_name.starts_with('.') {
            continue;
        }
        for version_directory in child_directories(&kit_directory)? {
            if let (Ok(manifest), Ok(record)) = (
                load_and_validate_manifest(&version_directory, None, None),
                load_install_record(&version_directory),
            ) && validate_sha256(&record.package_sha256).is_ok()
            {
                installed.push(installed_kit(manifest, &version_directory));
            }
        }
    }
    installed.sort_by(|left, right| {
        left.manifest
            .id
            .cmp(&right.manifest.id)
            .then_with(|| compare_versions(&right.manifest.version, &left.manifest.version))
    });
    Ok(installed)
}

#[tauri::command]
pub async fn install_expert_kit(
    app: tauri::AppHandle,
    request: ExpertKitInstallRequest,
) -> Result<InstalledExpertKit, String> {
    validate_identifier(&request.id)?;
    Version::parse(&request.version).map_err(|error| format!("专家套件版本无效：{error}"))?;
    validate_sha256(&request.sha256)?;
    ensure_supported_desktop_version(None)?;

    let root = expert_kits_root(&app)?;
    let final_directory = root.join(&request.id).join(&request.version);
    if final_directory.exists() {
        let manifest = load_and_validate_manifest(
            &final_directory,
            Some(&request.id),
            Some(&request.version),
        )?;
        let record = load_install_record(&final_directory)?;
        if record.package_sha256 != request.sha256.to_ascii_lowercase() {
            return Err("本地同版本套件与控制中心摘要不一致，请联系管理员".to_string());
        }
        return Ok(installed_kit(manifest, &final_directory));
    }

    let bytes = download_package(&request.url).await?;
    let digest = format!("{:x}", Sha256::digest(&bytes));
    if digest != request.sha256.to_ascii_lowercase() {
        return Err("专家套件 SHA-256 校验失败，安装已取消".to_string());
    }

    fs::create_dir_all(&root).map_err(|error| format!("无法创建专家套件目录：{error}"))?;
    let staging_directory = staging_directory(&root, &request.id, &request.version);
    fs::create_dir(&staging_directory).map_err(|error| format!("无法创建安装暂存目录：{error}"))?;

    let result = (|| {
        extract_package(&bytes, &staging_directory)?;
        let manifest = load_and_validate_manifest(
            &staging_directory,
            Some(&request.id),
            Some(&request.version),
        )?;
        ensure_supported_desktop_version(Some(&manifest.minimum_desktop_version))?;
        write_install_record(&staging_directory, &digest)?;
        let parent = final_directory
            .parent()
            .ok_or_else(|| "专家套件安装路径无效".to_string())?;
        fs::create_dir_all(parent).map_err(|error| format!("无法创建套件版本目录：{error}"))?;
        fs::rename(&staging_directory, &final_directory)
            .map_err(|error| format!("无法完成专家套件安装：{error}"))?;
        Ok(installed_kit(manifest, &final_directory))
    })();

    if result.is_err() && staging_directory.exists() {
        let _ = fs::remove_dir_all(&staging_directory);
    }
    result
}

pub fn harness_profile(
    app: &tauri::AppHandle,
    selected_kit_id: Option<&str>,
    user_prompt: &str,
) -> Result<ExpertKitHarnessProfile, String> {
    let installed = list_installed_expert_kits(app.clone())?;
    let mut newest = std::collections::BTreeMap::<String, InstalledExpertKit>::new();
    for kit in installed {
        newest.entry(kit.manifest.id.clone()).or_insert(kit);
    }

    let mut skill_directories = Vec::new();
    let mut skill_ids = HashSet::new();
    for kit in newest.values() {
        let root = Path::new(&kit.install_path);
        for skill in &kit.manifest.skills {
            if !skill_ids.insert(skill.id.clone()) {
                return Err(format!("已安装专家套件存在重复 Skill ID：{}", skill.id));
            }
            let skill_path = root.join(&skill.path);
            let directory = if skill_path
                .file_name()
                .is_some_and(|name| name == "SKILL.md")
            {
                skill_path.parent().and_then(Path::parent)
            } else {
                skill_path.parent()
            }
            .ok_or_else(|| format!("Skill 路径无效：{}", skill.path))?;
            let directory = directory.to_string_lossy().into_owned();
            if !skill_directories.contains(&directory) {
                skill_directories.push(directory);
            }
        }
    }

    let Some(selected_kit_id) = selected_kit_id else {
        return Ok(ExpertKitHarnessProfile {
            skill_directories,
            allowed_erp_tools: Vec::new(),
            required_erp_tools: Vec::new(),
            allow_local_files: true,
            allow_shell: true,
            allow_erp_write: false,
            prompt: user_prompt.to_string(),
        });
    };
    let kit = newest
        .get(selected_kit_id)
        .ok_or_else(|| format!("专家套件尚未安装：{selected_kit_id}"))?;
    let office_tools = kit
        .manifest
        .required_tools
        .iter()
        .filter(|tool| tool.starts_with("office."))
        .cloned()
        .collect::<Vec<_>>();
    let unsupported_office_tools = office_tools
        .iter()
        .filter(|tool| !DESKTOP_OFFICE_TOOLS.contains(&tool.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if !unsupported_office_tools.is_empty() {
        return Err(format!(
            "专家套件声明了桌面不支持的 Office 工具：{}",
            unsupported_office_tools.join(", ")
        ));
    }
    if !office_tools.is_empty() && kit.manifest.permissions.local_files == PermissionMode::Deny {
        return Err("该专家套件声明了 Office 工具，但禁止本地文件权限".to_string());
    }
    let erp_tools = kit
        .manifest
        .required_tools
        .iter()
        .filter(|tool| !tool.starts_with("office."))
        .cloned()
        .collect::<Vec<_>>();
    if !erp_tools.is_empty()
        && kit.manifest.permissions.erp_read == PermissionMode::Deny
        && kit.manifest.permissions.erp_write == PermissionMode::Deny
    {
        return Err("该专家套件声明了 ERP 工具，但禁止 ERP 权限".to_string());
    }
    let commands = load_command_context(kit)?;
    let skills = kit
        .manifest
        .skills
        .iter()
        .map(|skill| skill.id.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let prompt = format!(
        "你正在使用公司专家套件《{}》（ID: {}，版本: {}）。\n可用技能：{}。需要时必须先通过 skill 工具加载对应技能。{}\n\n员工任务：\n{}",
        kit.manifest.name, kit.manifest.id, kit.manifest.version, skills, commands, user_prompt,
    );
    Ok(ExpertKitHarnessProfile {
        skill_directories,
        allowed_erp_tools: erp_tools.clone(),
        required_erp_tools: erp_tools,
        allow_local_files: kit.manifest.permissions.local_files != PermissionMode::Deny,
        allow_shell: kit.manifest.permissions.shell != PermissionMode::Deny,
        allow_erp_write: kit.manifest.permissions.erp_write != PermissionMode::Deny,
        prompt,
    })
}

fn load_command_context(kit: &InstalledExpertKit) -> Result<String, String> {
    if kit.manifest.commands.is_empty() {
        return Ok(String::new());
    }
    let root = Path::new(&kit.install_path);
    let mut context = String::from("\n套件命令说明：");
    for command in &kit.manifest.commands {
        let content = fs::read_to_string(root.join(&command.path))
            .map_err(|error| format!("无法读取专家套件命令 {}：{error}", command.id))?;
        if content.len() > 256 * 1024 {
            return Err(format!("专家套件命令文件过大：{}", command.id));
        }
        context.push_str(&format!("\n\n/{}\n{}", command.id, content));
    }
    Ok(context)
}

fn load_install_record(root: &Path) -> Result<InstallRecord, String> {
    let value = fs::read_to_string(root.join(INSTALL_RECORD_PATH))
        .map_err(|_| "本地专家套件缺少可信安装记录".to_string())?;
    serde_json::from_str(&value).map_err(|error| format!("专家套件安装记录无效：{error}"))
}

fn write_install_record(root: &Path, sha256: &str) -> Result<(), String> {
    let value = serde_json::to_vec_pretty(&InstallRecord {
        package_sha256: sha256.to_string(),
    })
    .map_err(|error| format!("无法生成专家套件安装记录：{error}"))?;
    fs::write(root.join(INSTALL_RECORD_PATH), value)
        .map_err(|error| format!("无法保存专家套件安装记录：{error}"))
}

fn expert_kits_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("expert-kits"))
        .map_err(|error| format!("无法确定专家套件目录：{error}"))
}

async fn download_package(url: &str) -> Result<Vec<u8>, String> {
    let parsed = reqwest::Url::parse(url).map_err(|error| format!("套件下载地址无效：{error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("专家套件只允许从 HTTP(S) 地址下载".to_string());
    }
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .map_err(|error| format!("无法创建套件下载客户端：{error}"))?
        .get(parsed)
        .send()
        .await
        .map_err(|error| format!("专家套件下载失败：{error}"))?
        .error_for_status()
        .map_err(|error| format!("专家套件下载失败：{error}"))?;
    if response
        .content_length()
        .is_some_and(|size| size > MAX_PACKAGE_BYTES as u64)
    {
        return Err("专家套件超过 32 MiB 限制".to_string());
    }

    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("读取专家套件失败：{error}"))?;
        if bytes.len() + chunk.len() > MAX_PACKAGE_BYTES {
            return Err("专家套件超过 32 MiB 限制".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn extract_package(bytes: &[u8], destination: &Path) -> Result<(), String> {
    let decoder = GzDecoder::new(Cursor::new(bytes));
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|error| format!("专家套件压缩包无效：{error}"))?;
    let mut count = 0usize;
    let mut extracted_bytes = 0u64;

    for entry in entries {
        count += 1;
        if count > MAX_ARCHIVE_ENTRIES {
            return Err("专家套件文件数量超过限制".to_string());
        }
        let mut entry = entry.map_err(|error| format!("读取专家套件条目失败：{error}"))?;
        let entry_type = entry.header().entry_type();
        if !entry_type.is_file() && !entry_type.is_dir() {
            return Err("专家套件不能包含符号链接或特殊文件".to_string());
        }
        let path = entry
            .path()
            .map_err(|error| format!("专家套件路径无效：{error}"))?
            .into_owned();
        validate_relative_path(&path)?;
        let output = destination.join(&path);

        if entry_type.is_dir() {
            fs::create_dir_all(&output).map_err(|error| format!("无法创建套件目录：{error}"))?;
            continue;
        }
        let size = entry
            .header()
            .size()
            .map_err(|error| format!("套件文件大小无效：{error}"))?;
        extracted_bytes = extracted_bytes
            .checked_add(size)
            .ok_or_else(|| "专家套件解压大小无效".to_string())?;
        if extracted_bytes > MAX_EXTRACTED_BYTES {
            return Err("专家套件解压后超过 64 MiB 限制".to_string());
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("无法创建套件文件目录：{error}"))?;
        }
        let mut file =
            File::create(&output).map_err(|error| format!("无法创建套件文件：{error}"))?;
        std::io::copy(&mut entry, &mut file)
            .map_err(|error| format!("无法写入套件文件：{error}"))?;
    }
    Ok(())
}

fn load_and_validate_manifest(
    root: &Path,
    expected_id: Option<&str>,
    expected_version: Option<&str>,
) -> Result<ExpertKitManifest, String> {
    let manifest_path = root.join(MANIFEST_PATH);
    let file = File::open(&manifest_path).map_err(|_| "专家套件缺少 Manifest".to_string())?;
    let mut json = String::new();
    file.take(1024 * 1024)
        .read_to_string(&mut json)
        .map_err(|error| format!("无法读取专家套件 Manifest：{error}"))?;
    let manifest: ExpertKitManifest =
        serde_json::from_str(&json).map_err(|error| format!("专家套件 Manifest 无效：{error}"))?;

    if manifest.schema_version != "1" {
        return Err("不支持的专家套件 Schema 版本".to_string());
    }
    validate_identifier(&manifest.id)?;
    Version::parse(&manifest.version).map_err(|error| format!("专家套件版本无效：{error}"))?;
    if expected_id.is_some_and(|id| id != manifest.id) {
        return Err("专家套件 ID 与目录记录不一致".to_string());
    }
    if expected_version.is_some_and(|version| version != manifest.version) {
        return Err("专家套件版本与目录记录不一致".to_string());
    }
    if manifest.name.trim().is_empty()
        || manifest.summary.trim().is_empty()
        || manifest.skills.is_empty()
    {
        return Err("专家套件名称、简介和 Skills 不能为空".to_string());
    }

    let mut reference_ids = HashSet::new();
    for reference in manifest.commands.iter().chain(&manifest.skills) {
        if reference.id.trim().is_empty() || !reference_ids.insert(&reference.id) {
            return Err("专家套件命令和 Skill ID 不能为空或重复".to_string());
        }
        let path = Path::new(&reference.path);
        validate_relative_path(path)?;
        if !root.join(path).is_file() {
            return Err(format!("专家套件引用文件不存在：{}", reference.path));
        }
    }
    let mut tools = HashSet::new();
    for tool in &manifest.required_tools {
        if !valid_tool_name(tool) || !tools.insert(tool) {
            return Err(format!("专家套件工具声明无效：{tool}"));
        }
        if tool.starts_with("office.") && !DESKTOP_OFFICE_TOOLS.contains(&tool.as_str()) {
            return Err(format!("桌面不支持该 Office 工具：{tool}"));
        }
    }
    let mut connectors = HashSet::new();
    for connector in &manifest.connector_refs {
        if validate_identifier(connector).is_err() || !connectors.insert(connector) {
            return Err(format!("专家套件连接器引用无效：{connector}"));
        }
    }
    Ok(manifest)
}

fn ensure_supported_desktop_version(minimum: Option<&str>) -> Result<(), String> {
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

fn validate_identifier(value: &str) -> Result<(), String> {
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

fn validate_sha256(value: &str) -> Result<(), String> {
    if value.len() == 64 && value.bytes().all(|character| character.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("专家套件 SHA-256 无效".to_string())
    }
}

fn validate_relative_path(path: &Path) -> Result<(), String> {
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("专家套件包含不安全路径".to_string());
    }
    Ok(())
}

fn valid_tool_name(value: &str) -> bool {
    !value.is_empty()
        && value.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && value.bytes().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, b'_' | b'.' | b'-')
        })
}

fn child_directories(root: &Path) -> Result<Vec<PathBuf>, String> {
    Ok(fs::read_dir(root)
        .map_err(|error| format!("无法读取专家套件目录：{error}"))?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            entry
                .file_type()
                .ok()
                .filter(|kind| kind.is_dir())
                .map(|_| entry.path())
        })
        .collect::<Vec<_>>())
}

fn installed_kit(manifest: ExpertKitManifest, directory: &Path) -> InstalledExpertKit {
    InstalledExpertKit {
        manifest,
        install_path: directory.to_string_lossy().into_owned(),
    }
}

fn staging_directory(root: &Path, id: &str, version: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    root.join(format!(
        ".install-{id}-{version}-{}-{nanos}",
        std::process::id()
    ))
}

fn compare_versions(left: &str, right: &str) -> std::cmp::Ordering {
    match (Version::parse(left), Version::parse(right)) {
        (Ok(left), Ok(right)) => left.cmp(&right),
        _ => left.cmp(right),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{Compression, write::GzEncoder};
    use std::io::Write;

    #[test]
    fn unsafe_paths_are_rejected() {
        assert!(validate_relative_path(Path::new("skills/report/SKILL.md")).is_ok());
        assert!(validate_relative_path(Path::new("../outside")).is_err());
        assert!(validate_relative_path(Path::new("/absolute")).is_err());
        assert!(validate_relative_path(Path::new("skills/./SKILL.md")).is_ok());
    }

    #[test]
    fn identifiers_and_tool_names_follow_the_manifest_contract() {
        assert!(validate_identifier("crossborder-operations").is_ok());
        assert!(validate_identifier("CrossBorder").is_err());
        assert!(valid_tool_name("office.xlsx.create"));
        assert!(!valid_tool_name("Office create"));
        assert!(DESKTOP_OFFICE_TOOLS.contains(&"office.xlsx.create"));
        assert!(!DESKTOP_OFFICE_TOOLS.contains(&"office.pptx.create"));
    }

    #[test]
    fn manifest_is_loaded_and_references_are_checked() {
        let root = std::env::temp_dir().join(format!(
            "xiaoyin-expert-kit-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join(".xiaoyin-plugin")).unwrap();
        fs::create_dir_all(root.join("skills/report")).unwrap();
        fs::write(root.join("skills/report/SKILL.md"), "# Report").unwrap();
        fs::write(
            root.join(MANIFEST_PATH),
            r#"{
              "schemaVersion":"1","id":"report-kit","name":"日报","version":"1.0.0",
              "summary":"生成日报","skills":[{"id":"report","path":"skills/report/SKILL.md"}],
              "requiredTools":["sales_summary"],
              "permissions":{"localFiles":"approval","shell":"deny","erpRead":"allow","erpWrite":"approval"}
            }"#,
        )
        .unwrap();

        let manifest =
            load_and_validate_manifest(&root, Some("report-kit"), Some("1.0.0")).unwrap();
        assert_eq!(manifest.id, "report-kit");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn real_tar_gzip_package_is_safely_extracted_and_validated() {
        let manifest = r#"{
          "schemaVersion":"1","id":"report-kit","name":"日报","version":"1.0.0",
          "summary":"生成日报","skills":[{"id":"report","path":"skills/report/SKILL.md"}],
          "permissions":{"localFiles":"approval","shell":"deny","erpRead":"allow","erpWrite":"approval"}
        }"#;
        let encoder = GzEncoder::new(Vec::new(), Compression::default());
        let mut archive = tar::Builder::new(encoder);
        append_archive_file(&mut archive, MANIFEST_PATH, manifest.as_bytes());
        append_archive_file(&mut archive, "skills/report/SKILL.md", b"# Report");
        let encoder = archive.into_inner().unwrap();
        let package = encoder.finish().unwrap();
        let root = std::env::temp_dir().join(format!(
            "xiaoyin-extract-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();

        extract_package(&package, &root).unwrap();
        let loaded = load_and_validate_manifest(&root, Some("report-kit"), Some("1.0.0")).unwrap();
        assert_eq!(loaded.skills[0].id, "report");
        fs::remove_dir_all(root).unwrap();
    }

    fn append_archive_file<W: Write>(archive: &mut tar::Builder<W>, path: &str, bytes: &[u8]) {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        archive.append_data(&mut header, path, bytes).unwrap();
    }
}
