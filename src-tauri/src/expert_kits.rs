#[cfg(test)]
mod acceptance;
mod archive;
mod compatibility;
mod inventory;
mod manifest;
pub mod workbench;

use archive::{extract_package, package_root};
use flate2::{Compression, write::GzEncoder};
use futures_util::StreamExt;
#[cfg(test)]
use manifest::valid_tool_name;
use manifest::{
    ensure_supported_desktop_version, load_and_validate_manifest, valid_knowledge_base_reference,
    validate_identifier, validate_relative_path, validate_sha256,
};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::Write,
    path::{Component, Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

const MAX_PACKAGE_BYTES: usize = 32 * 1024 * 1024;
const KIT_MANIFEST_PATH: &str = ".xiaoyin-kit/kit.json";
const SKILL_MANIFEST_PATH: &str = ".xiaoyin-skill/skill.json";
const INSTALL_RECORD_PATH: &str = ".xiaoyin/install.json";
const DESKTOP_COMPUTER_TOOLS: [&str; 5] = [
    "computer_use_observe",
    "computer_use_click",
    "computer_use_type",
    "computer_use_key",
    "computer_use_scroll",
];
const EXTENSION_CATEGORIES: [&str; 20] = [
    "office-productivity",
    "content-creation",
    "marketing",
    "ecommerce-retail",
    "finance",
    "legal",
    "recruiting",
    "code-development",
    "code-review",
    "security-testing",
    "database-analysis",
    "operations-deployment",
    "developer-tools",
    "design",
    "product-management",
    "knowledge-research",
    "workflow",
    "agent-evolution",
    "communication",
    "other",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpertKitInstallRequest {
    kind: String,
    id: String,
    version: String,
    sha256: String,
    url: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AllowedExtensionArtifact {
    kind: String,
    id: String,
    version: String,
    sha256: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpertKitManifest {
    schema_version: String,
    kind: String,
    id: String,
    name: String,
    version: String,
    summary: String,
    #[serde(default = "default_extension_category")]
    category: String,
    #[serde(default)]
    triggers: Vec<String>,
    #[serde(default)]
    minimum_desktop_version: String,
    #[serde(default)]
    commands: Vec<FileReference>,
    skills: Vec<FileReference>,
    #[serde(default)]
    required_tools: Vec<String>,
    #[serde(default)]
    connector_refs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    knowledge_base_refs: Option<Vec<String>>,
    #[serde(default)]
    server_workflows: Vec<ServerWorkflow>,
}

fn default_extension_category() -> String {
    "other".to_string()
}

#[derive(Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileReference {
    id: String,
    path: String,
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
    connector_id: String,
    tool: String,
    #[serde(default)]
    arguments: serde_json::Map<String, serde_json::Value>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum InstallSource {
    Catalog,
    Developer,
}

fn catalog_install_source() -> InstallSource {
    InstallSource::Catalog
}

fn is_catalog_install_source(source: &InstallSource) -> bool {
    *source == InstallSource::Catalog
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstallRecord {
    package_sha256: String,
    #[serde(
        default = "catalog_install_source",
        skip_serializing_if = "is_catalog_install_source"
    )]
    source: InstallSource,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledExpertKit {
    enabled: bool,
    manifest: ExpertKitManifest,
    install_path: String,
    source: InstallSource,
    package_sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    bundled_connectors: Option<serde_json::Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledExtensionIssue {
    coordinate: String,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledExtensionInventory {
    installed: Vec<InstalledExpertKit>,
    issues: Vec<InstalledExtensionIssue>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDeveloperExtensionRequest {
    manifest: ExpertKitManifest,
    instructions: String,
    #[serde(default)]
    skill_sources: Vec<DeveloperSkillSource>,
    #[serde(default)]
    base: Option<DeveloperSkillSource>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeveloperSkillSource {
    id: String,
    version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeveloperExtensionPackage {
    installed: InstalledExpertKit,
    bytes: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeveloperExtensionDraft {
    manifest: ExpertKitManifest,
    instructions: String,
}

pub struct ExpertKitHarnessProfile {
    pub skill_directories: Vec<String>,
    pub knowledge_base_refs: Option<Vec<String>>,
    pub required_connector_tools: Vec<String>,
    pub allowed_computer_tools: Vec<String>,
    pub prompt: String,
}

#[tauri::command]
pub fn list_installed_expert_kits(
    app: tauri::AppHandle,
) -> Result<InstalledExtensionInventory, String> {
    inventory::scan_installed_extensions(&app)
}

#[tauri::command]
pub async fn install_expert_kit(
    app: tauri::AppHandle,
    request: ExpertKitInstallRequest,
) -> Result<InstalledExpertKit, String> {
    validate_artifact_kind(&request.kind)?;
    validate_identifier(&request.id)?;
    Version::parse(&request.version).map_err(|error| format!("专家套件版本无效：{error}"))?;
    validate_sha256(&request.sha256)?;
    ensure_supported_desktop_version(None)?;

    let root = extensions_root(&app)?.join(&request.kind);
    let final_directory = root.join(&request.id).join(&request.version);
    if final_directory.exists() {
        let manifest = load_and_validate_manifest(
            &final_directory,
            Some(&request.kind),
            Some(&request.id),
            Some(&request.version),
        )?;
        let record = load_install_record(&final_directory)?;
        if record.package_sha256 != request.sha256.to_ascii_lowercase() {
            return Err("本地同版本套件与控制中心摘要不一致，请联系管理员".to_string());
        }
        return Ok(installed_kit(manifest, &final_directory, record.source));
    }

    let bytes = download_package(&request.url).await?;
    install_package_bytes(
        &root,
        &bytes,
        Some(&request.kind),
        Some(&request.id),
        Some(&request.version),
        Some(&request.sha256),
        InstallSource::Catalog,
    )
}

#[tauri::command]
pub async fn select_developer_extension(
    app: tauri::AppHandle,
    kind: String,
    input: Option<String>,
) -> Result<Option<String>, String> {
    if kind != "expert-kit" && kind != "skill" {
        return Err("仅支持导入专家套件或技能".to_string());
    }
    let dialog_app = app.clone();
    let dialog_kind = kind.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        let (title, filter) = if dialog_kind == "skill" {
            ("导入本地技能", "小胤技能")
        } else {
            ("导入本地专家套件", "小胤专家套件")
        };
        let picker = dialog_app
            .dialog()
            .file()
            .set_title(title)
            .add_filter(filter, &["zip", "gz", "md"]);
        if input.as_deref() == Some("directory") {
            picker.blocking_pick_folder()
        } else {
            picker.blocking_pick_file()
        }
    })
    .await
    .map_err(|error| format!("打开专家套件选择器失败：{error}"))?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|error| format!("选择的专家套件路径无效：{error}"))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn install_developer_extension(
    app: tauri::AppHandle,
    kind: String,
    input: Option<String>,
    path: Option<String>,
) -> Result<Option<InstalledExpertKit>, String> {
    if kind != "expert-kit" && kind != "skill" {
        return Err("仅支持导入专家套件或技能".to_string());
    }
    let selected = match path {
        Some(path) => Some(path),
        None => select_developer_extension(app.clone(), kind.clone(), input).await?,
    };
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = std::path::PathBuf::from(selected);
    let metadata = fs::metadata(&path).map_err(|error| format!("无法读取专家套件：{error}"))?;
    if metadata.is_file() && metadata.len() > MAX_PACKAGE_BYTES as u64 {
        return Err("本地专家套件不是普通文件或超过 32 MiB 限制".to_string());
    }
    let bytes = if metadata.is_dir() {
        validate_directory_package(&path)?;
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        append_directory_to_zip(
            &mut zip,
            &path,
            &path,
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )?;
        zip.finish()
            .map_err(|error| error.to_string())?
            .into_inner()
    } else if path.file_name().is_some_and(|name| name == "SKILL.md") {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        zip.start_file("SKILL.md", zip::write::SimpleFileOptions::default())
            .map_err(|error| error.to_string())?;
        zip.write_all(&fs::read(&path).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
        zip.finish()
            .map_err(|error| error.to_string())?
            .into_inner()
    } else {
        fs::read(&path).map_err(|error| format!("无法读取专家套件：{error}"))?
    };
    install_package_bytes(
        &extensions_root(&app)?.join(&kind),
        &bytes,
        Some(&kind),
        None,
        None,
        None,
        InstallSource::Developer,
    )
    .map(Some)
}

#[tauri::command]
pub fn create_developer_extension(
    app: tauri::AppHandle,
    request: CreateDeveloperExtensionRequest,
) -> Result<DeveloperExtensionPackage, String> {
    let manifest = request.manifest;
    let payload_files = if let Some(base) = request.base {
        validate_artifact_kind(&manifest.kind)?;
        validate_identifier(&base.id)?;
        Version::parse(&base.version).map_err(|error| error.to_string())?;
        let directory = extensions_root(&app)?
            .join(&manifest.kind)
            .join(&base.id)
            .join(&base.version);
        let draft =
            read_developer_extension(app.clone(), manifest.kind.clone(), base.id, base.version)?;
        if manifest.skills != draft.manifest.skills || manifest.commands != draft.manifest.commands
        {
            return Err("编辑执行说明时不能改变套件资源结构，请使用定制目录修改".into());
        }
        let mut files = Vec::new();
        collect_payload_files(&directory, &directory, Path::new(""), &mut files)?;
        let instruction = if manifest.kind == "skill" {
            "SKILL.md"
        } else {
            &manifest.skills[0].path
        };
        files.retain(|(path, _)| path != instruction);
        files
    } else {
        load_composed_skill_files(&app, &manifest, &request.skill_sources)?
    };
    let bytes = build_developer_package(&manifest, &request.instructions, &payload_files)?;
    let installed = install_package_bytes(
        &extensions_root(&app)?.join(&manifest.kind),
        &bytes,
        Some(&manifest.kind),
        Some(&manifest.id),
        Some(&manifest.version),
        None,
        InstallSource::Developer,
    )?;
    Ok(DeveloperExtensionPackage { installed, bytes })
}

fn build_developer_package(
    manifest: &ExpertKitManifest,
    instructions: &str,
    payload_files: &[(String, Vec<u8>)],
) -> Result<Vec<u8>, String> {
    validate_artifact_kind(&manifest.kind)?;
    let manifest_path = if manifest.kind == "skill" {
        SKILL_MANIFEST_PATH
    } else {
        KIT_MANIFEST_PATH
    };
    let instruction_path = if manifest.kind == "skill" {
        "SKILL.md".to_string()
    } else {
        let skill = manifest
            .skills
            .first()
            .ok_or_else(|| "专家套件至少需要一个技能".to_string())?;
        skill.path.clone()
    };
    let mut manifest_value =
        serde_json::to_value(manifest).map_err(|error| format!("无法生成扩展清单：{error}"))?;
    let manifest_object = manifest_value
        .as_object_mut()
        .ok_or_else(|| "扩展清单必须是 JSON 对象".to_string())?;
    manifest_object.remove("kind");
    if manifest.kind == "skill" {
        manifest_object.remove("commands");
        manifest_object.remove("skills");
        manifest_object.remove("serverWorkflows");
    }
    let manifest_bytes = serde_json::to_vec_pretty(&manifest_value)
        .map_err(|error| format!("无法生成扩展清单：{error}"))?;
    let encoder = GzEncoder::new(Vec::new(), Compression::default());
    let mut archive = tar::Builder::new(encoder);
    append_generated_file(&mut archive, manifest_path, &manifest_bytes)?;
    if !payload_files
        .iter()
        .any(|(path, _)| path == &instruction_path)
    {
        append_generated_file(&mut archive, &instruction_path, instructions.as_bytes())?;
    }
    for command in &manifest.commands {
        if !payload_files.iter().any(|(path, _)| path == &command.path) {
            append_generated_file(&mut archive, &command.path, b"Follow this expert kit's skills and delivery standards to complete the user's task.\n\n$ARGUMENTS")?;
        }
    }
    for (path, bytes) in payload_files {
        append_generated_file(&mut archive, path, bytes)?;
    }
    let encoder = archive
        .into_inner()
        .map_err(|error| format!("无法生成扩展制品：{error}"))?;
    encoder
        .finish()
        .map_err(|error| format!("无法压缩扩展制品：{error}"))
}

fn load_composed_skill_files(
    app: &tauri::AppHandle,
    manifest: &ExpertKitManifest,
    sources: &[DeveloperSkillSource],
) -> Result<Vec<(String, Vec<u8>)>, String> {
    if sources.is_empty() {
        return Ok(Vec::new());
    }
    if manifest.kind != "expert-kit"
        || !(sources.len() == manifest.skills.len()
            || (sources.len() + 1 == manifest.skills.len()
                && manifest
                    .skills
                    .first()
                    .is_some_and(|skill| skill.path == "skills/kit-guide/SKILL.md")))
    {
        return Err("专家套件的技能来源与清单不一致".to_string());
    }
    let root = extensions_root(app)?.join("skill");
    let mut ids = HashSet::new();
    let mut files = Vec::new();
    for source in sources {
        validate_identifier(&source.id)?;
        Version::parse(&source.version).map_err(|error| format!("技能版本无效：{error}"))?;
        if !ids.insert(source.id.as_str()) {
            return Err(format!("重复选择了技能：{}", source.id));
        }
        let reference = manifest
            .skills
            .iter()
            .find(|reference| reference.id == source.id)
            .ok_or_else(|| format!("技能未写入专家套件清单：{}", source.id))?;
        let directory = root.join(&source.id).join(&source.version);
        load_and_validate_manifest(
            &directory,
            Some("skill"),
            Some(&source.id),
            Some(&source.version),
        )?;
        collect_payload_files(
            &directory,
            &directory,
            Path::new(&format!("skills/{}", source.id)),
            &mut files,
        )?;
        if !files.iter().any(|(path, _)| path == &reference.path) {
            return Err(format!("技能 {} 缺少入口文件", source.id));
        }
    }
    Ok(files)
}

fn collect_payload_files(
    root: &Path,
    directory: &Path,
    target_prefix: &Path,
    files: &mut Vec<(String, Vec<u8>)>,
) -> Result<(), String> {
    let mut entries = fs::read_dir(directory)
        .map_err(|error| format!("无法读取扩展资源：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法读取扩展资源：{error}"))?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "扩展资源路径无效".to_string())?;
        let first = relative.components().next();
        if matches!(first, Some(Component::Normal(name)) if name == ".xiaoyin")
            || relative == Path::new(KIT_MANIFEST_PATH)
            || relative == Path::new(SKILL_MANIFEST_PATH)
        {
            continue;
        }
        validate_relative_path(relative)?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("无法检查扩展资源类型：{error}"))?;
        if file_type.is_symlink() || !file_type.is_file() && !file_type.is_dir() {
            return Err(format!("扩展包含不支持的资源类型：{}", relative.display()));
        }
        if file_type.is_dir() {
            collect_payload_files(root, &path, target_prefix, files)?;
            continue;
        }
        if files.len() >= 2048 {
            return Err("扩展资源文件不能超过 2048 个".to_string());
        }
        let target = target_prefix.join(relative);
        validate_relative_path(&target)?;
        let bytes = fs::read(&path).map_err(|error| format!("无法读取扩展资源：{error}"))?;
        files.push((target.to_string_lossy().replace('\\', "/"), bytes));
    }
    Ok(())
}

#[tauri::command]
pub fn read_developer_extension(
    app: tauri::AppHandle,
    kind: String,
    id: String,
    version: String,
) -> Result<DeveloperExtensionDraft, String> {
    validate_artifact_kind(&kind)?;
    validate_identifier(&id)?;
    Version::parse(&version).map_err(|error| format!("扩展版本无效：{error}"))?;
    let directory = extensions_root(&app)?.join(&kind).join(&id).join(&version);
    let record = load_install_record(&directory)?;
    if record.source != InstallSource::Developer {
        return Err("只能编辑本机创建的扩展".to_string());
    }
    let manifest = load_and_validate_manifest(&directory, Some(&kind), Some(&id), Some(&version))?;
    let instruction_path = if kind == "skill" {
        directory.join("SKILL.md")
    } else {
        let skill = manifest
            .skills
            .first()
            .ok_or_else(|| "专家套件至少需要一个技能".to_string())?;
        validate_relative_path(Path::new(&skill.path))?;
        directory.join(&skill.path)
    };
    let instructions = fs::read_to_string(&instruction_path)
        .map_err(|error| format!("无法读取扩展说明：{error}"))?;
    Ok(DeveloperExtensionDraft {
        manifest,
        instructions,
    })
}

#[tauri::command]
pub fn package_developer_extension(
    app: tauri::AppHandle,
    kind: String,
    id: String,
    version: String,
) -> Result<DeveloperExtensionPackage, String> {
    let directory = extensions_root(&app)?.join(&kind).join(&id).join(&version);
    let draft = read_developer_extension(app, kind, id, version)?;
    let mut payload_files = Vec::new();
    collect_payload_files(&directory, &directory, Path::new(""), &mut payload_files)?;
    let bytes = build_developer_package(&draft.manifest, &draft.instructions, &payload_files)?;
    Ok(DeveloperExtensionPackage {
        installed: installed_kit(draft.manifest, &directory, InstallSource::Developer),
        bytes,
    })
}

fn append_generated_file<W: Write>(
    archive: &mut tar::Builder<W>,
    path: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    archive
        .append_data(&mut header, path, bytes)
        .map_err(|error| format!("无法写入扩展制品：{error}"))
}

#[tauri::command]
pub async fn customize_expert_kit(
    app: tauri::AppHandle,
    id: String,
    version: String,
    kind: Option<String>,
) -> Result<Option<String>, String> {
    let kind = kind.as_deref().unwrap_or("expert-kit");
    validate_artifact_kind(kind)?;
    validate_identifier(&id)?;
    Version::parse(&version).map_err(|error| format!("专家套件版本无效：{error}"))?;
    let source = extensions_root(&app)?.join(kind).join(&id).join(&version);
    load_and_validate_manifest(&source, Some(kind), Some(&id), Some(&version))?;
    let dialog_app = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .set_title("选择定制副本工作目录")
            .blocking_pick_folder()
    })
    .await
    .map_err(|error| format!("打开目录选择器失败：{error}"))?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let destination = selected
        .into_path()
        .map_err(|error| format!("选择的目录无效：{error}"))?
        .join(format!("{}-custom", id));
    if destination.exists() {
        return Err("定制副本目录已存在".to_string());
    }
    if destination.starts_with(&source) {
        return Err("定制目录不能位于已安装套件内部".into());
    }
    copy_extension_tree(&source, &destination, true)?;
    let manifest_path = destination.join(if kind == "skill" {
        SKILL_MANIFEST_PATH
    } else {
        KIT_MANIFEST_PATH
    });
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_path).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    let new_id = compatibility::portable_id(&format!("{id}-custom"));
    manifest["id"] = serde_json::json!(new_id);
    compatibility::rekey_bundled_connectors(&destination, &mut manifest, &new_id)?;
    manifest["name"] = serde_json::json!(format!(
        "{} · 定制",
        manifest["name"].as_str().unwrap_or(&id)
    ));
    manifest["version"] = serde_json::json!("1.0.0");
    fs::write(manifest_path, serde_json::to_vec_pretty(&manifest).unwrap())
        .map_err(|error| error.to_string())?;
    Ok(Some(destination.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn export_expert_kit(
    app: tauri::AppHandle,
    id: String,
    version: String,
    kind: Option<String>,
) -> Result<Option<String>, String> {
    let kind = kind.as_deref().unwrap_or("expert-kit");
    validate_artifact_kind(kind)?;
    validate_identifier(&id)?;
    Version::parse(&version).map_err(|error| format!("专家套件版本无效：{error}"))?;
    let source = extensions_root(&app)?.join(kind).join(&id).join(&version);
    load_and_validate_manifest(&source, Some(kind), Some(&id), Some(&version))?;
    let file_name = format!("{}-{}.zip", id, version);
    let dialog_app = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .set_title("导出专家套件 ZIP")
            .set_file_name(&file_name)
            .add_filter("ZIP", &["zip"])
            .blocking_save_file()
    })
    .await
    .map_err(|error| format!("打开保存选择器失败：{error}"))?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let destination = selected
        .into_path()
        .map_err(|error| format!("保存路径无效：{error}"))?;
    write_extension_zip(&source, &destination)?;
    Ok(Some(destination.to_string_lossy().into_owned()))
}

fn copy_extension_tree(
    source: &Path,
    destination: &Path,
    skip_install_record: bool,
) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|error| format!("无法创建定制副本：{error}"))?;
    for entry in fs::read_dir(source).map_err(|error| format!("无法读取套件目录：{error}"))?
    {
        let entry = entry.map_err(|error| format!("无法读取套件文件：{error}"))?;
        let relative_name = entry.file_name();
        let child_source = entry.path();
        let child_destination = destination.join(&relative_name);
        if skip_install_record && child_source.ends_with(INSTALL_RECORD_PATH) {
            continue;
        }
        if entry
            .file_type()
            .map_err(|error| format!("无法读取套件文件类型：{error}"))?
            .is_dir()
        {
            copy_extension_tree(&child_source, &child_destination, skip_install_record)?;
        } else {
            fs::copy(&child_source, &child_destination)
                .map_err(|error| format!("无法复制套件文件：{error}"))?;
        }
    }
    let install_record = destination.join(INSTALL_RECORD_PATH);
    if skip_install_record && install_record.exists() {
        fs::remove_file(install_record).map_err(|error| format!("无法清理安装记录：{error}"))?;
    }
    Ok(())
}

fn write_extension_zip(source: &Path, destination: &Path) -> Result<(), String> {
    if destination.starts_with(source) {
        return Err("请将 ZIP 保存到套件目录之外".into());
    }
    validate_directory_package(source)?;
    let file = File::create(destination).map_err(|error| format!("无法创建 ZIP：{error}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    append_directory_to_zip(&mut zip, source, source, options)?;
    zip.finish()
        .map_err(|error| format!("无法完成 ZIP：{error}"))?;
    Ok(())
}

fn validate_directory_package(root: &Path) -> Result<(), String> {
    let mut pending = vec![(root.to_path_buf(), 0)];
    let mut files = 0;
    let mut bytes = 0u64;
    while let Some((directory, depth)) = pending.pop() {
        if depth > 32 {
            return Err("扩展目录层级超过 32 层".into());
        }
        for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let metadata = entry.metadata().map_err(|error| error.to_string())?;
            let file_type = entry.file_type().map_err(|error| error.to_string())?;
            if file_type.is_symlink() || !(file_type.is_file() || file_type.is_dir()) {
                return Err("扩展目录只支持普通文件和文件夹".into());
            }
            files += 1;
            if files > 1024 {
                return Err("扩展目录不能超过 1024 项".into());
            }
            if file_type.is_dir() {
                pending.push((entry.path(), depth + 1));
            } else {
                bytes += metadata.len();
            }
            if bytes > 64 * 1024 * 1024 {
                return Err("扩展资源不能超过 64 MiB".into());
            }
        }
    }
    Ok(())
}

fn append_directory_to_zip<W: std::io::Write + std::io::Seek>(
    zip: &mut zip::ZipWriter<W>,
    root: &Path,
    directory: &Path,
    options: zip::write::SimpleFileOptions,
) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|error| format!("无法读取套件目录：{error}"))?
    {
        let entry = entry.map_err(|error| format!("无法读取套件文件：{error}"))?;
        let path = entry.path();
        if entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_symlink()
        {
            return Err("扩展目录不能包含符号链接".into());
        }
        if path.ends_with(INSTALL_RECORD_PATH) {
            continue;
        }
        if entry
            .file_type()
            .map_err(|error| format!("无法读取套件文件类型：{error}"))?
            .is_dir()
        {
            append_directory_to_zip(zip, root, &path, options)?;
        } else {
            let name = path
                .strip_prefix(root)
                .map_err(|_| "套件导出路径无效".to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            zip.start_file(name, options)
                .map_err(|error| format!("无法写入 ZIP：{error}"))?;
            zip.write_all(&fs::read(&path).map_err(|error| format!("无法读取套件文件：{error}"))?)
                .map_err(|error| format!("无法写入 ZIP：{error}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn remove_developer_expert_kit(
    app: tauri::AppHandle,
    id: String,
    version: String,
) -> Result<(), String> {
    validate_identifier(&id)?;
    Version::parse(&version).map_err(|error| format!("专家套件版本无效：{error}"))?;
    let root = extensions_root(&app)?.join("expert-kit");
    let directory = root.join(&id).join(&version);
    let record = load_install_record(&directory)?;
    if record.source != InstallSource::Developer {
        return Err("只能通过开发者入口移除本地验收套件".to_string());
    }
    fs::remove_dir_all(&directory).map_err(|error| format!("无法移除本地验收套件：{error}"))?;
    let kit_directory = root.join(id);
    if kit_directory.exists()
        && fs::read_dir(&kit_directory)
            .map_err(|error| format!("无法检查专家套件目录：{error}"))?
            .next()
            .is_none()
    {
        fs::remove_dir(&kit_directory).map_err(|error| format!("无法清理专家套件目录：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn remove_developer_extension(
    app: tauri::AppHandle,
    kind: String,
    id: String,
    version: String,
) -> Result<(), String> {
    validate_artifact_kind(&kind)?;
    validate_identifier(&id)?;
    Version::parse(&version).map_err(|error| format!("扩展版本无效：{error}"))?;
    let root = extensions_root(&app)?.join(&kind);
    let directory = root.join(&id).join(&version);
    let record = load_install_record(&directory)?;
    if record.source != InstallSource::Developer {
        return Err("只能删除本机创建的扩展".to_string());
    }
    fs::remove_dir_all(&directory).map_err(|error| format!("无法删除本地扩展：{error}"))?;
    let extension_directory = root.join(id);
    if extension_directory.exists()
        && fs::read_dir(&extension_directory)
            .map_err(|error| format!("无法检查扩展目录：{error}"))?
            .next()
            .is_none()
    {
        fs::remove_dir(&extension_directory)
            .map_err(|error| format!("无法清理扩展目录：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn remove_catalog_extension(
    app: tauri::AppHandle,
    id: String,
    kind: String,
) -> Result<(), String> {
    validate_identifier(&id)?;
    validate_artifact_kind(&kind)?;
    let root = extensions_root(&app)?.join(&kind);
    let extension_directory = root.join(&id);
    remove_catalog_versions(&extension_directory, &kind, &id)
}

fn remove_catalog_versions(extension_directory: &Path, kind: &str, id: &str) -> Result<(), String> {
    if !extension_directory.exists() {
        return Ok(());
    }
    let mut removals = Vec::new();
    for version_directory in child_directories(extension_directory)? {
        let Ok(record) = load_install_record(&version_directory) else {
            continue;
        };
        if record.source != InstallSource::Catalog {
            continue;
        }
        let manifest = load_and_validate_manifest(&version_directory, Some(kind), Some(id), None)?;
        if manifest.kind != kind {
            return Err("本地扩展类型与卸载请求不一致".to_string());
        }
        removals.push(version_directory);
    }
    for version_directory in removals {
        fs::remove_dir_all(&version_directory)
            .map_err(|error| format!("无法卸载本地扩展：{error}"))?;
    }
    if extension_directory.exists()
        && fs::read_dir(extension_directory)
            .map_err(|error| format!("无法检查扩展目录：{error}"))?
            .next()
            .is_none()
    {
        fs::remove_dir(extension_directory)
            .map_err(|error| format!("无法清理扩展目录：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn remove_broken_extension(app: tauri::AppHandle, coordinate: String) -> Result<(), String> {
    let (kind, remainder) = coordinate
        .split_once(':')
        .ok_or_else(|| "损坏扩展坐标无效".to_string())?;
    let (id, version) = remainder
        .rsplit_once('@')
        .ok_or_else(|| "损坏扩展坐标无效".to_string())?;
    validate_artifact_kind(kind)?;
    validate_identifier(id)?;
    Version::parse(version).map_err(|error| format!("扩展版本无效：{error}"))?;
    let extension_directory = extensions_root(&app)?.join(kind).join(id);
    let version_directory = extension_directory.join(version);
    if version_directory.exists() {
        fs::remove_dir_all(&version_directory)
            .map_err(|error| format!("无法移除损坏扩展：{error}"))?;
    }
    if extension_directory.exists()
        && fs::read_dir(&extension_directory)
            .map_err(|error| format!("无法检查扩展目录：{error}"))?
            .next()
            .is_none()
    {
        fs::remove_dir(&extension_directory)
            .map_err(|error| format!("无法清理扩展目录：{error}"))?;
    }
    Ok(())
}

fn install_package_bytes(
    root: &Path,
    bytes: &[u8],
    expected_kind: Option<&str>,
    expected_id: Option<&str>,
    expected_version: Option<&str>,
    expected_sha256: Option<&str>,
    source: InstallSource,
) -> Result<InstalledExpertKit, String> {
    if bytes.is_empty() || bytes.len() > MAX_PACKAGE_BYTES {
        return Err("专家套件超过 32 MiB 限制".to_string());
    }
    let digest = format!("{:x}", Sha256::digest(bytes));
    if expected_sha256.is_some_and(|expected| digest != expected.to_ascii_lowercase()) {
        return Err("专家套件 SHA-256 校验失败，安装已取消".to_string());
    }
    fs::create_dir_all(root).map_err(|error| format!("无法创建专家套件目录：{error}"))?;
    let staging_directory = staging_directory(
        root,
        expected_id.unwrap_or("developer-kit"),
        expected_version.unwrap_or("local"),
    );
    fs::create_dir(&staging_directory).map_err(|error| format!("无法创建安装暂存目录：{error}"))?;

    let result = (|| {
        extract_package(bytes, &staging_directory)?;
        let package_directory = package_root(&staging_directory)?;
        if source == InstallSource::Developer {
            compatibility::normalize_package(&package_directory, expected_kind)?;
        }
        let manifest = load_and_validate_manifest(
            &package_directory,
            expected_kind,
            expected_id,
            expected_version,
        )?;
        ensure_supported_desktop_version(Some(&manifest.minimum_desktop_version))?;
        let final_directory = root.join(&manifest.id).join(&manifest.version);
        if final_directory.exists() {
            let existing_record = load_install_record(&final_directory)?;
            if existing_record.package_sha256 != digest {
                if source != InstallSource::Developer
                    || existing_record.source != InstallSource::Developer
                {
                    return Err(
                        "本地已存在内容不同的同版本套件，请提升 Manifest 版本后重试".to_string()
                    );
                }
                write_install_record(&package_directory, &digest, source)?;
                let backup = staging_directory.join("previous-version");
                fs::rename(&final_directory, &backup)
                    .map_err(|error| format!("无法暂存原本地扩展：{error}"))?;
                if let Err(error) = fs::rename(&package_directory, &final_directory) {
                    let _ = fs::rename(&backup, &final_directory);
                    return Err(format!("无法更新本地扩展：{error}"));
                }
                let _ = fs::remove_dir_all(backup);
                return Ok(installed_kit(manifest, &final_directory, source));
            }
            let existing = load_and_validate_manifest(
                &final_directory,
                Some(&manifest.kind),
                Some(&manifest.id),
                Some(&manifest.version),
            )?;
            return Ok(installed_kit(
                existing,
                &final_directory,
                existing_record.source,
            ));
        }
        write_install_record(&package_directory, &digest, source)?;
        let parent = final_directory
            .parent()
            .ok_or_else(|| "专家套件安装路径无效".to_string())?;
        fs::create_dir_all(parent).map_err(|error| format!("无法创建套件版本目录：{error}"))?;
        fs::rename(&package_directory, &final_directory)
            .map_err(|error| format!("无法完成专家套件安装：{error}"))?;
        Ok(installed_kit(manifest, &final_directory, source))
    })();

    if staging_directory.exists() {
        let _ = fs::remove_dir_all(&staging_directory);
    }
    result
}

pub fn harness_profile(
    app: &tauri::AppHandle,
    selected_kind: Option<&str>,
    selected_id: Option<&str>,
    requested_knowledge_base_refs: &[String],
    user_prompt: &str,
    allowed_artifacts: &[AllowedExtensionArtifact],
    execution_mode: &str,
) -> Result<ExpertKitHarnessProfile, String> {
    if !matches!(execution_mode, "agent" | "plan") {
        return Err("执行模式无效".to_string());
    }
    if selected_kind.is_some() != selected_id.is_some() {
        return Err("扩展选择坐标不完整".to_string());
    }
    if let Some(kind) = selected_kind {
        validate_artifact_kind(kind)?;
    }
    if let Some(id) = selected_id {
        validate_identifier(id)?;
    }
    validate_allowed_artifacts(allowed_artifacts)?;
    let installed = inventory::scan_installed_extensions(app)?
        .installed
        .into_iter()
        .filter(|artifact| artifact_is_executable(artifact, allowed_artifacts))
        .collect::<Vec<_>>();
    let mut newest = std::collections::BTreeMap::<String, InstalledExpertKit>::new();
    for artifact in installed {
        let coordinate = format!("{}:{}", artifact.manifest.kind, artifact.manifest.id);
        newest.entry(coordinate).or_insert(artifact);
    }
    let selected_coordinate = selected_kind
        .zip(selected_id)
        .map(|(kind, id)| format!("{kind}:{id}"));
    let selected = selected_coordinate
        .as_ref()
        .map(|coordinate| {
            newest
                .get(coordinate)
                .ok_or_else(|| format!("扩展已停用、下架或尚未安装：{coordinate}"))
        })
        .transpose()?;
    for artifact in newest.values() {
        prepare_skill_runtime_files(artifact)?;
    }
    let mut skill_directories = Vec::new();
    let mut skill_ids = HashSet::new();
    if let Some(artifact) = selected {
        append_skill_directories(artifact, &mut skill_directories, &mut skill_ids)?;
    }
    for artifact in newest
        .values()
        .filter(|artifact| artifact.manifest.kind == "skill")
    {
        append_skill_directories(artifact, &mut skill_directories, &mut skill_ids)?;
    }
    for artifact in newest
        .values()
        .filter(|artifact| artifact.manifest.kind == "expert-kit")
    {
        append_skill_directories(artifact, &mut skill_directories, &mut skill_ids)?;
    }
    let connector_tools = selected.map_or_else(Vec::new, |artifact| {
        artifact
            .manifest
            .required_tools
            .iter()
            .filter(|tool| {
                !tool.starts_with("office.")
                    && !tool.starts_with("computer_use_")
                    && !matches!(
                        tool.as_str(),
                        "bash"
                            | "pwsh"
                            | "job_output"
                            | "job_list"
                            | "job_kill"
                            | "get_goal"
                            | "create_goal"
                            | "update_goal"
                    )
            })
            .cloned()
            .collect::<Vec<_>>()
    });
    let knowledge_base_refs = task_knowledge_scope(
        selected.and_then(|artifact| artifact.manifest.knowledge_base_refs.as_deref()),
        requested_knowledge_base_refs,
    )?;
    let desktop_agent_guidance = if execution_mode == "plan" {
        "你正在小胤桌面端的 Plan 模式中工作。先理解目标并检查真实环境，再给出可执行计划。可以读取文件、搜索内容、查询知识库和进行不改变状态的检查；不得创建、修改或删除文件，不得执行会改变环境或外部系统的命令和工具，不得发送消息。发现信息不足时指出具体缺口。最终回答包含目标、现状、实施步骤、验证方式和关键取舍，不要开始实施。"
    } else {
        "你正在小胤桌面端中工作，是能实际完成任务的 Agent，不是只能回答问题的聊天机器人。涉及本地目录、文件读写、Shell、浏览器或已连接系统时，应直接使用当前可用工具行动并根据真实结果回答；不要在尚未尝试工具前声称无法访问，也不要让员工为普通文件任务重复选择目录。优先以当前工作目录为起点，必要时再查询其他已授权目录。耗时命令可使用后台 Job，跨多轮复杂工作可使用 Goal 管理进度。仅在缺少继续执行所必需的授权、目标或业务参数时追问。工具过程使用简短自然的进度说明，最终回答聚焦结果、变更和仍需员工处理的事项。"
    };
    let prompt = if let Some(artifact) = selected {
        let commands = load_command_context(artifact, user_prompt)?;
        let profile_label = if artifact.manifest.kind == "skill" {
            "独立技能"
        } else {
            "专家套件"
        };
        let skill_guidance = if artifact.manifest.kind == "expert-kit" {
            format!(
                "专家套件 ID 不是技能名称。该能力包包含以下可加载技能：{}。先加载与任务相关的技能，读取其工作方法和交付要求，不要仅凭套件名称模拟岗位能力。加载本套件技能时使用这些技能 ID，不要把 {} 当作技能 ID。",
                artifact
                    .manifest
                    .skills
                    .iter()
                    .map(|skill| skill.id.as_str())
                    .collect::<Vec<_>>()
                    .join("、"),
                artifact.manifest.id,
            )
        } else {
            format!(
                "本独立技能的可加载 ID 是 {}。先加载技能并读取工作方法和交付要求，再开展任务。",
                artifact.manifest.id
            )
        };
        format!(
            "{}\n\n本任务明确使用公司{}《{}》（ID: {}，版本: {}）。{}所有已安装技能仍可按需加载；优先遵循本扩展的工作方法和命令。不要先向员工汇报泛化的资源盘点，不要因为任务未用到知识库或连接器而阻塞；只有具体任务确实需要时才检查对应能力。面对简短或口语化输入，先按最可能的意图自然回答，仅在无法继续行动时追问。{}\n\n员工任务：\n{}",
            desktop_agent_guidance,
            profile_label,
            artifact.manifest.name,
            artifact.manifest.id,
            artifact.manifest.version,
            skill_guidance,
            commands,
            user_prompt,
        )
    } else {
        format!("{}\n\n员工任务：\n{}", desktop_agent_guidance, user_prompt)
    };
    Ok(ExpertKitHarnessProfile {
        skill_directories,
        knowledge_base_refs,
        required_connector_tools: connector_tools,
        allowed_computer_tools: DESKTOP_COMPUTER_TOOLS
            .iter()
            .map(|tool| (*tool).to_string())
            .collect(),
        prompt,
    })
}

fn task_knowledge_scope(
    kit_refs: Option<&[String]>,
    requested_refs: &[String],
) -> Result<Option<Vec<String>>, String> {
    // None uses the employee-accessible catalog; Some([]) is an explicit empty scope.
    if kit_refs.is_none() && requested_refs.is_empty() {
        return Ok(None);
    }
    let mut references = Vec::new();
    for reference in kit_refs.unwrap_or_default().iter().chain(requested_refs) {
        if !valid_knowledge_base_reference(reference) {
            return Err(format!("任务知识库引用无效：{reference}"));
        }
        if !references.contains(reference) {
            references.push(reference.clone());
        }
    }
    if references.len() > 32 {
        return Err("任务知识库引用不能超过 32 个".to_string());
    }
    Ok(Some(references))
}

pub fn validate_allowed_artifacts(artifacts: &[AllowedExtensionArtifact]) -> Result<(), String> {
    if artifacts.len() > 256 {
        return Err("允许执行的扩展数量不能超过 256 个".to_string());
    }
    let mut coordinates = HashSet::new();
    for artifact in artifacts {
        validate_artifact_kind(&artifact.kind)?;
        validate_identifier(&artifact.id)?;
        Version::parse(&artifact.version).map_err(|error| format!("扩展版本无效：{error}"))?;
        validate_sha256(&artifact.sha256)?;
        if !coordinates.insert((artifact.kind.as_str(), artifact.id.as_str())) {
            return Err(format!("允许执行的扩展重复：{}", artifact.id));
        }
    }
    Ok(())
}

fn validate_artifact_kind(kind: &str) -> Result<(), String> {
    if matches!(kind, "expert-kit" | "skill") {
        Ok(())
    } else {
        Err("扩展类型无效".to_string())
    }
}

fn artifact_is_executable(
    artifact: &InstalledExpertKit,
    allowed_artifacts: &[AllowedExtensionArtifact],
) -> bool {
    if !artifact.enabled {
        return false;
    }
    if artifact.source == InstallSource::Developer {
        return true;
    }
    let Some(allowed) = allowed_artifacts.iter().find(|allowed| {
        allowed.kind == artifact.manifest.kind
            && allowed.id == artifact.manifest.id
            && allowed.version == artifact.manifest.version
    }) else {
        return false;
    };
    load_install_record(Path::new(&artifact.install_path)).is_ok_and(|record| {
        record.source == InstallSource::Catalog && record.package_sha256 == allowed.sha256
    })
}

fn append_skill_directories(
    kit: &InstalledExpertKit,
    directories: &mut Vec<String>,
    skill_ids: &mut HashSet<String>,
) -> Result<(), String> {
    let root = Path::new(&kit.install_path);
    if kit.manifest.kind == "skill" {
        let skill = kit
            .manifest
            .skills
            .first()
            .ok_or_else(|| "独立技能缺少入口".to_string())?;
        if !skill_ids.insert(skill.id.clone()) {
            return Ok(());
        }
        let directory = root.to_string_lossy().into_owned();
        if !directories.contains(&directory) {
            directories.push(directory);
        }
        return Ok(());
    }
    for skill in &kit.manifest.skills {
        if !skill_ids.insert(skill.id.clone()) {
            continue;
        }
        let skill_path = root.join(&skill.path);
        // Each root is scanned independently, so a shared parent would reintroduce skipped skills.
        let directory = skill_path
            .parent()
            .ok_or_else(|| format!("技能路径无效：{}", skill.path))?
            .to_string_lossy()
            .into_owned();
        if !directories.contains(&directory) {
            directories.push(directory);
        }
    }
    Ok(())
}

fn prepare_skill_runtime_files(kit: &InstalledExpertKit) -> Result<(), String> {
    let root = Path::new(&kit.install_path);
    for skill in &kit.manifest.skills {
        let path = root.join(&skill.path);
        let content = fs::read_to_string(&path)
            .map_err(|error| format!("无法读取技能 {}：{error}", skill.id))?;
        let normalized = normalize_skill_document(&content, &skill.id, &kit.manifest.summary);
        if normalized != content {
            fs::write(&path, normalized)
                .map_err(|error| format!("无法准备技能 {}：{error}", skill.id))?;
        }
    }
    Ok(())
}

fn normalize_skill_document(content: &str, id: &str, fallback_description: &str) -> String {
    let description = serde_json::to_string(fallback_description)
        .unwrap_or_else(|_| "\"企业工作方法\"".to_string());
    let lines = content
        .lines()
        .map(|line| line.trim_end_matches('\r').to_string())
        .collect::<Vec<_>>();
    let frontmatter_end = (lines.first().is_some_and(|line| line.trim() == "---"))
        .then(|| {
            lines
                .iter()
                .enumerate()
                .skip(1)
                .find_map(|(index, line)| (line.trim() == "---").then_some(index))
        })
        .flatten();
    let Some(frontmatter_end) = frontmatter_end else {
        return format!("---\nname: {id}\ndescription: {description}\n---\n\n{content}");
    };

    let mut metadata = lines[1..frontmatter_end].to_vec();
    let mut has_name = false;
    let mut has_description = false;
    for line in &mut metadata {
        if line.starts_with("name:") {
            *line = format!("name: {id}");
            has_name = true;
        } else if line.starts_with("description:") {
            has_description = true;
        }
    }
    if !has_name {
        metadata.push(format!("name: {id}"));
    }
    if !has_description {
        metadata.push(format!("description: {description}"));
    }
    let mut normalized = Vec::with_capacity(lines.len() + 2);
    normalized.push("---".to_string());
    normalized.extend(metadata);
    normalized.push("---".to_string());
    normalized.extend_from_slice(&lines[frontmatter_end + 1..]);
    let mut result = normalized.join("\n");
    if content.ends_with('\n') {
        result.push('\n');
    }
    result
}

fn load_command_context(kit: &InstalledExpertKit, prompt: &str) -> Result<String, String> {
    if kit.manifest.commands.is_empty() {
        return Ok(String::new());
    }
    let root = Path::new(&kit.install_path);
    let token = prompt.split_whitespace().next().unwrap_or_default();
    let prefix = format!("/kit:{}:", kit.manifest.id);
    let selected = token.strip_prefix(&prefix);
    let arguments = prompt
        .trim_start()
        .strip_prefix(token)
        .unwrap_or_default()
        .trim();
    if selected.is_some_and(|id| !kit.manifest.commands.iter().any(|command| command.id == id)) {
        return Err("未找到指定的套件命令".into());
    }
    let mut context = String::from("\n套件可用命令：");
    for command in &kit.manifest.commands {
        let invocation = format!("/kit:{}:{}", kit.manifest.id, command.id);
        if selected != Some(command.id.as_str()) {
            context.push_str(&format!("\n{invocation}"));
            continue;
        }
        let content = fs::read_to_string(root.join(&command.path))
            .map_err(|error| format!("无法读取专家套件命令 {}：{error}", command.id))?;
        if content.len() > 256 * 1024 {
            return Err(format!("专家套件命令文件过大：{}", command.id));
        }
        let content = content
            .replace("${CLAUDE_PLUGIN_ROOT}", &kit.install_path)
            .replace("${QWEN_PLUGIN_ROOT}", &kit.install_path)
            .replace("${QODER_PLUGIN_ROOT}", &kit.install_path)
            .replace("$ARGUMENTS", arguments);
        context.push_str(&format!("\n\n当前命令 {invocation}\n{content}"));
    }
    Ok(context)
}

fn load_install_record(root: &Path) -> Result<InstallRecord, String> {
    let value = fs::read_to_string(root.join(INSTALL_RECORD_PATH))
        .map_err(|_| "本地专家套件缺少可信安装记录".to_string())?;
    serde_json::from_str(&value).map_err(|error| format!("专家套件安装记录无效：{error}"))
}

fn write_install_record(root: &Path, sha256: &str, source: InstallSource) -> Result<(), String> {
    let value = serde_json::to_vec_pretty(&InstallRecord {
        package_sha256: sha256.to_string(),
        source,
    })
    .map_err(|error| format!("无法生成专家套件安装记录：{error}"))?;
    let metadata_directory = root.join(".xiaoyin");
    fs::create_dir_all(&metadata_directory)
        .map_err(|error| format!("无法创建扩展安装记录目录：{error}"))?;
    fs::write(root.join(INSTALL_RECORD_PATH), value)
        .map_err(|error| format!("无法保存专家套件安装记录：{error}"))
}

fn extensions_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("extensions"))
        .map_err(|error| format!("无法确定扩展目录：{error}"))
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

fn installed_kit(
    manifest: ExpertKitManifest,
    directory: &Path,
    source: InstallSource,
) -> InstalledExpertKit {
    InstalledExpertKit {
        enabled: !directory
            .parent()
            .is_some_and(|parent| parent.join(".disabled").exists()),
        bundled_connectors: compatibility::bundled_connectors(directory),
        manifest,
        install_path: directory.to_string_lossy().into_owned(),
        source,
        package_sha256: load_install_record(directory)
            .map(|record| record.package_sha256)
            .unwrap_or_default(),
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
    use std::io::Cursor;
    use std::io::Write;
    use zip::{ZipWriter, write::SimpleFileOptions};

    #[test]
    fn unselected_knowledge_uses_employee_catalog_but_explicit_empty_stays_empty() {
        assert_eq!(task_knowledge_scope(None, &[]).unwrap(), None);
        assert_eq!(task_knowledge_scope(Some(&[]), &[]).unwrap(), Some(vec![]));
    }

    #[test]
    fn task_knowledge_unions_kit_and_user_references_without_duplicates() {
        let kit = vec!["organization:handbook".to_string()];
        let requested = vec![
            "organization:handbook".to_string(),
            "team:sales".to_string(),
        ];
        assert_eq!(
            task_knowledge_scope(Some(&kit), &requested).unwrap(),
            Some(requested.clone())
        );
        assert_eq!(
            task_knowledge_scope(None, &requested).unwrap(),
            Some(requested.clone())
        );
        assert_eq!(
            task_knowledge_scope(Some(&[]), &requested).unwrap(),
            Some(requested)
        );
        assert_eq!(task_knowledge_scope(Some(&kit), &[]).unwrap(), Some(kit));
    }

    #[test]
    fn task_knowledge_validates_scope_and_unique_limit() {
        assert!(task_knowledge_scope(None, &["unknown:handbook".to_string()]).is_err());
        let refs = (0..33)
            .map(|index| format!("team:kb-{index}"))
            .collect::<Vec<_>>();
        assert!(task_knowledge_scope(None, &refs).is_err());
        assert!(task_knowledge_scope(None, &refs[..32]).is_ok());
        assert!(task_knowledge_scope(Some(&refs[..32]), &refs[..32]).is_ok());
    }

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
    }

    #[test]
    fn skill_runtime_metadata_uses_the_manifest_id() {
        let qoder_skill = "---\nname: API接口设计\nversion: 1.0.0\ndescription: Design APIs\n---\n\n# API接口设计\n";
        let normalized = normalize_skill_document(qoder_skill, "api-design", "设计企业 API");
        assert!(normalized.contains("\nname: api-design\n"));
        assert!(normalized.contains("\ndescription: Design APIs\n"));
        assert!(!normalized.contains("name: API接口设计"));

        let plain = normalize_skill_document("# 工作方法", "plain-skill", "普通工作方法");
        assert!(plain.starts_with("---\nname: plain-skill\ndescription: \"普通工作方法\"\n---\n"));
    }

    #[test]
    fn overlapping_kits_only_expose_selected_skill_directories() {
        let kit = |id: &str, ids: &[&str]| {
            let manifest = serde_json::from_value::<ExpertKitManifest>(serde_json::json!({
                "schemaVersion": "2", "kind": "expert-kit", "id": id,
                "name": id, "version": "1.0.0", "summary": "Development skills",
                "skills": ids.iter().map(|skill| serde_json::json!({
                    "id": skill, "path": format!("skills/{skill}/SKILL.md")
                })).collect::<Vec<_>>()
            }))
            .unwrap();
            installed_kit(
                manifest,
                &PathBuf::from(id).join("1.0.0"),
                InstallSource::Developer,
            )
        };
        let selected = kit("selected-kit", &["api-design"]);
        let other = kit("fullstack-kit", &["api-design", "code-review"]);
        let mut directories = Vec::new();
        let mut ids = HashSet::new();
        append_skill_directories(&selected, &mut directories, &mut ids).unwrap();
        append_skill_directories(&other, &mut directories, &mut ids).unwrap();
        append_skill_directories(&selected, &mut directories, &mut ids).unwrap();
        assert_eq!(
            directories,
            vec![
                PathBuf::from("selected-kit/1.0.0/skills/api-design")
                    .to_string_lossy()
                    .into_owned(),
                PathBuf::from("fullstack-kit/1.0.0/skills/code-review")
                    .to_string_lossy()
                    .into_owned(),
            ]
        );
        assert_eq!(ids.len(), 2);
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
        fs::create_dir_all(root.join(".xiaoyin-kit")).unwrap();
        fs::create_dir_all(root.join("skills/report")).unwrap();
        fs::write(root.join("skills/report/SKILL.md"), "# Report").unwrap();
        fs::write(
            root.join(KIT_MANIFEST_PATH),
            r#"{
              "schemaVersion":"2","id":"report-kit","name":"日报","version":"1.0.0",
              "summary":"生成日报","skills":[{"id":"report","path":"skills/report/SKILL.md"}],
              "requiredTools":["sales_summary"],
              "permissions":{
                "localFiles":"approval","shell":"approval","computerUse":"deny",
                "connectorRead":"deny","connectorWrite":"deny"
              }
            }"#,
        )
        .unwrap();

        let manifest = load_and_validate_manifest(
            &root,
            Some("expert-kit"),
            Some("report-kit"),
            Some("1.0.0"),
        )
        .unwrap();
        assert_eq!(manifest.id, "report-kit");
        assert!(
            serde_json::to_value(&manifest)
                .unwrap()
                .get("permissions")
                .is_none()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn manifest_model_still_rejects_unknown_fields() {
        let unknown = serde_json::from_str::<ExpertKitManifest>(
            r#"{
              "schemaVersion":"2","kind":"expert-kit","id":"report-kit","name":"日报","version":"1.0.0",
              "summary":"生成日报","skills":[{"id":"report","path":"skills/report/SKILL.md"}],
              "unexpected":true
            }"#,
        );
        assert!(unknown.is_err());
    }

    #[test]
    fn real_tar_gzip_package_is_safely_extracted_and_validated() {
        let manifest = r#"{
          "schemaVersion":"2","id":"report-kit","name":"日报","version":"1.0.0",
          "summary":"生成日报","skills":[{"id":"report","path":"skills/report/SKILL.md"}]
        }"#;
        let encoder = GzEncoder::new(Vec::new(), Compression::default());
        let mut archive = tar::Builder::new(encoder);
        append_archive_file(&mut archive, KIT_MANIFEST_PATH, manifest.as_bytes());
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
        let loaded = load_and_validate_manifest(
            &root,
            Some("expert-kit"),
            Some("report-kit"),
            Some("1.0.0"),
        )
        .unwrap();
        assert_eq!(loaded.skills[0].id, "report");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn standalone_skill_uses_its_own_manifest_and_root_skill_file() {
        let manifest = r#"{
          "schemaVersion":"1","id":"document-insight","name":"文档洞察","version":"1.0.0",
          "summary":"分析员工授权的文档","triggers":["总结文档"],"minimumDesktopVersion":"0.1.9",
          "requiredTools":["office.document.read"],"connectorRefs":[],"knowledgeBaseRefs":[]
        }"#;
        let encoder = GzEncoder::new(Vec::new(), Compression::default());
        let mut archive = tar::Builder::new(encoder);
        append_archive_file(&mut archive, SKILL_MANIFEST_PATH, manifest.as_bytes());
        append_archive_file(
            &mut archive,
            "SKILL.md",
            b"---\nname: document-insight\ndescription: Analyze documents.\n---\n# Skill",
        );
        let package = archive.into_inner().unwrap().finish().unwrap();
        let root = std::env::temp_dir().join(format!("xiaoyin-skill-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir(&root).unwrap();
        let installed = install_package_bytes(
            &root,
            &package,
            Some("skill"),
            Some("document-insight"),
            Some("1.0.0"),
            None,
            InstallSource::Catalog,
        )
        .unwrap();
        assert_eq!(installed.manifest.kind, "skill");
        assert_eq!(installed.manifest.skills[0].path, "SKILL.md");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn developer_composer_packages_every_selected_skill() {
        let manifest: ExpertKitManifest = serde_json::from_str(
            r#"{
              "schemaVersion":"2","kind":"expert-kit","id":"operations-kit","name":"运营套件","version":"1.0.0",
              "summary":"组合多个运营技能","minimumDesktopVersion":"0.1.29","commands":[],
              "skills":[
                {"id":"order-review","path":"skills/order-review/SKILL.md"},
                {"id":"sales-report","path":"skills/sales-report/SKILL.md"}
              ],
              "requiredTools":[],"connectorRefs":[],"knowledgeBaseRefs":[],
              "serverWorkflows":[]
            }"#,
        )
        .unwrap();
        let skill_files = vec![
            (
                "skills/order-review/SKILL.md".to_string(),
                b"# Order review".to_vec(),
            ),
            (
                "skills/sales-report/SKILL.md".to_string(),
                b"# Sales report".to_vec(),
            ),
        ];
        let package = build_developer_package(&manifest, "", &skill_files).unwrap();
        let root = std::env::temp_dir().join(format!(
            "xiaoyin-composer-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();

        let installed = install_package_bytes(
            &root,
            &package,
            Some("expert-kit"),
            Some("operations-kit"),
            Some("1.0.0"),
            None,
            InstallSource::Developer,
        )
        .unwrap();

        let directory = Path::new(&installed.install_path);
        assert_eq!(
            fs::read_to_string(directory.join("skills/order-review/SKILL.md")).unwrap(),
            "# Order review"
        );
        assert_eq!(
            fs::read_to_string(directory.join("skills/sales-report/SKILL.md")).unwrap(),
            "# Sales report"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn developer_builder_writes_the_standalone_skill_manifest_contract() {
        let manifest: ExpertKitManifest = serde_json::from_str(
            r#"{
              "schemaVersion":"1","kind":"skill","id":"order-review","name":"订单检查","version":"1.0.0",
              "summary":"检查订单风险","triggers":["检查订单"],"minimumDesktopVersion":"0.1.29",
              "commands":[],"skills":[{"id":"order-review","path":"SKILL.md"}],
              "requiredTools":[],"connectorRefs":[],"knowledgeBaseRefs":[],
              "serverWorkflows":[]
            }"#,
        )
        .unwrap();
        let package = build_developer_package(&manifest, "# Order review", &[]).unwrap();
        let root = std::env::temp_dir().join(format!(
            "xiaoyin-skill-builder-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();

        let installed = install_package_bytes(
            &root,
            &package,
            Some("skill"),
            Some("order-review"),
            Some("1.0.0"),
            None,
            InstallSource::Developer,
        )
        .unwrap();

        assert_eq!(installed.manifest.kind, "skill");
        assert_eq!(
            fs::read_to_string(Path::new(&installed.install_path).join("SKILL.md")).unwrap(),
            "# Order review"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn composer_copies_skill_resources_but_not_install_metadata() {
        let root = std::env::temp_dir().join(format!(
            "xiaoyin-skill-resources-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("scripts")).unwrap();
        fs::create_dir_all(root.join(".xiaoyin")).unwrap();
        fs::create_dir_all(root.join(".xiaoyin-skill")).unwrap();
        fs::write(root.join("SKILL.md"), "# Skill").unwrap();
        fs::write(root.join("scripts/check.js"), "export default true").unwrap();
        fs::write(root.join(".xiaoyin/install.json"), "{}").unwrap();
        fs::write(root.join(".xiaoyin-skill/skill.json"), "{}").unwrap();
        let mut files = Vec::new();

        collect_payload_files(&root, &root, Path::new("skills/order-review"), &mut files).unwrap();

        assert_eq!(
            files
                .iter()
                .map(|(path, _)| path.as_str())
                .collect::<Vec<_>>(),
            vec![
                "skills/order-review/SKILL.md",
                "skills/order-review/scripts/check.js"
            ]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn skill_zip_with_top_level_directory_is_installed() {
        let manifest = r#"{
          "schemaVersion":"1","id":"document-insight","name":"文档洞察","version":"1.0.0",
          "summary":"分析员工授权的文档","triggers":["总结文档"],"minimumDesktopVersion":"0.1.9",
          "requiredTools":["office.document.read"],"connectorRefs":[],"knowledgeBaseRefs":[]
        }"#;
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        zip.start_file(
            "document-insight/.xiaoyin-skill/skill.json",
            SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(manifest.as_bytes()).unwrap();
        zip.start_file("document-insight/SKILL.md", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"---\nname: document-insight\nversion: 1.0.0\n---\n# Skill")
            .unwrap();
        let package = zip.finish().unwrap().into_inner();
        let root = std::env::temp_dir().join(format!(
            "xiaoyin-skill-zip-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();

        let installed = install_package_bytes(
            &root,
            &package,
            Some("skill"),
            Some("document-insight"),
            Some("1.0.0"),
            None,
            InstallSource::Catalog,
        )
        .unwrap();

        assert_eq!(installed.manifest.id, "document-insight");
        assert!(
            Path::new(&installed.install_path)
                .join("SKILL.md")
                .is_file()
        );
        assert!(
            !Path::new(&installed.install_path)
                .join("document-insight")
                .exists()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn developer_package_records_source_and_replaces_same_version_draft() {
        assert!(
            !serde_json::to_string(&InstallRecord {
                package_sha256: "a".repeat(64),
                source: InstallSource::Catalog,
            })
            .unwrap()
            .contains("source")
        );
        let root = std::env::temp_dir().join(format!(
            "xiaoyin-developer-kit-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let manifest = r#"{
          "schemaVersion":"2","id":"platform-acceptance","name":"平台验收","version":"1.0.0",
          "summary":"验证平台能力","minimumDesktopVersion":"0.1.9",
          "skills":[{"id":"platform-check","path":"skills/platform-check/SKILL.md"}]
        }"#;
        let package = test_package(manifest, b"# Platform check");
        let installed = install_package_bytes(
            &root,
            &package,
            Some("expert-kit"),
            None,
            None,
            None,
            InstallSource::Developer,
        )
        .unwrap();
        assert_eq!(installed.source, InstallSource::Developer);
        assert_eq!(
            load_install_record(Path::new(&installed.install_path))
                .unwrap()
                .source,
            InstallSource::Developer
        );

        let changed = test_package(
            &manifest.replace("验证平台能力", "不同内容"),
            b"# Platform check",
        );
        let updated = install_package_bytes(
            &root,
            &changed,
            Some("expert-kit"),
            None,
            None,
            None,
            InstallSource::Developer,
        )
        .unwrap();
        assert_eq!(updated.manifest.summary, "不同内容");
        assert_eq!(updated.source, InstallSource::Developer);

        let catalog_collision = install_package_bytes(
            &root,
            &package,
            Some("expert-kit"),
            None,
            None,
            None,
            InstallSource::Catalog,
        )
        .err()
        .unwrap();
        assert!(catalog_collision.contains("同版本套件"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn catalog_artifacts_require_an_exact_active_coordinate_and_digest() {
        let root = std::env::temp_dir().join(format!(
            "xiaoyin-policy-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join(".xiaoyin")).unwrap();
        write_install_record(&root, &"a".repeat(64), InstallSource::Catalog).unwrap();
        let manifest: ExpertKitManifest = serde_json::from_str(r#"{
          "schemaVersion":"1","kind":"skill","id":"document-insight","name":"文档洞察",
          "version":"1.0.0","summary":"分析文档","skills":[{"id":"document-insight","path":"skills/document-insight/SKILL.md"}]
        }"#).unwrap();
        let mut installed = installed_kit(manifest, &root, InstallSource::Catalog);
        let allowed = AllowedExtensionArtifact {
            kind: "skill".to_string(),
            id: "document-insight".to_string(),
            version: "1.0.0".to_string(),
            sha256: "a".repeat(64),
        };
        assert!(validate_allowed_artifacts(std::slice::from_ref(&allowed)).is_ok());
        assert!(artifact_is_executable(
            &installed,
            std::slice::from_ref(&allowed)
        ));
        assert!(!artifact_is_executable(
            &installed,
            &[AllowedExtensionArtifact {
                version: "1.1.0".to_string(),
                ..allowed
            }],
        ));
        installed.enabled = false;
        installed.source = InstallSource::Developer;
        assert!(!artifact_is_executable(&installed, &[]));
        fs::remove_dir_all(root).unwrap();
    }

    fn test_package(manifest: &str, skill: &[u8]) -> Vec<u8> {
        let encoder = GzEncoder::new(Vec::new(), Compression::default());
        let mut archive = tar::Builder::new(encoder);
        append_archive_file(&mut archive, KIT_MANIFEST_PATH, manifest.as_bytes());
        append_archive_file(&mut archive, "skills/platform-check/SKILL.md", skill);
        archive.into_inner().unwrap().finish().unwrap()
    }

    fn append_archive_file<W: Write>(archive: &mut tar::Builder<W>, path: &str, bytes: &[u8]) {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        archive.append_data(&mut header, path, bytes).unwrap();
    }
}
