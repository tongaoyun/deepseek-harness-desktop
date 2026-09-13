use super::*;

#[test]
#[ignore = "requires XIAOYIN_QODER_KIT_ARCHIVES with the six original Qoder ZIP files"]
fn qoder_expert_kit_archives() {
    let archives = PathBuf::from(std::env::var("XIAOYIN_QODER_KIT_ARCHIVES").unwrap());
    let root =
        std::env::temp_dir().join(format!("xiaoyin-qoder-acceptance-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let fixtures = [
        ("product-design", "0.5.10", "产品设计", 28),
        ("marketing", "1.1.1", "市场营销", 8),
        ("ali1688-buyer-assistant", "1.0.0", "1688买家助手", 5),
        ("ali1688-seller-assistant", "1.0.0", "1688商家助手", 2),
        ("product-management", "1.1.1", "产品管理", 8),
        ("fullstack-dev-expert", "1.0.0", "全栈开发专家", 8),
    ];
    let mut file_count = 0;
    for (id, version, name, skill_count) in fixtures {
        let bytes = fs::read(archives.join(format!("{id}-v{version}.zip"))).unwrap();
        let installed = install_package_bytes(
            &root.join("expert-kit"),
            &bytes,
            Some("expert-kit"),
            None,
            None,
            None,
            InstallSource::Developer,
        )
        .unwrap();
        assert_eq!(installed.manifest.id, id);
        assert_eq!(installed.manifest.version, version);
        assert_eq!(installed.manifest.name, name);
        assert_eq!(installed.manifest.skills.len(), skill_count);
        if id == "fullstack-dev-expert" {
            let names = installed
                .manifest
                .skills
                .iter()
                .map(|skill| {
                    let content =
                        fs::read_to_string(Path::new(&installed.install_path).join(&skill.path))
                            .unwrap();
                    workbench::document_name(&content, &skill.id)
                })
                .collect::<HashSet<_>>();
            for name in [
                "API接口设计",
                "Java业务开发",
                "Vue组件开发",
                "代码审查",
                "单元测试",
                "数据库设计",
                "性能调优",
                "重构建议",
            ] {
                assert!(names.contains(name), "missing display name: {name}");
            }
            assert!(installed.manifest.summary.contains("开发"));
        }
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
        let install_directory = Path::new(&installed.install_path);
        assert!(!install_directory.join(".qoder-plugin").exists());
        assert!(!install_directory.join(".claude-plugin").exists());
        assert!(!install_directory.join(".qwen-plugin").exists());
        assert!(!install_directory.join(".mcp.json").exists());
        assert!(install_directory.join(KIT_MANIFEST_PATH).is_file());
        for index in 0..zip.len() {
            let mut entry = zip.by_index(index).unwrap();
            if entry.is_dir() {
                continue;
            }
            let path = entry.enclosed_name().unwrap();
            let path_text = path.to_string_lossy().replace('\\', "/");
            if path_text == ".mcp.json"
                || path_text.starts_with(".qoder-plugin/")
                || path_text.starts_with(".claude-plugin/")
                || path_text.starts_with(".qwen-plugin/")
            {
                continue;
            }
            let mut original = Vec::new();
            std::io::Read::read_to_end(&mut entry, &mut original).unwrap();
            let expected = String::from_utf8(original.clone())
                .ok()
                .map(|content| {
                    content
                        .replace(
                            "${QODER_PLUGIN_ROOT}",
                            native_connectors::EXTENSION_ROOT_VARIABLE,
                        )
                        .into_bytes()
                })
                .unwrap_or(original);
            assert_eq!(
                fs::read(install_directory.join(path)).unwrap(),
                expected,
                "{id}: {}",
                entry.name()
            );
            file_count += 1;
        }
        println!("Verified {id}@{version}: {name}, {skill_count} native skills");
    }
    let inventory = inventory::scan_root(&root).unwrap();
    assert!(inventory.issues.is_empty());
    assert_eq!(inventory.installed.len(), 6);
    fs::remove_dir_all(root).unwrap();
    println!("Verified 6 Qoder archives, 59 native skills and {file_count} content files");
}

#[derive(Deserialize)]
struct ArtifactFixture {
    kind: String,
    id: String,
    version: String,
    sha256: String,
    path: PathBuf,
    expected_error: Option<String>,
}

#[test]
#[ignore = "requires XIAOYIN_EXTENSION_FIXTURES with verified release archives"]
fn official_extension_lifecycle() {
    let fixture_path = std::env::var("XIAOYIN_EXTENSION_FIXTURES").unwrap();
    let fixtures: Vec<ArtifactFixture> =
        serde_json::from_slice(&fs::read(fixture_path).unwrap()).unwrap();
    let root = std::env::temp_dir().join(format!(
        "xiaoyin-extension-acceptance-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&root).unwrap();
    let mut coordinates = HashSet::new();
    let mut installed_count = 0;
    for fixture in &fixtures {
        let bytes = fs::read(&fixture.path).unwrap();
        let install = || {
            install_package_bytes(
                &root.join(&fixture.kind),
                &bytes,
                Some(&fixture.kind),
                Some(&fixture.id),
                Some(&fixture.version),
                Some(&fixture.sha256),
                InstallSource::Catalog,
            )
        };
        if let Some(expected_error) = &fixture.expected_error {
            let error = install()
                .err()
                .expect("invalid fixture must fail installation");
            assert!(error.contains(expected_error), "{}: {error}", fixture.id);
            assert!(
                !root
                    .join(&fixture.kind)
                    .join(&fixture.id)
                    .join(&fixture.version)
                    .exists()
            );
            continue;
        }
        let first =
            install().unwrap_or_else(|error| panic!("{}@{}: {error}", fixture.id, fixture.version));
        assert_eq!(first.install_path, install().unwrap().install_path);
        assert_eq!(first.manifest.version, fixture.version);
        assert_eq!(first.package_sha256, fixture.sha256);
        coordinates.insert((fixture.kind.clone(), fixture.id.clone()));
        installed_count += 1;
    }
    let inventory = inventory::scan_root(&root).unwrap();
    assert!(inventory.issues.is_empty());
    assert_eq!(inventory.installed.len(), installed_count);
    let mut newest = std::collections::BTreeMap::new();
    for artifact in inventory.installed {
        newest
            .entry((artifact.manifest.kind.clone(), artifact.manifest.id.clone()))
            .or_insert(artifact);
    }
    assert_eq!(newest.len(), coordinates.len());
    for artifact in newest.values() {
        assert_eq!(artifact.manifest.version, "1.0.1");
        let parent = Path::new(&artifact.install_path).parent().unwrap();
        fs::write(parent.join(".disabled"), b"disabled").unwrap();
        let refreshed = inventory::scan_root(&root).unwrap();
        assert!(
            refreshed
                .installed
                .iter()
                .filter(|item| item.manifest.id == artifact.manifest.id)
                .all(|item| !item.enabled)
        );
        fs::remove_file(parent.join(".disabled")).unwrap();
    }
    let selected = newest
        .get(&("expert-kit".to_string(), "fullstack-dev-expert".to_string()))
        .unwrap();
    prepare_skill_runtime_files(selected).unwrap();
    let mut catalog = SkillDirectorySelection::new(usize::MAX);
    catalog.append_artifact(selected, true).unwrap();
    for artifact in newest.values() {
        catalog.append_artifact(artifact, false).unwrap();
    }
    assert_eq!(catalog.ids.len(), 9);
    assert_eq!(catalog.directories.len(), 9);
    assert!(
        catalog
            .directories
            .iter()
            .all(|path| Path::new(path).join("SKILL.md").is_file())
    );
    let root_invocation = CapabilitySelection {
        mode: InvocationMode::Explicit,
        kind: "expert-kit".to_string(),
        extension_id: selected.manifest.id.clone(),
        extension_version: selected.manifest.version.clone(),
        skill_id: None,
        command_id: None,
    };
    assert!(
        load_command_context(selected, &root_invocation, "检查 API")
            .unwrap()
            .is_empty()
    );
    for (kind, id) in coordinates {
        remove_catalog_versions(&root.join(&kind).join(&id), &kind, &id).unwrap();
        remove_catalog_versions(&root.join(&kind).join(&id), &kind, &id).unwrap();
    }
    let empty = inventory::scan_root(&root).unwrap();
    assert!(empty.installed.is_empty() && empty.issues.is_empty());
    fs::remove_dir_all(root).unwrap();
    println!(
        "Verified {} archives: install, repeat, upgrade, activation, skill roots and uninstall",
        fixtures.len()
    );
}
