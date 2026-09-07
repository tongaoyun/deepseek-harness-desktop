use super::*;

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
    let mut directories = Vec::new();
    let mut ids = HashSet::new();
    append_skill_directories(selected, &mut directories, &mut ids).unwrap();
    for artifact in newest.values() {
        append_skill_directories(artifact, &mut directories, &mut ids).unwrap();
    }
    assert_eq!(ids.len(), 9);
    assert_eq!(directories.len(), 9);
    assert!(
        directories
            .iter()
            .all(|path| Path::new(path).join("SKILL.md").is_file())
    );
    assert!(
        load_command_context(selected, "检查 API")
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
