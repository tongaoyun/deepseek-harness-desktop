use keyring::Entry;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub(super) struct AccessTokenSnapshot {
    pub access_token: String,
    pub expires_at: i64,
    pub employee: String,
    pub team_id: String,
    pub display_name: String,
}

pub(super) struct AccessTokenStore(Entry);

impl AccessTokenStore {
    pub fn new(identifier: &str) -> Result<Self, ()> {
        Entry::new(&format!("{identifier}.xiaoyin-session"), "session")
            .map(Self)
            .map_err(|_| ())
    }

    pub fn load(&self) -> Result<Option<AccessTokenSnapshot>, ()> {
        match self.0.get_password() {
            Ok(value) => serde_json::from_str(&value).map(Some).map_err(|_| ()),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(()),
        }
    }

    pub fn save(&self, snapshot: &AccessTokenSnapshot) -> Result<(), ()> {
        self.0
            .set_password(&serde_json::to_string(snapshot).map_err(|_| ())?)
            .map_err(|_| ())
    }

    pub fn clear(&self) -> Result<(), ()> {
        match self.0.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(()),
        }
    }
}
