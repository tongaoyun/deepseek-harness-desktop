use keyring::Entry;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::webview::cookie::{Cookie, time::OffsetDateTime};

const MAX_AGE_SECONDS: i64 = 7 * 24 * 60 * 60;
const MAX_SNAPSHOT_BYTES: usize = 64 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    saved_at: i64,
    cookies: Vec<String>,
}

pub(super) struct SessionStore(Entry);

impl SessionStore {
    pub fn new(identifier: &str, cookie_url: &str, user_url: &str) -> Result<Self, ()> {
        let account = format!("{:x}", Sha256::digest(format!("{cookie_url}\n{user_url}")));
        Entry::new(&format!("{identifier}.erp-session"), &account)
            .map(Self)
            .map_err(|_| ())
    }

    pub fn load(&self) -> Result<Vec<Cookie<'static>>, ()> {
        let value = match self.0.get_password() {
            Ok(value) => value,
            Err(keyring::Error::NoEntry) => return Ok(Vec::new()),
            Err(_) => return Err(()),
        };
        match decode(&value, OffsetDateTime::now_utc()) {
            Ok(cookies) if !cookies.is_empty() => Ok(cookies),
            _ => {
                self.clear()?;
                Ok(Vec::new())
            }
        }
    }

    pub fn save(&self, cookies: &[Cookie<'static>]) -> Result<(), ()> {
        let value = serde_json::to_string(&Snapshot {
            saved_at: OffsetDateTime::now_utc().unix_timestamp(),
            cookies: cookies.iter().map(ToString::to_string).collect(),
        })
        .map_err(|_| ())?;
        if value.len() > MAX_SNAPSHOT_BYTES {
            return Err(());
        }
        self.0.set_password(&value).map_err(|_| ())
    }

    pub fn clear(&self) -> Result<(), ()> {
        match self.0.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(()),
        }
    }
}

fn decode(value: &str, now: OffsetDateTime) -> Result<Vec<Cookie<'static>>, ()> {
    if value.len() > MAX_SNAPSHOT_BYTES {
        return Err(());
    }
    let snapshot: Snapshot = serde_json::from_str(value).map_err(|_| ())?;
    let age = now.unix_timestamp().saturating_sub(snapshot.saved_at);
    if !(0..MAX_AGE_SECONDS).contains(&age) {
        return Ok(Vec::new());
    }
    let mut cookies = Vec::new();
    for value in snapshot.cookies {
        let mut cookie = Cookie::parse(value).map_err(|_| ())?.into_owned();
        if cookie
            .expires_datetime()
            .is_some_and(|expiry| expiry <= now)
            || cookie
                .max_age()
                .is_some_and(|max_age| max_age.whole_seconds() <= age)
        {
            continue;
        }
        if let Some(max_age) = cookie.max_age() {
            cookie.set_max_age(max_age - tauri::webview::cookie::time::Duration::seconds(age));
        }
        cookies.push(cookie);
    }
    Ok(cookies)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_session_cookies_with_their_scope_and_security_attributes() {
        let now = OffsetDateTime::now_utc();
        let value = serde_json::to_string(&Snapshot {
            saved_at: now.unix_timestamp(),
            cookies: vec![
                "SESSION=secret; Domain=erp.example; Path=/eshop/; HttpOnly; Secure; SameSite=Lax"
                    .into(),
            ],
        })
        .unwrap();
        let cookies = decode(&value, now).unwrap();
        assert_eq!(cookies.len(), 1);
        assert_eq!(cookies[0].name(), "SESSION");
        assert_eq!(cookies[0].value(), "secret");
        assert_eq!(cookies[0].domain(), Some("erp.example"));
        assert_eq!(cookies[0].path(), Some("/eshop/"));
        assert_eq!(cookies[0].http_only(), Some(true));
        assert_eq!(cookies[0].secure(), Some(true));
        assert_eq!(
            cookies[0].same_site(),
            Some(tauri::webview::cookie::SameSite::Lax)
        );
    }

    #[test]
    fn expired_deleted_and_stale_cookies_are_not_restored() {
        let now = OffsetDateTime::now_utc();
        let mut snapshot = Snapshot {
            saved_at: now.unix_timestamp(),
            cookies: vec![
                "old=secret; Expires=Thu, 01 Jan 1970 00:00:00 GMT".into(),
                "deleted=secret; Max-Age=0".into(),
                "SESSION=current".into(),
            ],
        };
        let cookies = decode(&serde_json::to_string(&snapshot).unwrap(), now).unwrap();
        assert_eq!(cookies.len(), 1);
        assert_eq!(cookies[0].name(), "SESSION");
        for saved_at in [
            now.unix_timestamp() - MAX_AGE_SECONDS,
            now.unix_timestamp() + 1,
        ] {
            snapshot.saved_at = saved_at;
            assert!(
                decode(&serde_json::to_string(&snapshot).unwrap(), now)
                    .unwrap()
                    .is_empty()
            );
        }
        assert!(decode("{broken", now).is_err());
    }

    #[test]
    fn restoration_does_not_extend_relative_cookie_lifetimes() {
        let now = OffsetDateTime::now_utc();
        let snapshot = Snapshot {
            saved_at: now.unix_timestamp() - 60,
            cookies: vec![
                "expired=secret; Max-Age=30".into(),
                "active=secret; Max-Age=120".into(),
            ],
        };
        let cookies = decode(&serde_json::to_string(&snapshot).unwrap(), now).unwrap();
        assert_eq!(cookies.len(), 1);
        assert_eq!(cookies[0].name(), "active");
        assert_eq!(cookies[0].max_age().unwrap().whole_seconds(), 60);
    }

    #[test]
    #[ignore = "uses an isolated entry in the operating system credential store"]
    fn system_store_survives_reopening_and_logout_removes_credentials() {
        let identifier = format!("com.instudio.xiaoyin.test.{}", uuid::Uuid::new_v4());
        let store = SessionStore::new(
            &identifier,
            "https://erp.example/eshop/",
            "https://erp.example/auth/user",
        )
        .unwrap();
        assert!(store.load().unwrap().is_empty());
        store
            .save(&[
                Cookie::parse("SESSION=test; Domain=erp.example; Path=/eshop/; HttpOnly").unwrap(),
            ])
            .unwrap();
        let restored = SessionStore::new(
            &identifier,
            "https://erp.example/eshop/",
            "https://erp.example/auth/user",
        )
        .unwrap();
        let result = restored.load();
        store.clear().unwrap();
        assert_eq!(result.unwrap()[0].value(), "test");
        assert!(restored.load().unwrap().is_empty());
    }
}
