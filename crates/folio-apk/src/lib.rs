//! Android updates without the browser (design/ARCHITECTURE.md §7.3): the
//! app downloads the new APK into [`Apk::updates_dir`] and hands it to the
//! system installer with [`Apk::install`]. The installer only accepts a
//! package signed with the same key as the installed app, so a wrong file
//! cannot replace it. It also keeps what other apps share to Folio from
//! their share sheets, for the inbox ([`Apk::take_shared`]), and leaves
//! for the background when Back has nowhere to go ([`Apk::to_background`]). On other
//! platforms the plugin does nothing.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

#[cfg(target_os = "android")]
pub use android::{Apk, ApkExt};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("folio-apk")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = _api.register_android_plugin("dev.folio.apk", "ApkPlugin")?;
                _app.manage(Apk(handle));
            }
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
mod android {
    use serde::{Deserialize, Serialize};
    use std::path::{Path, PathBuf};
    use tauri::plugin::PluginHandle;
    use tauri::{Manager, Runtime};

    pub struct Apk<R: Runtime>(pub(crate) PluginHandle<R>);

    #[derive(Deserialize)]
    struct Dir {
        path: String,
    }

    #[derive(Serialize)]
    struct InstallArgs<'a> {
        path: &'a str,
    }

    #[derive(Deserialize)]
    struct Shared {
        text: Option<String>,
    }

    #[derive(Deserialize)]
    struct Started {
        started: bool,
    }

    impl<R: Runtime> Apk<R> {
        /// The folder downloads go to (in the app's cache, shared with the
        /// installer through a FileProvider). Emptied when the app starts.
        pub fn updates_dir(&self) -> Result<PathBuf, String> {
            let dir: Dir = self.0.run_mobile_plugin("updatesDir", ()).map_err(|e| e.to_string())?;
            Ok(PathBuf::from(dir.path))
        }

        /// Opens the system installer on `path` (inside [`Self::updates_dir`]).
        /// `false`: the app may not install packages yet, and the system page
        /// that allows it was opened instead.
        pub fn install(&self, path: &Path) -> Result<bool, String> {
            let path = path.to_str().ok_or("not a UTF-8 path")?;
            let started: Started = self.0.run_mobile_plugin("install", InstallArgs { path }).map_err(|e| e.to_string())?;
            Ok(started.started)
        }
    }

    impl<R: Runtime> Apk<R> {
        /// Text another app shared to Folio since the last call, once.
        pub fn take_shared(&self) -> Result<Option<String>, String> {
            let shared: Shared = self.0.run_mobile_plugin("takeShared", ()).map_err(|e| e.to_string())?;
            Ok(shared.text)
        }

        /// Sends the app to the background, as the Home button does.
        pub fn to_background(&self) -> Result<(), String> {
            self.0.run_mobile_plugin::<serde::de::IgnoredAny>("toBackground", ()).map(drop).map_err(|e| e.to_string())
        }
    }

    pub trait ApkExt<R: Runtime> {
        fn apk(&self) -> &Apk<R>;
    }

    impl<R: Runtime, T: Manager<R>> ApkExt<R> for T {
        fn apk(&self) -> &Apk<R> {
            self.state::<Apk<R>>().inner()
        }
    }
}
