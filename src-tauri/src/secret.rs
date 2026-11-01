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

/// Where a sync key is kept, as `SyncSettings::key_in` records it; each
/// device uses one of them.
#[cfg_attr(target_os = "android", allow(dead_code))]
pub const KEYCHAIN: &str = "keychain";
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub const KEYSTORE: &str = "keystore";

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
    #[cfg(not(target_os = "android"))]
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
        #[cfg(not(target_os = "android"))]
        KEYCHAIN => {
            let _ = sealed;
            entry(name)?.get_password().map_err(|e| e.to_string())
        }
        other => Err(format!("this device cannot read a key kept in the {other}")),
    }
}

/// Forgets the secret (sync stopped on this device, an API key removed).
/// An entry that is not there is not an error.
pub fn delete(place: &str, name: &str) {
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
