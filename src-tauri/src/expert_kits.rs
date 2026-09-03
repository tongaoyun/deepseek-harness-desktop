mod archive;

use archive::{extract_package, package_root};
use flate2::{Compression, write::GzEncoder};
use futures_util::StreamExt;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

const MAX_PACKAGE_BYTES: usize = 32 * 1024 * 1024;
const KIT_MANIFEST_PATH: &str = ".xiaoyin-kit/kit.json";
const SKILL_MANIFEST_PATH: &str = ".xiaoyin-skill/skill.json";
const INSTALL_RECORD_PATH: &str = ".xiaoyin/install.json";
const DESKTOP_OFFICE_TOOLS: [&str; 4] = [
    "office.document.read",
    "office.docx.create",
    "office.xlsx.create",
    "office.pdf.create",
];
const DESKTOP_COMPUTER_TOOLS: [&str; 5] = [
    "computer_use_observe",
    "computer_use_click",
    "computer_use_type",
    "computer_use_key",
    "computer_use_scroll",
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
    #[serde(default = "deny_permission")]
    computer_use: PermissionMode,
    connector_read: PermissionMode,
    connector_write: PermissionMode,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum PermissionMode {
    Deny,
    Allow,
    Approval,
}

fn deny_permission() -> PermissionMode {
    PermissionMode::Deny
}

impl Permissions {
    fn validate(&self) -> Result<(), String> {
        Ok(())
    }
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
    manifest: ExpertKitManifest,
    install_path: String,
    source: InstallSource,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDeveloperExtensionRequest {
    manifest: ExpertKitManifest,
    instructions: String,
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
    pub connector_refs: Vec<String>,
    pub knowledge_base_refs: Option<Vec<String>>,
    pub required_connector_tools: Vec<String>,
    pub allow_local_files: bool,
    pub approve_local_file_writes: bool,
    pub allow_shell: bool,
    pub approve_shell: bool,
    pub allow_computer_use: bool,
    pub approve_computer_use: bool,
    pub allowed_computer_tools: Vec<String>,
    pub allow_connector_read: bool,
    pub allow_connector_write: bool,
    pub approve_connector_write: bool,
    pub prompt: String,
}

#[tauri::command]
pub fn list_installed_expert_kits(
    app: tauri::AppHandle,
) -> Result<Vec<InstalledExpertKit>, String> {
    let root = extensions_root(&app)?;
    if !root.exists() {
        return Ok(Vec::new());
    }

    let mut installed = Vec::new();
    for kind_directory in child_directories(&root)? {
        let Some(kind) = kind_directory.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if validate_artifact_kind(kind).is_err() {
            continue;
        }
        for extension_directory in child_directories(&kind_directory)? {
            for version_directory in child_directories(&extension_directory)? {
                if let (Ok(manifest), Ok(record)) = (
                    load_and_validate_manifest(&version_directory, Some(kind), None, None),
                    load_install_record(&version_directory),
                ) && validate_sha256(&record.package_sha256).is_ok()
                {
                    installed.push(installed_kit(manifest, &version_directory, record.source));
                }
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
pub fn developer_expert_kit_install_enabled() -> bool {
    true
}

#[tauri::command]
pub async fn install_developer_expert_kit(
    app: tauri::AppHandle,
) -> Result<Option<InstalledExpertKit>, String> {
    require_developer_install()?;
    let dialog_app = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .set_title("导入本地专家套件")
            .add_filter("小胤专家套件", &["zip", "gz"])
            .blocking_pick_file()
    })
    .await
    .map_err(|error| format!("打开专家套件选择器失败：{error}"))?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|error| format!("选择的专家套件路径无效：{error}"))?;
    let metadata = fs::metadata(&path).map_err(|error| format!("无法读取专家套件：{error}"))?;
    if !metadata.is_file() || metadata.len() > MAX_PACKAGE_BYTES as u64 {
        return Err("本地专家套件不是普通文件或超过 32 MiB 限制".to_string());
    }
    let bytes = fs::read(&path).map_err(|error| format!("无法读取专家套件：{error}"))?;
    install_package_bytes(
        &extensions_root(&app)?.join("expert-kit"),
        &bytes,
        Some("expert-kit"),
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
    let bytes = build_developer_package(&manifest, &request.instructions)?;
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
            .ok_or_else(|| "专家套件至少需要一个 Skill".to_string())?;
        skill.path.clone()
    };
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| format!("无法生成扩展清单：{error}"))?;
    let encoder = GzEncoder::new(Vec::new(), Compression::default());
    let mut archive = tar::Builder::new(encoder);
    append_generated_file(&mut archive, manifest_path, &manifest_bytes)?;
    append_generated_file(&mut archive, &instruction_path, instructions.as_bytes())?;
    let encoder = archive
        .into_inner()
        .map_err(|error| format!("无法生成扩展制品：{error}"))?;
    encoder
        .finish()
        .map_err(|error| format!("无法压缩扩展制品：{error}"))
}

#[tauri::command]
pub fn read_developer_extension(
    app: tauri::AppHandle,
    kind: String,
    id: String,
    version: String,
) -> Result<DeveloperExtensionDraft, String> {
    require_developer_install()?;
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
            .ok_or_else(|| "专家套件至少需要一个 Skill".to_string())?;
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
    let bytes = build_developer_package(&draft.manifest, &draft.instructions)?;
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
pub async fn create_expert_kit_template(
    app: tauri::AppHandle,
    id: String,
    name: String,
) -> Result<Option<String>, String> {
    validate_identifier(&id)?;
    if name.trim().is_empty() || name.len() > 200 {
        return Err("专家套件名称无效".to_string());
    }
    let dialog_app = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .set_title("选择专家套件工作目录")
            .blocking_pick_folder()
    })
    .await
    .map_err(|error| format!("打开目录选择器失败：{error}"))?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let parent = selected
        .into_path()
        .map_err(|error| format!("选择的目录无效：{error}"))?;
    let root = parent.join(&id);
    if root.exists() {
        return Err("目标目录已存在，请更换套件 ID 或目录".to_string());
    }
    fs::create_dir_all(root.join(".xiaoyin-kit"))
        .and_then(|_| fs::create_dir_all(root.join("skills/main")))
        .map_err(|error| format!("无法创建专家套件模板：{error}"))?;
    let manifest = serde_json::json!({
        "schemaVersion": "2", "id": id, "name": name.trim(), "version": "1.0.0",
        "summary": "请填写专家套件说明", "minimumDesktopVersion": env!("CARGO_PKG_VERSION"),
        "commands": [], "skills": [{ "id": "main", "path": "skills/main/SKILL.md" }],
        "requiredTools": [], "connectorRefs": [], "permissions": {
            "localFiles": "approval", "shell": "deny", "computerUse": "deny",
            "connectorRead": "deny", "connectorWrite": "deny"
        }, "serverWorkflows": []
    });
    fs::write(
        root.join(KIT_MANIFEST_PATH),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .and_then(|_| {
        fs::write(
            root.join("skills/main/SKILL.md"),
            format!("# {}\n\n在这里编写专家工作方法。\n", name.trim()),
        )
    })
    .map_err(|error| format!("无法写入专家套件模板：{error}"))?;
    Ok(Some(root.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn customize_expert_kit(
    app: tauri::AppHandle,
    id: String,
    version: String,
) -> Result<Option<String>, String> {
    validate_identifier(&id)?;
    Version::parse(&version).map_err(|error| format!("专家套件版本无效：{error}"))?;
    let source = extensions_root(&app)?
        .join("expert-kit")
        .join(&id)
        .join(&version);
    load_and_validate_manifest(&source, Some("expert-kit"), Some(&id), Some(&version))?;
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
    copy_extension_tree(&source, &destination, true)?;
    Ok(Some(destination.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn export_expert_kit(
    app: tauri::AppHandle,
    id: String,
    version: String,
) -> Result<Option<String>, String> {
    validate_identifier(&id)?;
    Version::parse(&version).map_err(|error| format!("专家套件版本无效：{error}"))?;
    let source = extensions_root(&app)?
        .join("expert-kit")
        .join(&id)
        .join(&version);
    load_and_validate_manifest(&source, Some("expert-kit"), Some(&id), Some(&version))?;
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
    let file = File::create(destination).map_err(|error| format!("无法创建 ZIP：{error}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    append_directory_to_zip(&mut zip, source, source, options)?;
    zip.finish()
        .map_err(|error| format!("无法完成 ZIP：{error}"))?;
    Ok(())
}

fn append_directory_to_zip(
    zip: &mut zip::ZipWriter<File>,
    root: &Path,
    directory: &Path,
    options: zip::write::SimpleFileOptions,
) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|error| format!("无法读取套件目录：{error}"))?
    {
        let entry = entry.map_err(|error| format!("无法读取套件文件：{error}"))?;
        let path = entry.path();
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
    require_developer_install()?;
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
    require_developer_install()?;
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
    if !extension_directory.exists() {
        return Ok(());
    }
    let mut removals = Vec::new();
    for version_directory in child_directories(&extension_directory)? {
        let Ok(record) = load_install_record(&version_directory) else {
            continue;
        };
        if record.source != InstallSource::Catalog {
            continue;
        }
        let manifest =
            load_and_validate_manifest(&version_directory, Some(&kind), Some(&id), None)?;
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

fn require_developer_install() -> Result<(), String> {
    developer_expert_kit_install_enabled()
        .then_some(())
        .ok_or_else(|| "本地专家套件安装未启用".to_string())
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
) -> Result<ExpertKitHarnessProfile, String> {
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
    let installed = list_installed_expert_kits(app.clone())?
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
                .ok_or_else(|| format!("扩展已下架、待更新或尚未安装：{coordinate}"))
        })
        .transpose()?;
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
                    && tool.as_str() != "local_shell_run"
            })
            .cloned()
            .collect::<Vec<_>>()
    });
    let connector_refs = selected.map_or_else(Vec::new, |artifact| {
        artifact.manifest.connector_refs.clone()
    });
    let mut knowledge_base_refs = selected
        .and_then(|artifact| artifact.manifest.knowledge_base_refs.clone())
        .unwrap_or_default();
    for reference in requested_knowledge_base_refs {
        if !valid_knowledge_base_reference(reference) {
            return Err(format!("任务知识库引用无效：{reference}"));
        }
        if !knowledge_base_refs.contains(reference) {
            knowledge_base_refs.push(reference.clone());
        }
    }
    if knowledge_base_refs.len() > 32 {
        return Err("任务知识库引用不能超过 32 个".to_string());
    }
    let prompt = if let Some(artifact) = selected {
        let commands = load_command_context(artifact)?;
        let profile_label = if artifact.manifest.kind == "skill" {
            "独立 Skill"
        } else {
            "专家套件"
        };
        format!(
            "本任务明确使用公司{}《{}》（ID: {}，版本: {}）。所有已安装 Skill 仍可按需加载；优先遵循本扩展的工作方法和命令。{}\n\n员工任务：\n{}",
            profile_label,
            artifact.manifest.name,
            artifact.manifest.id,
            artifact.manifest.version,
            commands,
            user_prompt,
        )
    } else {
        user_prompt.to_string()
    };
    let permissions = selected.map(|artifact| &artifact.manifest.permissions);
    let permission = |select: fn(&Permissions) -> PermissionMode| {
        permissions.map(select).unwrap_or(PermissionMode::Approval)
    };
    let local_files = permission(|value| value.local_files);
    let shell = permission(|value| value.shell);
    let computer_use = permission(|value| value.computer_use);
    let connector_read = permission(|value| value.connector_read);
    let connector_write = permission(|value| value.connector_write);
    Ok(ExpertKitHarnessProfile {
        skill_directories,
        connector_refs,
        knowledge_base_refs: Some(knowledge_base_refs),
        required_connector_tools: connector_tools,
        allow_local_files: local_files != PermissionMode::Deny,
        approve_local_file_writes: local_files == PermissionMode::Approval,
        allow_shell: shell != PermissionMode::Deny,
        approve_shell: shell == PermissionMode::Approval,
        allow_computer_use: computer_use != PermissionMode::Deny,
        approve_computer_use: computer_use == PermissionMode::Approval,
        allowed_computer_tools: DESKTOP_COMPUTER_TOOLS
            .iter()
            .map(|tool| (*tool).to_string())
            .collect(),
        allow_connector_read: connector_read != PermissionMode::Deny,
        allow_connector_write: connector_write != PermissionMode::Deny,
        approve_connector_write: connector_write == PermissionMode::Approval,
        prompt,
    })
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
    if artifact.source == InstallSource::Developer {
        return developer_expert_kit_install_enabled();
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
            .ok_or_else(|| "独立 Skill 缺少入口".to_string())?;
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
        let directory = if skill_path
            .file_name()
            .is_some_and(|name| name == "SKILL.md")
        {
            skill_path.parent().and_then(Path::parent)
        } else {
            skill_path.parent()
        }
        .ok_or_else(|| format!("Skill 路径无效：{}", skill.path))?
        .to_string_lossy()
        .into_owned();
        if !directories.contains(&directory) {
            directories.push(directory);
        }
    }
    Ok(())
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

fn load_and_validate_manifest(
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
        (true, true) => return Err("扩展不能同时包含专家套件和独立 Skill 清单".to_string()),
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
        || object.contains_key("serverWorkflows") && kind == "skill"
    {
        return Err("独立 Skill 与专家套件字段不能混用".to_string());
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
        object.insert("serverWorkflows".to_string(), serde_json::json!([]));
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
        || manifest.summary.trim().is_empty()
        || manifest.skills.is_empty()
    {
        return Err("专家套件名称、简介和 Skills 不能为空".to_string());
    }
    manifest.permissions.validate()?;

    if manifest.kind == "skill" {
        let mut triggers = HashSet::new();
        if manifest.triggers.is_empty()
            || manifest.triggers.len() > 20
            || manifest.triggers.iter().any(|trigger| {
                trigger.trim().len() < 2 || trigger.len() > 120 || !triggers.insert(trigger)
            })
        {
            return Err("独立 Skill 触发场景声明无效".to_string());
        }
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
        if manifest.kind == "skill" && reference.path != "SKILL.md" {
            return Err("独立 Skill 的入口必须是根目录 SKILL.md".to_string());
        }
        if manifest.kind == "expert-kit"
            && manifest.skills.iter().any(|skill| skill.id == reference.id)
            && reference.path != format!("skills/{}/SKILL.md", reference.id)
        {
            return Err(format!(
                "套件 Skill 路径必须是 skills/{}/SKILL.md",
                reference.id
            ));
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
    let mut workflow_ids = HashSet::new();
    for workflow in &manifest.server_workflows {
        if validate_identifier(&workflow.id).is_err() || !workflow_ids.insert(&workflow.id) {
            return Err(format!("后台工作流 ID 无效或重复：{}", workflow.id));
        }
        if workflow.name.trim().is_empty()
            || workflow.name.len() > 200
            || workflow.version.trim().is_empty()
            || workflow.workflow_type.trim().is_empty()
            || workflow.steps.is_empty()
        {
            return Err(format!("后台工作流定义不完整：{}", workflow.id));
        }
        let mut step_ids = HashSet::new();
        for step in &workflow.steps {
            if step.id.trim().is_empty()
                || !step_ids.insert(&step.id)
                || !valid_tool_name(&step.tool)
            {
                return Err(format!("后台工作流步骤无效：{} / {}", workflow.id, step.id));
            }
            if !manifest.connector_refs.contains(&step.connector_id) {
                return Err(format!(
                    "后台工作流步骤引用未声明连接器：{}",
                    step.connector_id
                ));
            }
            if !manifest.required_tools.contains(&step.tool) {
                return Err(format!("后台工作流步骤使用未声明工具：{}", step.tool));
            }
        }
    }
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

fn valid_knowledge_base_reference(value: &str) -> bool {
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
        manifest,
        install_path: directory.to_string_lossy().into_owned(),
        source,
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
        fs::create_dir_all(root.join(".xiaoyin-kit")).unwrap();
        fs::create_dir_all(root.join("skills/report")).unwrap();
        fs::write(root.join("skills/report/SKILL.md"), "# Report").unwrap();
        fs::write(
            root.join(KIT_MANIFEST_PATH),
            r#"{
              "schemaVersion":"2","id":"report-kit","name":"日报","version":"1.0.0",
              "summary":"生成日报","skills":[{"id":"report","path":"skills/report/SKILL.md"}],
              "requiredTools":["sales_summary"],
              "permissions":{"localFiles":"approval","shell":"deny","computerUse":"deny","connectorRead":"allow","connectorWrite":"approval"}
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
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn real_tar_gzip_package_is_safely_extracted_and_validated() {
        let manifest = r#"{
          "schemaVersion":"2","id":"report-kit","name":"日报","version":"1.0.0",
          "summary":"生成日报","skills":[{"id":"report","path":"skills/report/SKILL.md"}],
          "permissions":{"localFiles":"approval","shell":"deny","computerUse":"deny","connectorRead":"allow","connectorWrite":"approval"}
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
          "requiredTools":["office.document.read"],"connectorRefs":[],"knowledgeBaseRefs":[],
          "permissions":{"localFiles":"approval","shell":"deny","computerUse":"deny","connectorRead":"deny","connectorWrite":"deny"}
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
    fn nacos_skill_zip_with_top_level_directory_is_installed() {
        let manifest = r#"{
          "schemaVersion":"1","id":"document-insight","name":"文档洞察","version":"1.0.0",
          "summary":"分析员工授权的文档","triggers":["总结文档"],"minimumDesktopVersion":"0.1.9",
          "requiredTools":["office.document.read"],"connectorRefs":[],"knowledgeBaseRefs":[],
          "permissions":{"localFiles":"approval","shell":"deny","computerUse":"deny","connectorRead":"deny","connectorWrite":"deny"}
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
            "xiaoyin-nacos-skill-test-{}-{}",
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
          "skills":[{"id":"platform-check","path":"skills/platform-check/SKILL.md"}],
          "permissions":{"localFiles":"approval","shell":"approval","computerUse":"approval","connectorRead":"deny","connectorWrite":"deny"}
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
          "version":"1.0.0","summary":"分析文档","skills":[{"id":"document-insight","path":"skills/document-insight/SKILL.md"}],
          "permissions":{"localFiles":"approval","shell":"deny","computerUse":"deny","connectorRead":"deny","connectorWrite":"deny"}
        }"#).unwrap();
        let installed = installed_kit(manifest, &root, InstallSource::Catalog);
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
