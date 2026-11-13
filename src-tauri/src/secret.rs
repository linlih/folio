//! The sync key out of the library (design/ARCHITECTURE.md §5.6, item 4):
//! in the system keychain on computers and iPhones (macOS and iOS
//! Keychain, Windows Credential Manager, the Secret Service on Linux), and
//! on Android encrypted with a key that never leaves the Android Keystore,
//! the encrypted copy kept in the library. A copy of the library (a
//! backup, a synced or copied folder) then no longer holds the key.
//!
//! Where none of this works (a Linux without a Secret Service), the key
//! stays in the library as before, and sync keeps working.
//!
//! The AI providers' API keys (ai.rs) are kept the same way.
//!
//! On macOS the keys are in a file instead (`keys.json` in the app's own
//! folder, beside the pointer to the library and readable by the user
//! only). The Keychain remembers "Always Allow" by team for apps signed
//! with an Apple Developer ID, and by the exact build for every other app:
//! Folio, signed with its own certificate, was asked about again for each
//! key after every update. A key found only in the Keychain (kept by a
//! version before 0.1.32) is read there once, copied to the file and left
//! where it was, so an older version still finds it.

/// Where a sync key is kept, as `SyncSettings::key_in` records it; each
/// device uses one of them.
#[cfg_attr(target_os = "android", allow(dead_code))]
pub const KEYCHAIN: &str = "keychain";
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub const KEYSTORE: &str = "keystore";
/// macOS: the key file in the app's folder.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const FILE: &str = "file";

/// What the keychain lists the entries under.
#[cfg(not(target_os = "android"))]
const SERVICE: &str = "Folio";

/// An entry by its name: "sync key <space>/<device>" for one device of
/// one sync space (two libraries on a computer, or a library that joined
/// again, never share one), "ai key <provider>" for an API key.
#[cfg(not(target_os = "android"))]
fn entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, name).map_err(|e| e.to_string())
}

/// Keeps `secret` under the entry `name`. Returns where it went and, on
/// Android, the encrypted copy for the library to hold. Read back before
/// it is reported kept, so a keychain that accepts and loses it is caught.
pub fn put(_app: &tauri::AppHandle, name: &str, secret: &str) -> Result<(&'static str, String), String> {
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_folio_apk::ApkExt;
        let sealed = _app.apk().seal(secret)?;
        if _app.apk().open(&sealed)? != secret {
            return Err("the keystore gave back something else".into());
        }
        let _ = name;
        Ok((KEYSTORE, sealed))
    }
    #[cfg(target_os = "macos")]
    {
        file::put(&file::dir(_app)?, name, secret)?;
        Ok((FILE, String::new()))
    }
    #[cfg(not(any(target_os = "android", target_os = "macos")))]
    {
        let e = entry(name)?;
        e.set_password(secret).map_err(|e| e.to_string())?;
        if e.get_password().map_err(|e| e.to_string())? != secret {
            return Err("the keychain gave back something else".into());
        }
        Ok((KEYCHAIN, String::new()))
    }
}

/// The secret kept by [`put`]: `sealed` is the encrypted copy it returned.
pub fn get(_app: &tauri::AppHandle, place: &str, name: &str, sealed: &str) -> Result<String, String> {
    match place {
        #[cfg(target_os = "android")]
        KEYSTORE => {
            use tauri_plugin_folio_apk::ApkExt;
            let _ = name;
            _app.apk().open(sealed)
        }
        #[cfg(target_os = "macos")]
        FILE | KEYCHAIN => {
            let _ = sealed;
            let dir = file::dir(_app)?;
            if let Some(secret) = file::get(&dir, name)? {
                return Ok(secret);
            }
            if place == FILE {
                return Err("the key is not in the key file".into());
            }
            // Kept in the Keychain by an earlier version: asked for once more.
            let secret = entry(name)?.get_password().map_err(|e| e.to_string())?;
            match file::put(&dir, name, &secret) {
                Ok(()) => tracing::info!(entry = name, "a key moved from the keychain to the key file"),
                Err(e) => tracing::warn!(error = %e, entry = name, "could not copy a key to the key file; it stays in the keychain"),
            }
            Ok(secret)
        }
        #[cfg(not(any(target_os = "android", target_os = "macos")))]
        KEYCHAIN => {
            let _ = sealed;
            entry(name)?.get_password().map_err(|e| e.to_string())
        }
        other => Err(format!("this device cannot read a key kept in the {other}")),
    }
}

/// Forgets the secret (sync stopped on this device, an API key removed).
/// An entry that is not there is not an error.
pub fn delete(_app: &tauri::AppHandle, place: &str, name: &str) {
    #[cfg(target_os = "macos")]
    if place == FILE || place == KEYCHAIN {
        if let Err(e) = file::dir(_app).and_then(|dir| file::delete(&dir, name)) {
            tracing::warn!(error = %e, entry = name, "could not remove a key from the key file");
        }
    }
    // macOS too: the copy an earlier version left in the Keychain.
    #[cfg(not(target_os = "android"))]
    if place == KEYCHAIN {
        let gone = entry(name).and_then(|e| match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        });
        if let Err(e) = gone {
            tracing::warn!(error = %e, entry = name, "could not remove a key from the keychain");
        }
    }
    // On Android the encrypted copy goes with the settings; the Keystore key
    // stays for the next time sync is set up.
    let _ = (place, name);
}

/// The key file: `keys.json`, entry name → secret, for the user alone
/// (0600 in a 0700 folder). Written whole to a new file that takes the old
/// one's place, so a crash leaves one or the other.
#[cfg(any(target_os = "macos", test))]
mod file {
    use std::collections::BTreeMap;
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    const NAME: &str = "keys.json";
    static LOCK: Mutex<()> = Mutex::new(());

    /// The app's own folder (not the library, which may be copied or moved).
    #[cfg(target_os = "macos")]
    pub fn dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
        use tauri::Manager;
        app.path().app_data_dir().map_err(|e| e.to_string())
    }

    fn read(dir: &Path) -> Result<BTreeMap<String, String>, String> {
        match std::fs::read(dir.join(NAME)) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("the key file cannot be read: {e}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(e) => Err(e.to_string()),
        }
    }

    fn write(dir: &Path, keys: &BTreeMap<String, String>) -> Result<(), String> {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let io = |e: std::io::Error| e.to_string();
        std::fs::create_dir_all(dir).map_err(io)?;
        let tmp: PathBuf = dir.join(format!("{NAME}.{}.tmp", std::process::id()));
        let _ = std::fs::remove_file(&tmp);
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp).map_err(io)?;
        f.set_permissions(std::fs::Permissions::from_mode(0o600)).map_err(io)?;
        f.write_all(&serde_json::to_vec_pretty(keys).map_err(|e| e.to_string())?).map_err(io)?;
        f.sync_all().map_err(io)?;
        drop(f);
        std::fs::rename(&tmp, dir.join(NAME)).map_err(io)
    }

    pub fn get(dir: &Path, name: &str) -> Result<Option<String>, String> {
        let _held = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        Ok(read(dir)?.remove(name))
    }

    /// Kept only once it reads back the same.
    pub fn put(dir: &Path, name: &str, secret: &str) -> Result<(), String> {
        let _held = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut keys = read(dir)?;
        keys.insert(name.to_owned(), secret.to_owned());
        write(dir, &keys)?;
        if read(dir)?.get(name).map(String::as_str) != Some(secret) {
            return Err("the key file gave back something else".into());
        }
        Ok(())
    }

    pub fn delete(dir: &Path, name: &str) -> Result<(), String> {
        let _held = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut keys = read(dir)?;
        if keys.remove(name).is_some() {
            write(dir, &keys)?;
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        #[test]
        fn keeps_keys_for_the_user_alone() {
            let tmp = tempfile::tempdir().unwrap();
            let dir = tmp.path().join("app");
            assert_eq!(get(&dir, "sync key a/b").unwrap(), None);
            put(&dir, "sync key a/b", "s3cret").unwrap();
            put(&dir, "ai key x", "sk-1").unwrap();
            put(&dir, "ai key x", "sk-2").unwrap();
            assert_eq!(get(&dir, "sync key a/b").unwrap().as_deref(), Some("s3cret"));
            assert_eq!(get(&dir, "ai key x").unwrap().as_deref(), Some("sk-2"));
            assert_eq!(std::fs::metadata(dir.join(NAME)).unwrap().permissions().mode() & 0o777, 0o600);
            delete(&dir, "ai key x").unwrap();
            delete(&dir, "never there").unwrap();
            assert_eq!(get(&dir, "ai key x").unwrap(), None);
            assert_eq!(get(&dir, "sync key a/b").unwrap().as_deref(), Some("s3cret"));
            // Nothing left behind by the writes.
            assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        }

        #[test]
        fn a_damaged_file_is_an_error_not_an_empty_one() {
            let tmp = tempfile::tempdir().unwrap();
            std::fs::write(tmp.path().join(NAME), b"{ not json").unwrap();
            assert!(get(tmp.path(), "a").is_err());
            assert!(put(tmp.path(), "a", "b").is_err());
            assert_eq!(std::fs::read(tmp.path().join(NAME)).unwrap(), b"{ not json");
        }
    }
}
