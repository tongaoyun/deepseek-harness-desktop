use super::*;
use percent_encoding::percent_decode_str;
use std::io::{Cursor, Read};

#[derive(Debug, PartialEq)]
struct GithubSource {
    owner: String,
    repository: String,
    revision: String,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubSkillCandidate {
    path: String,
    name: String,
    summary: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubSkillInspection {
    archive_id: String,
    source_url: String,
    candidates: Vec<GithubSkillCandidate>,
}

fn github_source(value: &str) -> Result<GithubSource, String> {
    if value.len() > 2000 {
        return Err("GitHub 地址过长".into());
    }
    let url = reqwest::Url::parse(value).map_err(|_| "GitHub 地址无效")?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("请提供 https://github.com 的公开仓库或技能目录地址".into());
    }
    let decoded = percent_decode_str(url.path())
        .decode_utf8()
        .map_err(|_| "GitHub 路径编码无效")?;
    let parts = decoded.trim_matches('/').split('/').collect::<Vec<_>>();
    if parts.len() < 2
        || parts.iter().any(|part| {
            part.is_empty()
                || *part == "."
                || *part == ".."
                || part.contains('\\')
                || part.chars().any(char::is_control)
        })
    {
        return Err("GitHub 仓库路径无效".into());
    }
    if parts[1].trim_end_matches(".git").is_empty() {
        return Err("GitHub 仓库名称无效".into());
    }
    let (revision, path) = if parts.len() == 2 {
        ("HEAD".to_string(), String::new())
    } else if parts.len() >= 4 && matches!(parts[2], "tree" | "blob") {
        let mut selected = parts[4..].to_vec();
        if selected.last() == Some(&"SKILL.md") {
            selected.pop();
        }
        (parts[3].into(), selected.join("/"))
    } else {
        return Err("请提供仓库首页、tree 目录或 SKILL.md 页面地址".into());
    };
    Ok(GithubSource {
        owner: parts[0].into(),
        repository: parts[1].trim_end_matches(".git").into(),
        revision,
        path,
    })
}

fn repository_path(name: &str) -> Result<String, String> {
    validate_relative_path(Path::new(name))?;
    let (_, path) = name.split_once('/').ok_or("GitHub 压缩包目录无效")?;
    Ok(path.to_string())
}

fn candidates(bytes: &[u8], selected: &str) -> Result<Vec<GithubSkillCandidate>, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "GitHub 压缩包无效")?;
    if archive.len() > 50000 {
        return Err("GitHub 仓库文件过多".into());
    }
    let mut found = Vec::new();
    let mut paths = HashSet::new();
    let mut root = None::<String>;
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|_| "无法读取 GitHub 压缩包")?;
        if file.is_dir() {
            continue;
        }
        let path = repository_path(file.name())?;
        let entry_root = file.name().split('/').next().unwrap_or_default();
        if root.as_ref().is_some_and(|value| value != entry_root) || !paths.insert(path.clone()) {
            return Err("GitHub 压缩包包含重复文件或多个根目录".into());
        }
        root.get_or_insert_with(|| entry_root.to_string());
        if path != "SKILL.md" && !path.ends_with("/SKILL.md") {
            continue;
        }
        if file
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("技能入口不能是符号链接".into());
        }
        let directory = path.strip_suffix("SKILL.md").unwrap().trim_end_matches('/');
        if !selected.is_empty()
            && directory != selected
            && !directory.starts_with(&format!("{selected}/"))
        {
            continue;
        }
        let mut content = String::new();
        Read::by_ref(&mut file)
            .take(256 * 1024 + 1)
            .read_to_string(&mut content)
            .map_err(|_| "技能说明必须是 UTF-8 文本")?;
        if content.len() > 256 * 1024 {
            return Err("技能说明超过 256 KiB".into());
        }
        found.push(GithubSkillCandidate {
            path: directory.to_string(),
            name: workbench::document_name(
                &content,
                directory
                    .rsplit('/')
                    .next()
                    .filter(|name| !name.is_empty())
                    .unwrap_or("skill"),
            ),
            summary: workbench::metadata(&content, "description").unwrap_or_default(),
        });
        if found.len() > 256 {
            return Err("仓库中技能过多，请提供具体技能目录地址".into());
        }
    }
    found.sort_by(|a, b| a.path.cmp(&b.path));
    if found.is_empty() {
        return Err("该目录没有找到 SKILL.md".into());
    }
    Ok(found)
}

fn skill_archive(bytes: &[u8], selected: &str) -> Result<Vec<u8>, String> {
    if !selected.is_empty() {
        validate_relative_path(Path::new(selected))?;
    }
    if !candidates(bytes, selected)?
        .iter()
        .any(|candidate| candidate.path == selected)
    {
        return Err("所选目录没有技能入口".into());
    }
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "GitHub 压缩包无效")?;
    let mut output = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let mut count = 0;
    let mut total = 0;
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|_| "无法读取 GitHub 文件")?;
        if file.is_dir() {
            continue;
        }
        let path = repository_path(file.name())?;
        let relative = if selected.is_empty() {
            Some(path.as_str())
        } else {
            path.strip_prefix(&format!("{selected}/"))
        };
        let Some(relative) = relative else {
            continue;
        };
        validate_relative_path(Path::new(relative))?;
        if file
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("技能不能包含符号链接".into());
        }
        count += 1;
        if count > 1024 {
            return Err("技能文件数量超过 1024".into());
        }
        let mut content = Vec::new();
        Read::by_ref(&mut file)
            .take(64 * 1024 * 1024 + 1)
            .read_to_end(&mut content)
            .map_err(|_| "无法读取技能文件")?;
        total += content.len();
        if total > 64 * 1024 * 1024 {
            return Err("技能展开后超过 64 MiB".into());
        }
        output
            .start_file(
                relative,
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated),
            )
            .map_err(|_| "无法打包技能")?;
        output.write_all(&content).map_err(|_| "无法写入技能")?;
    }
    Ok(output
        .finish()
        .map_err(|_| "无法完成技能打包")?
        .into_inner())
}

#[tauri::command]
pub async fn inspect_github_skills(
    app: tauri::AppHandle,
    source_url: String,
) -> Result<GithubSkillInspection, String> {
    crate::dingtalk_auth::current_employee(&app).await?;
    let source = github_source(&source_url)?;
    let mut url = reqwest::Url::parse("https://codeload.github.com").unwrap();
    url.path_segments_mut()
        .map_err(|_| "GitHub 下载地址无效")?
        .extend([&source.owner, &source.repository, "zip", &source.revision]);
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|_| "无法连接 GitHub")?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "GitHub 网络不可用，请稍后重试")?;
    if !response.status().is_success() {
        return Err(format!(
            "GitHub 下载失败（{}），请确认仓库公开且分支存在",
            response.status().as_u16()
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "GitHub 下载中断")? {
        if bytes.len() + chunk.len() > MAX_PACKAGE_BYTES {
            return Err("GitHub 仓库压缩包超过 32 MiB，请使用较小的技能仓库".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|_| "无法打开技能下载缓存")?
        .join("github-skills");
    tauri::async_runtime::spawn_blocking(move || {
        let found = candidates(&bytes, &source.path)?;
        fs::create_dir_all(&cache).map_err(|_| "无法创建技能下载缓存")?;
        let archive_id = format!("{:x}", Sha256::digest(&bytes));
        fs::write(cache.join(format!("{archive_id}.zip")), bytes)
            .map_err(|_| "无法保存技能下载")?;
        let mut files = fs::read_dir(&cache)
            .map_err(|_| "无法读取技能缓存")?
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        files.sort_by_key(|entry| {
            std::cmp::Reverse(entry.metadata().and_then(|meta| meta.modified()).ok())
        });
        for entry in files.into_iter().skip(8) {
            let _ = fs::remove_file(entry.path());
        }
        Ok(GithubSkillInspection {
            archive_id,
            source_url,
            candidates: found,
        })
    })
    .await
    .map_err(|_| "解析 GitHub 技能失败")?
}

#[tauri::command]
pub async fn install_github_skill(
    app: tauri::AppHandle,
    archive_id: String,
    path: String,
) -> Result<InstalledExpertKit, String> {
    crate::dingtalk_auth::current_employee(&app).await?;
    validate_sha256(&archive_id)?;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|_| "无法打开技能缓存")?
        .join("github-skills")
        .join(format!("{archive_id}.zip"));
    let root = extensions_root(&app)?.join("skill");
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = fs::read(cache).map_err(|_| "技能下载已失效，请重新读取 GitHub 地址")?;
        if bytes.len() > MAX_PACKAGE_BYTES || format!("{:x}", Sha256::digest(&bytes)) != archive_id
        {
            return Err("技能下载摘要不一致，请重新读取".into());
        }
        let bytes = skill_archive(&bytes, &path)?;
        install_package_bytes(
            &root,
            &bytes,
            Some("skill"),
            None,
            None,
            None,
            InstallSource::Developer,
        )
    })
    .await
    .map_err(|_| "GitHub 技能安装失败")?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires XIAOYIN_GITHUB_SKILL_FIXTURE downloaded from a public GitHub repository"]
    fn public_github_archive_installs_through_the_standard_pipeline() {
        let bytes = fs::read(std::env::var("XIAOYIN_GITHUB_SKILL_FIXTURE").unwrap()).unwrap();
        let found = candidates(&bytes, "").unwrap();
        let candidate = found
            .iter()
            .find(|item| item.path == "skills/find-skills")
            .unwrap();
        let package = skill_archive(&bytes, &candidate.path).unwrap();
        let root =
            std::env::temp_dir().join(format!("xiaoyin-github-install-{}", std::process::id()));
        let installed = install_package_bytes(
            &root,
            &package,
            Some("skill"),
            None,
            None,
            None,
            InstallSource::Developer,
        )
        .unwrap();
        assert_eq!(installed.manifest.id, "find-skills");
        assert!(
            Path::new(&installed.install_path)
                .join("SKILL.md")
                .is_file()
        );
        assert_eq!(installed.source, InstallSource::Developer);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn github_archives_reject_traversal_and_ambiguous_roots() {
        for paths in [
            ["repo/skills/a/SKILL.md", "repo/../outside/SKILL.md"],
            ["repo/skills/a/SKILL.md", "other/skills/b/SKILL.md"],
        ] {
            let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
            for path in paths {
                archive
                    .start_file(path, zip::write::SimpleFileOptions::default())
                    .unwrap();
                archive.write_all(b"# Skill").unwrap();
            }
            assert!(candidates(&archive.finish().unwrap().into_inner(), "").is_err());
        }
    }
    #[test]
    fn github_urls_select_a_public_repository_and_optional_directory() {
        assert_eq!(
            github_source("https://github.com/team/repo/tree/main/skills/report")
                .unwrap()
                .path,
            "skills/report"
        );
        assert_eq!(
            github_source("https://github.com/team/repo/blob/main/skills/report/SKILL.md")
                .unwrap()
                .path,
            "skills/report"
        );
        assert_eq!(
            github_source("https://github.com/team/repo")
                .unwrap()
                .revision,
            "HEAD"
        );
        for url in [
            "http://github.com/team/repo",
            "https://github.com.evil/team/repo",
            "https://user@github.com/team/repo",
            "https://github.com/team/repo/tree/main/%2e%2e%2fsecret",
        ] {
            assert!(github_source(url).is_err(), "{url}");
        }
    }
    #[test]
    fn selected_skill_keeps_resources_and_excludes_other_skills() {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (path, text) in [
            (
                "repo-main/skills/a/SKILL.md",
                "---\nname: alpha\ndescription: Alpha\n---\n# Alpha",
            ),
            ("repo-main/skills/a/assets/test.txt", "resource"),
            ("repo-main/skills/b/SKILL.md", "# Beta"),
        ] {
            zip.start_file(path, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(text.as_bytes()).unwrap();
        }
        let bytes = zip.finish().unwrap().into_inner();
        assert_eq!(candidates(&bytes, "").unwrap().len(), 2);
        let selected = skill_archive(&bytes, "skills/a").unwrap();
        let archive = zip::ZipArchive::new(Cursor::new(selected)).unwrap();
        assert_eq!(
            archive.file_names().collect::<Vec<_>>(),
            vec!["SKILL.md", "assets/test.txt"]
        );
        assert!(skill_archive(&bytes, "../a").is_err());
    }
}
