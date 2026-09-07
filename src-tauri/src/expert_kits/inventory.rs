use super::*;

pub(super) fn scan_installed_extensions(
    app: &tauri::AppHandle,
) -> Result<InstalledExtensionInventory, String> {
    let root = extensions_root(app)?;
    if !root.exists() {
        return Ok(InstalledExtensionInventory {
            installed: Vec::new(),
            issues: Vec::new(),
        });
    }

    let mut installed = Vec::new();
    let mut issues = Vec::new();
    for kind_directory in child_directories(&root)? {
        let Some(kind) = directory_name(&kind_directory) else {
            issues.push(issue("未知扩展目录", "扩展目录名称不是有效文本"));
            continue;
        };
        if let Err(message) = validate_artifact_kind(&kind) {
            issues.push(issue(&kind, &message));
            continue;
        }
        for extension_directory in child_directories(&kind_directory)? {
            let extension_id =
                directory_name(&extension_directory).unwrap_or_else(|| "未知扩展".to_string());
            for version_directory in child_directories(&extension_directory)? {
                let version =
                    directory_name(&version_directory).unwrap_or_else(|| "未知版本".to_string());
                let coordinate = format!("{kind}:{extension_id}@{version}");
                match load_installed_extension(&version_directory, &kind) {
                    Ok(value) => installed.push(value),
                    Err(message) => issues.push(issue(&coordinate, &message)),
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
    issues.sort_by(|left, right| left.coordinate.cmp(&right.coordinate));
    Ok(InstalledExtensionInventory { installed, issues })
}

fn load_installed_extension(root: &Path, kind: &str) -> Result<InstalledExpertKit, String> {
    let manifest = load_and_validate_manifest(root, Some(kind), None, None)?;
    let record = load_install_record(root)?;
    validate_sha256(&record.package_sha256)?;
    Ok(installed_kit(manifest, root, record.source))
}

fn directory_name(path: &Path) -> Option<String> {
    path.file_name()?.to_str().map(ToString::to_string)
}

fn issue(coordinate: &str, message: &str) -> InstalledExtensionIssue {
    InstalledExtensionIssue {
        coordinate: coordinate.to_string(),
        message: message.to_string(),
    }
}
