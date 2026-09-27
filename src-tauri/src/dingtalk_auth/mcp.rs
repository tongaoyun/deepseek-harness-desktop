use std::sync::atomic::{AtomicU64, Ordering};

// Odd epochs revoke access; successful login advances to an even epoch.
static SESSION_EPOCH: AtomicU64 = AtomicU64::new(0);

pub(crate) fn session_epoch() -> u64 {
    SESSION_EPOCH.load(Ordering::SeqCst)
}

pub(super) fn revoke_session() {
    let _ = SESSION_EPOCH.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |epoch| {
        Some((epoch + 2) | 1)
    });
}

pub(super) fn activate_session(epoch: u64) {
    if epoch % 2 == 1 {
        let _ =
            SESSION_EPOCH.compare_exchange(epoch, epoch + 1, Ordering::SeqCst, Ordering::SeqCst);
    }
}

#[cfg(test)]
fn session_revoked(epoch: u64) -> bool {
    epoch % 2 == 1 || epoch != session_epoch()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logout_revokes_old_runtimes_and_late_identity_checks_cannot_restore_them() {
        let original = session_epoch();
        assert!(!session_revoked(original));
        revoke_session();
        let logged_out = session_epoch();
        assert!(session_revoked(original));
        assert!(session_revoked(logged_out));
        activate_session(original);
        assert!(session_revoked(session_epoch()));
        activate_session(logged_out);
        assert!(!session_revoked(session_epoch()));
        assert!(session_revoked(original));
        assert!(session_revoked(logged_out));
    }
}
