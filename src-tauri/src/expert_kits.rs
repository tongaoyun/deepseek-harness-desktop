#[cfg(test)]
mod acceptance;
mod archive;
pub mod github;
mod inventory;
mod manifest;
mod native_connectors;
mod qoder_import;
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

#[derive(Clone, Deserialize, Serialize)]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    author: Option<String>,
    version: String,
    summary: String,
    category: String,
    #[serde(default)]
    triggers: Vec<String>,
    #[serde(default = "default_true")]
    allow_implicit_invocation: bool,
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
}

#[derive(Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileReference {
    id: String,
    path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    skill_id: Option<String>,
    #[serde(default)]
    required_tools: Vec<String>,
    #[serde(default)]
    connector_refs: Vec<String>,
    #[serde(default)]
    knowledge_base_refs: Vec<String>,
}

fn default_true() -> bool {
    true
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
    #[serde(skip_serializing_if = "Option::is_none")]
    author: Option<String>,
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

const SKILL_METADATA_BUDGET_CHARS: usize = 8_000;
const SKILL_DESCRIPTION_MAX_CHARS: usize = 1_024;
const EXTENSION_CONTEXT_ITEM_MAX_BYTES: usize = 32 * 1024;
const EXTENSION_CONTEXT_TOTAL_MAX_BYTES: usize = 64 * 1024;

#[tauri::command]
pub async fn list_installed_expert_kits(
    app: tauri::AppHandle,
) -> Result<InstalledExtensionInventory, String> {
    crate::dingtalk_auth::current_employee(&app).await?;
    inventory::scan_installed_extensions(&app)
}

#[tauri::command]
pub async fn install_expert_kit(
    app: tauri::AppHandle,
    request: ExpertKitInstallRequest,
) -> Result<InstalledExpertKit, String> {
    crate::dingtalk_auth::current_employee(&app).await?;
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
        let installed = installed_kit(manifest, &final_directory, record.source);
        prune_superseded_catalog_versions(&app, &root.join(&request.id), &request.version);
        return Ok(installed);
    }

    let bytes = download_package(&request.url).await?;
    let installed = install_package_bytes(
        &root,
        &bytes,
        Some(&request.kind),
        Some(&request.id),
        Some(&request.version),
        Some(&request.sha256),
        InstallSource::Catalog,
    )?;
    prune_superseded_catalog_versions(&app, &root.join(&request.id), &request.version);
    Ok(installed)
}

#[tauri::command]
pub async fn select_developer_extension(
    app: tauri::AppHandle,
    kind: String,
    input: Option<String>,
) -> Result<Vec<String>, String> {
    crate::dingtalk_auth::current_employee(&app).await?;
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
            picker.blocking_pick_folders()
        } else {
            picker.blocking_pick_files()
        }
    })
    .await
    .map_err(|error| format!("打开专家套件选择器失败：{error}"))?;
    selected
        .unwrap_or_default()
        .into_iter()
        .map(|file| {
            file.into_path()
                .map(|path| path.to_string_lossy().to_string())
                .map_err(|error| format!("选择的专家套件路径无效：{error}"))
        })
        .collect()
}

#[tauri::command]
pub async fn install_developer_extension(
    app: tauri::AppHandle,
    kind: String,
    input: Option<String>,
    path: Option<String>,
) -> Result<Option<InstalledExpertKit>, String> {
    crate::dingtalk_auth::current_employee(&app).await?;
    if kind != "expert-kit" && kind != "skill" {
        return Err("仅支持导入专家套件或技能".to_string());
    }
    let selected = match path {
        Some(path) => Some(path),
        None => {
            let mut paths = select_developer_extension(app.clone(), kind.clone(), input).await?;
            if paths.len() > 1 {
                return Err("多个扩展请通过上传窗口批量安装".into());
            }
            paths.pop()
        }
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
pub async fn create_developer_extension(
    app: tauri::AppHandle,
    request: CreateDeveloperExtensionRequest,
) -> Result<DeveloperExtensionPackage, String> {
    crate::dingtalk_auth::current_employee(&app).await?;
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
            read_developer_extension(app.clone(), manifest.kind.clone(), base.id, base.version)
                .await?;
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
    if manifest.kind == "expert-kit" {
        let readme = format!("# {}\n\n{}\n", manifest.name, manifest.summary);
        append_generated_file(&mut archive, "README.md", readme.as_bytes())?;
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
pub async fn read_developer_extension(
    app: tauri::AppHandle,
    kind: String,
    id: String,
    version: String,
) -> Result<DeveloperExtensionDraft, String> {
    crate::dingtalk_auth::current_employee(&app).await?;
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
pub async fn package_developer_extension(
    app: tauri::AppHandle,
    kind: String,
    id: String,
    version: String,
) -> Result<DeveloperExtensionPackage, String> {
    crate::dingtalk_auth::current_employee(&app).await?;
    let directory = extensions_root(&app)?.join(&kind).join(&id).join(&version);
    let draft = read_developer_extension(app, kind, id, version).await?;
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
    crate::dingtalk_auth::current_employee(&app).await?;
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
    // The copy keeps the same bundled connector ids: they name shared desktop connectors, so a
    // customized kit reuses whatever the employee already configured instead of asking again.
    manifest["id"] = serde_json::json!(native_connectors::portable_id(&format!("{id}-custom")));
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
    crate::dingtalk_auth::current_employee(&app).await?;
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
pub async fn remove_developer_expert_kit(
    app: tauri::AppHandle,
    id: String,
    version: String,
) -> Result<(), String> {
    crate::dingtalk_auth::current_employee(&app).await?;
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
pub async fn remove_developer_extension(
    app: tauri::AppHandle,
    kind: String,
    id: String,
    version: String,
) -> Result<(), String> {
    crate::dingtalk_auth::current_employee(&app).await?;
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
pub async fn remove_catalog_extension(
    app: tauri::AppHandle,
    id: String,
    kind: String,
) -> Result<(), String> {
    crate::dingtalk_auth::current_employee(&app).await?;
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

/// Superseded content is disk cleanup, never a reason to fail an install that already succeeded,
/// and it stays on disk while a task is running so a live run keeps the files it started with.
/// Whatever is left over is removed the next time the same extension is installed.
fn prune_superseded_catalog_versions(
    app: &tauri::AppHandle,
    extension_directory: &Path,
    current_version: &str,
) {
    if app
        .state::<crate::harness::HarnessManager>()
        .has_running_task()
    {
        return;
    }
    remove_other_catalog_versions(extension_directory, current_version);
}

/// The install record is what proves a version directory is catalog content, not a developer copy.
/// A manifest that no longer loads is exactly the damaged state a reinstall is meant to clear, so it
/// does not protect the directory; an unreadable record does.
fn remove_other_catalog_versions(extension_directory: &Path, current_version: &str) {
    if !extension_directory.exists() {
        return;
    }
    let Ok(version_directories) = child_directories(extension_directory) else {
        return;
    };
    for version_directory in version_directories {
        if version_directory
            .file_name()
            .and_then(|value| value.to_str())
            == Some(current_version)
        {
            continue;
        }
        let Ok(record) = load_install_record(&version_directory) else {
            continue;
        };
        if record.source != InstallSource::Catalog {
            continue;
        }
        let _ = fs::remove_dir_all(&version_directory);
    }
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
            qoder_import::import(&package_directory, expected_kind)?;
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

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum InvocationMode {
    Explicit,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilitySelection {
    mode: InvocationMode,
    kind: String,
    extension_id: String,
    extension_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    skill_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    command_id: Option<String>,
}

struct ResolvedInvocation<'a> {
    spec: &'a CapabilitySelection,
    artifact: &'a InstalledExpertKit,
}

pub fn harness_profile(
    app: &tauri::AppHandle,
    selections: &[CapabilitySelection],
    requested_knowledge_base_refs: &[String],
    user_prompt: &str,
    allowed_artifacts: &[AllowedExtensionArtifact],
    implicit_artifacts: &[AllowedExtensionArtifact],
    execution_mode: &str,
) -> Result<ExpertKitHarnessProfile, String> {
    if !matches!(execution_mode, "agent" | "plan") {
        return Err("执行模式无效".to_string());
    }
    if selections.len() > 8 {
        return Err("每个任务最多选择 8 项技能或专家套件".into());
    }
    validate_allowed_artifacts(allowed_artifacts)?;
    validate_allowed_artifacts(implicit_artifacts)?;
    let mut executable_artifacts = allowed_artifacts.to_vec();
    executable_artifacts.extend_from_slice(implicit_artifacts);
    let installed = inventory::scan_installed_extensions(app)?
        .installed
        .into_iter()
        .filter(|artifact| artifact_is_executable(artifact, &executable_artifacts))
        .collect::<Vec<_>>();
    let mut installed_by_version = std::collections::BTreeMap::<String, InstalledExpertKit>::new();
    for artifact in installed {
        let coordinate = artifact_version_coordinate(&artifact);
        installed_by_version.insert(coordinate, artifact);
    }
    let resolved = resolve_selections(selections, &installed_by_version)?;
    let selected = resolved
        .iter()
        .map(|invocation| invocation.artifact)
        .collect::<Vec<_>>();
    let selected_coordinates = selected
        .iter()
        .map(|artifact| artifact_version_coordinate(artifact))
        .collect::<HashSet<_>>();
    let implicit = implicit_artifacts
        .iter()
        .filter_map(|allowed| {
            installed_by_version.get(&format!(
                "{}:{}@{}",
                allowed.kind, allowed.id, allowed.version
            ))
        })
        .filter(|artifact| !selected_coordinates.contains(&artifact_version_coordinate(artifact)))
        .collect::<Vec<_>>();
    for artifact in selected.iter().copied().chain(implicit.iter().copied()) {
        prepare_skill_runtime_files(artifact)?;
    }
    validate_selected_skill_conflicts(&resolved)?;
    let mut skill_catalog = SkillDirectorySelection::new(SKILL_METADATA_BUDGET_CHARS);
    for invocation in &resolved {
        skill_catalog.append_invocation(invocation)?;
    }
    for artifact in implicit {
        skill_catalog.append_artifact(artifact, false)?;
    }
    let connector_tools = resolved
        .iter()
        .flat_map(invocation_skills)
        .flat_map(|skill| {
            skill
                .required_tools
                .iter()
                .filter(|tool| {
                    !tool.starts_with("computer_use_")
                        && !crate::harness::is_harness_browser_tool(tool)
                        && !matches!(
                            tool.as_str(),
                            "load_workspace_dependencies"
                                | "present"
                                | "bash"
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
        })
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let kit_refs = resolved
        .iter()
        .flat_map(invocation_skills)
        .map(|skill| &skill.knowledge_base_refs)
        .collect::<Vec<_>>();
    let combined_refs = kit_refs
        .iter()
        .flat_map(|refs| refs.iter().cloned())
        .collect::<Vec<_>>();
    let knowledge_base_refs = task_knowledge_scope(
        (!kit_refs.is_empty()).then_some(combined_refs.as_slice()),
        requested_knowledge_base_refs,
    )?;
    let desktop_agent_guidance = if execution_mode == "plan" {
        "你正在小胤桌面端的 Plan 模式中工作。先理解目标并检查真实环境，再给出可执行计划。可以读取文件、搜索内容、查询知识库和进行不改变状态的检查；不得创建、修改或删除文件，不得执行会改变环境或外部系统的命令和工具，不得发送消息。发现信息不足时指出具体缺口。最终回答包含目标、现状、实施步骤、验证方式和关键取舍，不要开始实施。"
    } else {
        "你正在小胤桌面端中工作，是能实际完成任务的 Agent，不是只能回答问题的聊天机器人。涉及本地目录、文件读写、Shell、浏览器或已连接系统时，应直接使用当前可用工具行动并根据真实结果回答；不要在尚未尝试工具前声称无法访问，也不要让员工为普通文件任务重复选择目录。优先以当前工作目录为起点，必要时再查询其他已授权目录。耗时命令可使用后台 Job，跨多轮复杂工作可使用 Goal 管理进度。仅在缺少继续执行所必需的授权、目标或业务参数时追问。工具过程使用简短自然的进度说明，最终回答聚焦结果、变更和仍需员工处理的事项。"
    };
    let contexts = resolved.iter().map(|invocation| {
        let artifact = invocation.artifact;
        let commands = load_command_context(artifact, invocation.spec, user_prompt)?;
        let profile_label = if artifact.manifest.kind == "skill" {
            "独立技能"
        } else {
            "专家套件"
        };
        let skill_guidance = if artifact.manifest.kind == "expert-kit"
            && let Some(skill_id) = invocation.spec.skill_id.as_deref()
        {
            format!(
                "本次已按需限定为技能 {skill_id}。只加载该技能并读取其工作方法和交付要求，不要加载本套件的其他技能。"
            )
        } else if artifact.manifest.kind == "expert-kit" {
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
        Ok::<_, String>(format!(
            "本任务明确使用{}《{}》（ID: {}，版本: {}）。{}{}",
            profile_label,
            artifact.manifest.name,
            artifact.manifest.id,
            artifact.manifest.version,
            skill_guidance,
            commands,
        ))
    }).collect::<Result<Vec<_>, _>>()?;
    validate_extension_context_budget(&contexts)?;
    let catalog_notice = if skill_catalog.omitted > 0 {
        format!(
            "技能目录元数据超过 {} 字符预算，已省略 {} 个未明确选择的技能；员工明确选择的能力不受影响。",
            skill_catalog.limit, skill_catalog.omitted
        )
    } else {
        String::new()
    };
    let prompt = format!(
        "{}\n\n{}{}\n\n按所选能力的职责组合完成同一任务。不同方案的事实结论或交付要求发生冲突时明确指出，以员工的具体要求为准；不要默默丢弃任一所选能力。\n\n员工任务：\n{}",
        desktop_agent_guidance,
        contexts.join("\n\n"),
        if catalog_notice.is_empty() {
            String::new()
        } else {
            format!("\n\n{catalog_notice}")
        },
        user_prompt
    );
    Ok(ExpertKitHarnessProfile {
        skill_directories: skill_catalog.directories,
        knowledge_base_refs,
        required_connector_tools: connector_tools,
        allowed_computer_tools: DESKTOP_COMPUTER_TOOLS
            .iter()
            .map(|tool| (*tool).to_string())
            .collect(),
        prompt,
    })
}

fn artifact_coordinate(artifact: &InstalledExpertKit) -> String {
    format!("{}:{}", artifact.manifest.kind, artifact.manifest.id)
}

fn artifact_version_coordinate(artifact: &InstalledExpertKit) -> String {
    format!(
        "{}@{}",
        artifact_coordinate(artifact),
        artifact.manifest.version
    )
}

fn resolve_selections<'a>(
    selections: &'a [CapabilitySelection],
    installed: &'a std::collections::BTreeMap<String, InstalledExpertKit>,
) -> Result<Vec<ResolvedInvocation<'a>>, String> {
    let mut coordinates = HashSet::new();
    selections
        .iter()
        .map(|spec| {
            validate_artifact_kind(&spec.kind)?;
            validate_identifier(&spec.extension_id)?;
            Version::parse(&spec.extension_version)
                .map_err(|error| format!("调用版本无效：{error}"))?;
            let coordinate = format!("{}:{}", spec.kind, spec.extension_id);
            if !coordinates.insert(coordinate.clone()) {
                return Err("任务不能重复选择同一技能或专家套件".into());
            }
            let version_coordinate = format!("{coordinate}@{}", spec.extension_version);
            let artifact = if let Some(artifact) = installed.get(&version_coordinate) {
                artifact
            } else if installed
                .keys()
                .any(|key| key.starts_with(&format!("{coordinate}@")))
            {
                return Err(format!("扩展版本已变化，请重新选择：{version_coordinate}"));
            } else {
                return Err(format!("扩展已停用、下架或尚未安装：{version_coordinate}"));
            };
            validate_invocation_target(spec, artifact)?;
            Ok(ResolvedInvocation { spec, artifact })
        })
        .collect()
}

fn validate_invocation_target(
    spec: &CapabilitySelection,
    artifact: &InstalledExpertKit,
) -> Result<(), String> {
    if artifact.manifest.kind == "skill" {
        if spec.command_id.is_some()
            || artifact
                .manifest
                .skills
                .first()
                .map(|skill| skill.id.as_str())
                != spec.skill_id.as_deref()
        {
            return Err(format!("独立技能调用目标无效：{}", spec.extension_id));
        }
        return Ok(());
    }
    if let Some(command_id) = &spec.command_id {
        let command = artifact
            .manifest
            .commands
            .iter()
            .find(|command| command.id == *command_id)
            .ok_or_else(|| format!("未找到指定的套件命令：{command_id}"))?;
        if command.skill_id != spec.skill_id {
            return Err(format!("套件命令 {command_id} 的起始技能与清单不一致"));
        }
        return Ok(());
    }
    if let Some(skill_id) = &spec.skill_id
        && !artifact
            .manifest
            .skills
            .iter()
            .any(|skill| skill.id == *skill_id)
    {
        return Err(format!("未找到指定的套件技能：{skill_id}"));
    }
    Ok(())
}

fn validate_extension_context_budget(contexts: &[String]) -> Result<(), String> {
    if let Some(context) = contexts
        .iter()
        .find(|context| context.len() > EXTENSION_CONTEXT_ITEM_MAX_BYTES)
    {
        return Err(format!(
            "单项扩展上下文超过 {} KiB，请精简命令和能力说明（当前 {} KiB）",
            EXTENSION_CONTEXT_ITEM_MAX_BYTES / 1024,
            context.len().div_ceil(1024)
        ));
    }
    let total = contexts.iter().map(String::len).sum::<usize>();
    if total > EXTENSION_CONTEXT_TOTAL_MAX_BYTES {
        return Err(format!(
            "所选扩展上下文合计超过 {} KiB，请减少选择或精简命令（当前 {} KiB）",
            EXTENSION_CONTEXT_TOTAL_MAX_BYTES / 1024,
            total.div_ceil(1024)
        ));
    }
    Ok(())
}

fn invocation_skills<'a>(invocation: &ResolvedInvocation<'a>) -> Vec<&'a FileReference> {
    match invocation.spec.skill_id.as_deref() {
        Some(skill_id) => invocation
            .artifact
            .manifest
            .skills
            .iter()
            .filter(|skill| skill.id == skill_id)
            .collect(),
        None => invocation.artifact.manifest.skills.iter().collect(),
    }
}

fn validate_selected_skill_conflicts(selected: &[ResolvedInvocation<'_>]) -> Result<(), String> {
    let mut skills = std::collections::HashMap::<String, (String, PathBuf)>::new();
    for invocation in selected {
        let artifact = invocation.artifact;
        for skill in invocation_skills(invocation) {
            let entry = Path::new(&artifact.install_path).join(&skill.path);
            let directory = entry.parent().ok_or("技能目录无效")?;
            if let Some((owner, previous)) = skills.get(&skill.id) {
                let mut previous_files = Vec::new();
                let mut current_files = Vec::new();
                collect_payload_files(previous, previous, Path::new(""), &mut previous_files)?;
                collect_payload_files(directory, directory, Path::new(""), &mut current_files)?;
                if comparable_skill_files(previous_files) != comparable_skill_files(current_files) {
                    return Err(format!(
                        "《{}》与《{}》包含内容不同的同名技能 {}，请先定制并区分技能 ID",
                        owner, artifact.manifest.name, skill.id
                    ));
                }
            } else {
                skills.insert(
                    skill.id.clone(),
                    (artifact.manifest.name.clone(), directory.to_path_buf()),
                );
            }
        }
    }
    Ok(())
}

/// Two copies of the same skill only conflict when they would behave differently. The frontmatter
/// version is publishing metadata the runtime never reads, so a kit and a standalone copy that
/// differ only by that stamp are the same skill.
fn comparable_skill_files(files: Vec<(String, Vec<u8>)>) -> Vec<(String, Vec<u8>)> {
    files
        .into_iter()
        .map(|(path, content)| {
            if !path.ends_with("SKILL.md") {
                return (path, content);
            }
            match String::from_utf8(content) {
                Ok(text) => (path, without_frontmatter_version(&text).into_bytes()),
                Err(error) => (path, error.into_bytes()),
            }
        })
        .collect()
}

fn without_frontmatter_version(content: &str) -> String {
    let trimmed = content.trim_start_matches('\u{feff}');
    let mut lines = trimmed.lines();
    if lines.next().map(str::trim) != Some("---") {
        return content.to_owned();
    }
    let mut result = String::from("---\n");
    let mut inside = true;
    for line in lines {
        if inside && line.trim() == "---" {
            inside = false;
        } else if inside && line.trim_start().starts_with("version:") {
            continue;
        }
        result.push_str(line);
        result.push('\n');
    }
    result
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
    let Some(allowed) = allowed_artifacts.iter().find(|allowed| {
        allowed.kind == artifact.manifest.kind
            && allowed.id == artifact.manifest.id
            && allowed.version == artifact.manifest.version
    }) else {
        return false;
    };
    load_install_record(Path::new(&artifact.install_path)).is_ok_and(|record| {
        record.source == artifact.source && record.package_sha256 == allowed.sha256
    })
}

struct SkillDirectorySelection {
    directories: Vec<String>,
    ids: HashSet<String>,
    used: usize,
    limit: usize,
    omitted: usize,
}

impl SkillDirectorySelection {
    fn new(limit: usize) -> Self {
        Self {
            directories: Vec::new(),
            ids: HashSet::new(),
            used: 0,
            limit,
            omitted: 0,
        }
    }

    fn append_invocation(&mut self, invocation: &ResolvedInvocation<'_>) -> Result<(), String> {
        for skill in invocation_skills(invocation) {
            self.append_skill(invocation.artifact, skill)?;
        }
        Ok(())
    }

    fn append_artifact(
        &mut self,
        artifact: &InstalledExpertKit,
        explicit: bool,
    ) -> Result<(), String> {
        for skill in &artifact.manifest.skills {
            if !explicit {
                let directory = Path::new(&artifact.install_path)
                    .join(&skill.path)
                    .parent()
                    .ok_or_else(|| format!("技能路径无效：{}", skill.path))?
                    .to_string_lossy()
                    .into_owned();
                let cost = skill.id.chars().count()
                    + artifact
                        .manifest
                        .summary
                        .chars()
                        .count()
                        .min(SKILL_DESCRIPTION_MAX_CHARS)
                    + directory.chars().count()
                    + 32;
                if self.used.saturating_add(cost) > self.limit {
                    self.omitted += 1;
                    continue;
                }
            }
            self.append_skill(artifact, skill)?;
        }
        Ok(())
    }

    fn append_skill(
        &mut self,
        artifact: &InstalledExpertKit,
        skill: &FileReference,
    ) -> Result<(), String> {
        if self.ids.contains(&skill.id) {
            return Ok(());
        }
        let directory = Path::new(&artifact.install_path)
            .join(&skill.path)
            .parent()
            .ok_or_else(|| format!("技能路径无效：{}", skill.path))?
            .to_string_lossy()
            .into_owned();
        let summary = artifact
            .manifest
            .summary
            .chars()
            .take(SKILL_DESCRIPTION_MAX_CHARS)
            .collect::<String>();
        let cost =
            skill.id.chars().count() + summary.chars().count() + directory.chars().count() + 32;
        self.used = self.used.saturating_add(cost);
        self.ids.insert(skill.id.clone());
        if !self.directories.contains(&directory) {
            self.directories.push(directory);
        }
        Ok(())
    }
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

fn load_command_context(
    kit: &InstalledExpertKit,
    spec: &CapabilitySelection,
    arguments: &str,
) -> Result<String, String> {
    let root = Path::new(&kit.install_path);
    if spec.command_id.is_none()
        && let Some(skill_id) = spec.skill_id.as_deref()
    {
        return Ok(format!(
            "\n本次调用技能 {skill_id}。加载该技能并按其工作方法和交付要求完成任务。"
        ));
    }

    let Some(command_id) = spec.command_id.as_deref() else {
        if kit.manifest.commands.is_empty() {
            return Ok(String::new());
        }
        let commands = kit
            .manifest
            .commands
            .iter()
            .map(|command| match command.skill_id.as_deref() {
                Some(skill_id) => format!("{}（起始技能：{}）", command.id, skill_id),
                None => command.id.clone(),
            })
            .collect::<Vec<_>>()
            .join("、");
        return Ok(format!("\n套件包含以下快捷命令：{commands}。"));
    };
    let command = kit
        .manifest
        .commands
        .iter()
        .find(|command| command.id == command_id)
        .ok_or_else(|| format!("未找到指定的套件命令：{command_id}"))?;
    let content = fs::read_to_string(root.join(&command.path))
        .map_err(|error| format!("无法读取专家套件命令 {}：{error}", command.id))?;
    if content.len() > EXTENSION_CONTEXT_ITEM_MAX_BYTES {
        return Err(format!("专家套件命令文件过大：{}", command.id));
    }
    let content = content
        .replace(
            native_connectors::EXTENSION_ROOT_VARIABLE,
            &kit.install_path,
        )
        .replace("$ARGUMENTS", arguments.trim());
    let skill_guidance = command
        .skill_id
        .as_deref()
        .map_or_else(String::new, |skill_id| {
            format!("\n本命令调用技能 {skill_id}，先加载该技能并按其工作方法执行。")
        });
    Ok(format!(
        "\n\n当前命令 {}{skill_guidance}\n{content}",
        command.id
    ))
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
        author: manifest.author.clone(),
        enabled: !directory
            .parent()
            .is_some_and(|parent| parent.join(".disabled").exists()),
        bundled_connectors: native_connectors::bundled_connectors(directory),
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

    fn invocation(
        kind: &str,
        extension_id: &str,
        skill_id: Option<&str>,
        command_id: Option<&str>,
    ) -> CapabilitySelection {
        CapabilitySelection {
            mode: InvocationMode::Explicit,
            kind: kind.to_string(),
            extension_id: extension_id.to_string(),
            extension_version: "1.0.0".to_string(),
            skill_id: skill_id.map(str::to_string),
            command_id: command_id.map(str::to_string),
        }
    }

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
        assert!(valid_tool_name("load_workspace_dependencies"));
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
                "category": "code-development", "minimumDesktopVersion": "0.1.30",
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
        let mut catalog = SkillDirectorySelection::new(8_000);
        catalog.append_artifact(&selected, true).unwrap();
        catalog.append_artifact(&other, false).unwrap();
        catalog.append_artifact(&selected, true).unwrap();
        assert_eq!(
            catalog
                .directories
                .iter()
                .map(PathBuf::from)
                .collect::<Vec<_>>(),
            vec![
                PathBuf::from("selected-kit/1.0.0/skills/api-design"),
                PathBuf::from("fullstack-kit/1.0.0/skills/code-review"),
            ]
        );
        assert_eq!(catalog.ids.len(), 2);

        let selected_spec = invocation("expert-kit", "selected-kit", Some("api-design"), None);
        let other_spec = invocation("expert-kit", "fullstack-kit", Some("code-review"), None);
        assert!(
            validate_selected_skill_conflicts(&[
                ResolvedInvocation {
                    spec: &selected_spec,
                    artifact: &selected,
                },
                ResolvedInvocation {
                    spec: &other_spec,
                    artifact: &other,
                },
            ])
            .is_ok()
        );
    }

    #[test]
    fn implicit_skills_respect_metadata_budget_but_explicit_skills_do_not() {
        let manifest = serde_json::from_value::<ExpertKitManifest>(serde_json::json!({
            "schemaVersion": "2", "kind": "expert-kit", "id": "reports", "name": "Reports",
            "version": "1.0.0", "summary": "A".repeat(2_000), "category": "other",
            "minimumDesktopVersion": "0.1.30",
            "skills": [{ "id": "weekly", "path": "skills/weekly/SKILL.md" }]
        }))
        .unwrap();
        let kit = installed_kit(
            manifest,
            Path::new("reports/1.0.0"),
            InstallSource::Developer,
        );

        let mut implicit = SkillDirectorySelection::new(100);
        implicit.append_artifact(&kit, false).unwrap();
        assert!(implicit.directories.is_empty());
        assert_eq!(implicit.omitted, 1);

        let spec = invocation("expert-kit", "reports", Some("weekly"), None);
        let resolved = ResolvedInvocation {
            spec: &spec,
            artifact: &kit,
        };
        let mut explicit = SkillDirectorySelection::new(100);
        explicit.append_invocation(&resolved).unwrap();
        assert_eq!(
            explicit
                .directories
                .iter()
                .map(PathBuf::from)
                .collect::<Vec<_>>(),
            [PathBuf::from("reports/1.0.0/skills/weekly")]
        );
        assert_eq!(explicit.omitted, 0);
    }

    #[test]
    fn structured_invocations_require_exact_versions_and_command_bindings() {
        let manifest = serde_json::from_value::<ExpertKitManifest>(serde_json::json!({
            "schemaVersion": "2", "kind": "expert-kit", "id": "reports", "name": "Reports",
            "version": "1.0.0", "summary": "Reports", "category": "other",
            "minimumDesktopVersion": "0.1.30",
            "commands": [{ "id": "weekly", "path": "commands/weekly.md", "skillId": "report" }],
            "skills": [{ "id": "report", "path": "skills/report/SKILL.md" }]
        }))
        .unwrap();
        let kit = installed_kit(
            manifest,
            Path::new("reports/1.0.0"),
            InstallSource::Developer,
        );
        let installed = [("expert-kit:reports@1.0.0".to_string(), kit)]
            .into_iter()
            .collect();

        let wrong_version = CapabilitySelection {
            extension_version: "2.0.0".to_string(),
            ..invocation("expert-kit", "reports", Some("report"), Some("weekly"))
        };
        assert!(
            resolve_selections(&[wrong_version], &installed)
                .err()
                .unwrap()
                .contains("版本已变化")
        );

        let wrong_binding = invocation("expert-kit", "reports", None, Some("weekly"));
        assert!(
            validate_invocation_target(&wrong_binding, &installed["expert-kit:reports@1.0.0"])
                .unwrap_err()
                .contains("起始技能")
        );
    }

    #[test]
    fn native_manifest_rejects_unknown_fields() {
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
              "schemaVersion":"3","id":"report-kit","name":"日报","version":"1.0.0",
              "summary":"生成日报","category":"other","minimumDesktopVersion":"0.1.30",
              "skills":[{"id":"report","path":"skills/report/SKILL.md"}],
              "requiredTools":["sales_summary"],
              "permissions":{
                "localFiles":"approval","shell":"approval","computerUse":"deny",
                "connectorRead":"deny","connectorWrite":"deny"
              }
            }"#,
        )
        .unwrap();

        let error = load_and_validate_manifest(
            &root,
            Some("expert-kit"),
            Some("report-kit"),
            Some("1.0.0"),
        )
        .err()
        .unwrap();
        assert!(error.contains("unknown field `permissions`"), "{error}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_structured_invocation_addresses_one_kit_skill() {
        let root = std::env::temp_dir().join(format!(
            "xiaoyin-kit-skill-token-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("skills/prd")).unwrap();
        fs::write(
            root.join("skills/prd/SKILL.md"),
            "---\nname: prd\n---\n# 写PRD",
        )
        .unwrap();
        let manifest = serde_json::from_value::<ExpertKitManifest>(serde_json::json!({
            "schemaVersion": "2", "kind": "expert-kit", "id": "product-design", "name": "产品设计",
            "version": "1.0.0", "summary": "设计", "category": "design",
            "minimumDesktopVersion": "0.1.30",
            "skills": [{ "id": "prd", "path": "skills/prd/SKILL.md" }]
        }))
        .unwrap();
        let kit = installed_kit(manifest, &root, InstallSource::Developer);

        let skill = invocation("expert-kit", "product-design", Some("prd"), None);
        let context = load_command_context(&kit, &skill, "整理登录功能的需求").unwrap();
        assert!(context.contains("调用技能 prd"), "{context}");
        assert!(!context.contains("整理登录功能的需求"), "{context}");
        assert!(!context.contains("其他技能"), "{context}");

        let missing = invocation("expert-kit", "product-design", Some("missing"), None);
        assert!(
            validate_invocation_target(&missing, &kit)
                .unwrap_err()
                .contains("未找到")
        );

        let root_invocation = invocation("expert-kit", "product-design", None, None);
        assert_eq!(
            load_command_context(&kit, &root_invocation, "做点什么").unwrap(),
            ""
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn structured_skill_and_command_targets_do_not_collide() {
        let root = std::env::temp_dir().join(format!(
            "xiaoyin-kit-command-skill-collision-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("commands")).unwrap();
        fs::create_dir_all(root.join("skills/review")).unwrap();
        fs::write(root.join("commands/review.md"), "COMMAND $ARGUMENTS").unwrap();
        fs::write(root.join("skills/review/SKILL.md"), "# Review").unwrap();
        let manifest = serde_json::from_value::<ExpertKitManifest>(serde_json::json!({
            "schemaVersion": "2", "kind": "expert-kit", "id": "quality", "name": "质量",
            "version": "1.0.0", "summary": "复核", "category": "other",
            "minimumDesktopVersion": "0.1.30",
            "commands": [{ "id": "review", "path": "commands/review.md", "skillId": "review" }],
            "skills": [{ "id": "review", "path": "skills/review/SKILL.md" }]
        }))
        .unwrap();
        let kit = installed_kit(manifest, &root, InstallSource::Developer);

        let skill_spec = invocation("expert-kit", "quality", Some("review"), None);
        let skill = load_command_context(&kit, &skill_spec, "检查交付物").unwrap();
        assert!(skill.contains("调用技能 review"), "{skill}");
        assert!(!skill.contains("COMMAND"), "{skill}");

        let command_spec = invocation("expert-kit", "quality", Some("review"), Some("review"));
        let command = load_command_context(&kit, &command_spec, "检查交付物").unwrap();
        assert!(command.contains("COMMAND 检查交付物"), "{command}");
        assert!(command.contains("本命令调用技能 review"), "{command}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn implicit_invocation_defaults_on_and_can_be_disabled() {
        let base = serde_json::json!({
            "schemaVersion": "2", "kind": "expert-kit", "id": "quality", "name": "质量",
            "version": "1.0.0", "summary": "复核", "category": "other",
            "minimumDesktopVersion": "0.1.30",
            "skills": [{ "id": "review", "path": "skills/review/SKILL.md" }]
        });
        let implicit = serde_json::from_value::<ExpertKitManifest>(base.clone()).unwrap();
        assert!(implicit.allow_implicit_invocation);
        let mut explicit_value = base;
        explicit_value["allowImplicitInvocation"] = serde_json::json!(false);
        let explicit = serde_json::from_value::<ExpertKitManifest>(explicit_value).unwrap();
        assert!(!explicit.allow_implicit_invocation);
    }

    #[test]
    fn a_version_stamp_alone_does_not_make_two_copies_of_a_skill_conflict() {
        let root = std::env::temp_dir().join(format!(
            "xiaoyin-skill-stamp-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let body = "\n---\n\n# API接口设计\n\n设计接口。\n";
        let kits = [("kit", "1.0.0"), ("standalone", "1.0.1")].map(|(id, version)| {
            let directory = root.join(id);
            fs::create_dir_all(directory.join("skills/api-design")).unwrap();
            fs::write(
                directory.join("skills/api-design/SKILL.md"),
                format!("---\nname: api-design\nversion: {version}\ndescription: 设计接口{body}"),
            )
            .unwrap();
            let manifest = serde_json::from_value::<ExpertKitManifest>(serde_json::json!({
                "schemaVersion": "2", "kind": "expert-kit", "id": id, "name": id,
                "version": "1.0.0", "summary": "Test", "category": "other",
                "minimumDesktopVersion": "0.1.30",
                "skills": [{ "id": "api-design", "path": "skills/api-design/SKILL.md" }]
            }))
            .unwrap();
            installed_kit(manifest, &directory, InstallSource::Developer)
        });
        let specs = kits
            .iter()
            .map(|kit| invocation("expert-kit", &kit.manifest.id, None, None))
            .collect::<Vec<_>>();
        let selected = [
            ResolvedInvocation {
                spec: &specs[0],
                artifact: &kits[0],
            },
            ResolvedInvocation {
                spec: &specs[1],
                artifact: &kits[1],
            },
        ];
        assert!(validate_selected_skill_conflicts(&selected).is_ok());

        // A real difference in the instructions still blocks the task.
        fs::write(
            root.join("standalone/skills/api-design/SKILL.md"),
            format!(
                "---\nname: api-design\nversion: 1.0.1\ndescription: 设计接口{body}并生成文档。\n"
            ),
        )
        .unwrap();
        let error = validate_selected_skill_conflicts(&selected).err().unwrap();
        assert!(error.contains("api-design"), "{error}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn combined_kits_check_resources_and_expand_each_command_arguments() {
        let root =
            std::env::temp_dir().join(format!("xiaoyin-combined-kits-{}", std::process::id()));
        let kits = ["design", "product"].map(|id| {
            let directory = root.join(id);
            fs::create_dir_all(directory.join("skills/shared/assets")).unwrap();
            fs::create_dir_all(directory.join("commands")).unwrap();
            fs::write(directory.join("skills/shared/SKILL.md"), "# Shared").unwrap();
            fs::write(directory.join("skills/shared/assets/template.txt"), "same").unwrap();
            fs::write(
                directory.join("commands/run.md"),
                format!("{id}: $ARGUMENTS"),
            )
            .unwrap();
            let manifest = serde_json::from_value::<ExpertKitManifest>(serde_json::json!({
                "schemaVersion": "2", "kind": "expert-kit", "id": id, "name": id,
                "version": "1.0.0", "summary": "Test", "category": "other",
                "minimumDesktopVersion": "0.1.30",
                "skills": [{ "id": "shared", "path": "skills/shared/SKILL.md" }],
                "commands": [{ "id": "run", "path": "commands/run.md" }]
            }))
            .unwrap();
            installed_kit(manifest, &directory, InstallSource::Developer)
        });
        let specs = kits
            .iter()
            .map(|kit| invocation("expert-kit", &kit.manifest.id, None, Some("run")))
            .collect::<Vec<_>>();
        let selected = [
            ResolvedInvocation {
                spec: &specs[0],
                artifact: &kits[0],
            },
            ResolvedInvocation {
                spec: &specs[1],
                artifact: &kits[1],
            },
        ];
        assert!(validate_selected_skill_conflicts(&selected).is_ok());
        for kit in &kits {
            let spec = invocation("expert-kit", &kit.manifest.id, None, Some("run"));
            let context = load_command_context(kit, &spec, "deliver report").unwrap();
            assert!(context.contains(&format!("{}: deliver report", kit.manifest.id)));
            assert!(!context.contains("$ARGUMENTS"));
        }
        fs::write(
            root.join("product/skills/shared/assets/template.txt"),
            "different",
        )
        .unwrap();
        assert!(
            validate_selected_skill_conflicts(&selected)
                .unwrap_err()
                .contains("同名技能")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn manifest_model_still_rejects_unknown_fields() {
        let unknown = serde_json::from_str::<ExpertKitManifest>(
            r#"{
              "schemaVersion":"3","kind":"expert-kit","id":"report-kit","name":"日报","version":"1.0.0",
              "summary":"生成日报","commands":[{"id":"report","path":"commands/report.md","skillId":"report"}],
              "skills":[{"id":"report","path":"skills/report/SKILL.md","requiredTools":[],"connectorRefs":[],"knowledgeBaseRefs":[]}],
              "requiredTools":[],"connectorRefs":[],"knowledgeBaseRefs":[],
              "unexpected":true
            }"#,
        );
        assert!(unknown.is_err());
    }

    #[test]
    fn real_tar_gzip_package_is_safely_extracted_and_validated() {
        let manifest = r#"{
          "schemaVersion":"3","id":"report-kit","name":"日报","version":"1.0.0",
          "summary":"生成日报","category":"other","minimumDesktopVersion":"0.1.30",
          "commands":[{"id":"report","path":"commands/report.md","skillId":"report"}],
          "skills":[{"id":"report","path":"skills/report/SKILL.md","requiredTools":[],"connectorRefs":[],"knowledgeBaseRefs":[]}],
          "requiredTools":[],"connectorRefs":[],"knowledgeBaseRefs":[]
        }"#;
        let encoder = GzEncoder::new(Vec::new(), Compression::default());
        let mut archive = tar::Builder::new(encoder);
        append_archive_file(&mut archive, KIT_MANIFEST_PATH, manifest.as_bytes());
        append_archive_file(&mut archive, "README.md", b"# Report kit");
        append_archive_file(&mut archive, "commands/report.md", b"$ARGUMENTS");
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
          "summary":"分析员工授权的文档","category":"knowledge-research","triggers":["总结文档"],"minimumDesktopVersion":"0.1.9",
          "requiredTools":["load_workspace_dependencies"],"connectorRefs":[],"knowledgeBaseRefs":[]
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
              "schemaVersion":"3","kind":"expert-kit","id":"operations-kit","name":"运营套件","version":"1.0.0",
              "summary":"组合多个运营技能","category":"other","minimumDesktopVersion":"0.1.29","commands":[{"id":"order-review","path":"commands/order-review.md","skillId":"order-review"}],
              "skills":[
                {"id":"order-review","path":"skills/order-review/SKILL.md","requiredTools":[],"connectorRefs":[],"knowledgeBaseRefs":[]},
                {"id":"sales-report","path":"skills/sales-report/SKILL.md","requiredTools":[],"connectorRefs":[],"knowledgeBaseRefs":[]}
              ],
              "requiredTools":[],"connectorRefs":[],"knowledgeBaseRefs":[]
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
              "summary":"检查订单风险","category":"other","triggers":["检查订单"],"minimumDesktopVersion":"0.1.29",
              "commands":[],"skills":[{"id":"order-review","path":"SKILL.md"}],
              "requiredTools":[],"connectorRefs":[],"knowledgeBaseRefs":[]
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
          "summary":"分析员工授权的文档","category":"knowledge-research","triggers":["总结文档"],"minimumDesktopVersion":"0.1.9",
          "requiredTools":["load_workspace_dependencies"],"connectorRefs":[],"knowledgeBaseRefs":[]
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
          "schemaVersion":"3","id":"platform-acceptance","name":"平台验收","version":"1.0.0",
          "summary":"验证平台能力","category":"other","minimumDesktopVersion":"0.1.9",
          "commands":[{"id":"platform-check","path":"commands/platform-check.md","skillId":"platform-check"}],
          "skills":[{"id":"platform-check","path":"skills/platform-check/SKILL.md","requiredTools":[],"connectorRefs":[],"knowledgeBaseRefs":[]}],
          "requiredTools":[],"connectorRefs":[],"knowledgeBaseRefs":[]
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
    fn published_install_keeps_only_current_catalog_content() {
        let root = std::env::temp_dir().join(format!(
            "xiaoyin-current-kit-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let manifest = r#"{
          "schemaVersion":"3","id":"report-kit","name":"报告专家","version":"1.0.0",
          "summary":"生成报告","category":"other","minimumDesktopVersion":"0.1.9",
          "commands":[{"id":"platform-check","path":"commands/platform-check.md","skillId":"platform-check"}],
          "skills":[{"id":"platform-check","path":"skills/platform-check/SKILL.md","requiredTools":[],"connectorRefs":[],"knowledgeBaseRefs":[]}],
          "requiredTools":[],"connectorRefs":[],"knowledgeBaseRefs":[]
        }"#;
        for (version, source) in [
            ("1.0.0", InstallSource::Catalog),
            ("2.0.0", InstallSource::Catalog),
            ("3.0.0", InstallSource::Developer),
        ] {
            let package = test_package(&manifest.replace("1.0.0", version), b"# Report");
            install_package_bytes(
                &root,
                &package,
                Some("expert-kit"),
                Some("report-kit"),
                Some(version),
                None,
                source,
            )
            .unwrap();
        }

        let directory = root.join("report-kit");
        // A catalog copy whose manifest no longer loads is the damaged state a reinstall clears.
        let damaged = directory.join("0.9.0");
        fs::create_dir_all(damaged.join(".xiaoyin")).unwrap();
        fs::write(
            damaged.join(".xiaoyin/install.json"),
            format!("{{\"packageSha256\":\"{}\"}}", "a".repeat(64)),
        )
        .unwrap();
        // Without a readable install record the directory has no provenance, so it is left alone.
        let unknown = directory.join("0.8.0");
        fs::create_dir_all(&unknown).unwrap();
        remove_other_catalog_versions(&directory, "2.0.0");

        assert!(!directory.join("1.0.0").exists());
        assert!(directory.join("2.0.0").exists());
        assert!(directory.join("3.0.0").exists());
        assert!(!damaged.exists());
        assert!(unknown.exists());
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
          "version":"1.0.0","summary":"分析文档","category":"knowledge-research","minimumDesktopVersion":"0.1.30",
          "skills":[{"id":"document-insight","path":"skills/document-insight/SKILL.md"}]
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
        append_archive_file(&mut archive, "README.md", b"# Expert kit");
        append_archive_file(&mut archive, "commands/platform-check.md", b"$ARGUMENTS");
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
