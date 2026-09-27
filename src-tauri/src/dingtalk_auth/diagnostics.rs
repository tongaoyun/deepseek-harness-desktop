use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::Path,
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

static WRITE_LOCK: Mutex<()> = Mutex::new(());
static RUN_ID: OnceLock<String> = OnceLock::new();

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Code {
    Authenticated,
    CookieMissing,
    SessionRejected,
    AccessDenied,
    NetworkError,
    RequestTimeout,
    IdentityUnavailable,
    IdentityInvalid,
    ControlPlaneAuthFailed,
    CookieReadFailed,
    CookieStoreFailed,
    ConfigurationInvalid,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Diagnostic {
    pub code: Code,
    pub cookie_count: Option<usize>,
    pub http_status: Option<u16>,
    checked_at: u64,
    app_version: Box<str>,
    os: Box<str>,
    arch: Box<str>,
    run_id: Box<str>,
    debug_build: bool,
}

impl Diagnostic {
    pub fn new(code: Code, cookie_count: Option<usize>, http_status: Option<u16>) -> Self {
        Self {
            code,
            cookie_count,
            http_status,
            checked_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            app_version: env!("CARGO_PKG_VERSION").into(),
            os: std::env::consts::OS.into(),
            arch: std::env::consts::ARCH.into(),
            run_id: RUN_ID
                .get_or_init(|| uuid::Uuid::new_v4().to_string())
                .as_str()
                .into(),
            debug_build: cfg!(debug_assertions),
        }
    }
}

pub(super) fn record(path: &Path, diagnostic: &Diagnostic) -> std::io::Result<()> {
    let _guard = WRITE_LOCK
        .lock()
        .map_err(|_| std::io::Error::other("diagnostic lock"))?;
    let mut entries: Vec<Diagnostic> = if fs::metadata(path).is_ok_and(|m| m.len() <= 64 * 1024) {
        serde_json::from_slice(&fs::read(path)?).unwrap_or_default()
    } else {
        Vec::new()
    };
    // Store transitions, not every QR poll. Only typed, non-identifying fields reach disk.
    if entries.last().is_some_and(|last| {
        last.code == diagnostic.code
            && last.run_id == diagnostic.run_id
            && last.cookie_count == diagnostic.cookie_count
            && last.http_status == diagnostic.http_status
            && last.app_version == diagnostic.app_version
            && last.debug_build == diagnostic.debug_build
            && diagnostic.checked_at.saturating_sub(last.checked_at) < 15 * 60
    }) {
        return Ok(());
    }
    entries.push(diagnostic.clone());
    if entries.len() > 32 {
        entries.drain(..entries.len() - 32);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_vec_pretty(&entries)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_is_bounded_and_repeated_polls_do_not_write() {
        let directory = std::env::temp_dir().join(format!("xiaoyin-auth-{}", uuid::Uuid::new_v4()));
        let path = directory.join("dingtalk-session.json");
        let mut diagnostic = Diagnostic::new(Code::CookieMissing, Some(0), None);
        record(&path, &diagnostic).unwrap();
        record(&path, &diagnostic).unwrap();
        let entries: Vec<Diagnostic> = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(entries.len(), 1);
        diagnostic.run_id = "next-process".into();
        record(&path, &diagnostic).unwrap();
        let entries: Vec<Diagnostic> = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(entries.len(), 2);
        for index in 0..40 {
            diagnostic.http_status = Some(400 + index);
            record(&path, &diagnostic).unwrap();
        }
        let entries: Vec<Diagnostic> = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(entries.len(), 32);
        assert_eq!(entries.last().unwrap().http_status, Some(439));
        diagnostic.app_version = "test-next-version".into();
        record(&path, &diagnostic).unwrap();
        let entries: Vec<Diagnostic> = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            entries.last().unwrap().app_version.as_ref(),
            "test-next-version"
        );
        fs::remove_dir_all(directory).unwrap();
    }
}
