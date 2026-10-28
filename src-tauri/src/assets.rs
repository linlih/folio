//! Files in cards (design/attachments.md §3): adding them, serving them to
//! the web view, opening them with another app.
//!
//! The web view hands over a file's bytes in pieces (`asset_begin`,
//! `asset_write` for each piece, `asset_finish`): pasted, dropped and picked
//! files all arrive as browser `File`s, on every platform, and Android's IPC
//! turns binary data into JSON, so a whole photo in one call would be slow
//! there. Reading goes through the `folio-asset` protocol, which supports
//! byte ranges.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::sync::Mutex;

use folio_store::{AssetInfo, Incoming};
use tauri::http::{Request as HttpRequest, Response as HttpResponse, StatusCode, header};
use tauri::ipc::Request;
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use crate::{AppState, CmdResult, CommandError, body_bytes, data_dir, lock, now_ms};

/// Files on their way in, by the id `asset_begin` gave out.
#[derive(Default)]
pub struct AssetState {
    incoming: Mutex<HashMap<String, Incoming>>,
}

fn other(e: impl std::fmt::Display) -> CommandError {
    CommandError::Other(e.to_string())
}

fn incoming(state: &AssetState) -> std::sync::MutexGuard<'_, HashMap<String, Incoming>> {
    state.incoming.lock().unwrap_or_else(|e| e.into_inner())
}

#[tauri::command]
pub fn asset_begin(state: tauri::State<AppState>, assets: tauri::State<AssetState>) -> CmdResult<String> {
    let file = Incoming::create(&folio_store::assets::assets_dir(&data_dir(&state)))?;
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let id = format!("{}-{}", now_ms(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    incoming(&assets).insert(id.clone(), file);
    Ok(id)
}

/// One piece of the file: the raw body, the id in `x-asset-id`.
#[tauri::command]
pub fn asset_write(assets: tauri::State<AssetState>, request: Request<'_>) -> CmdResult<()> {
    let bytes = body_bytes(request.body()).ok_or_else(|| other("asset_write expects the file's bytes"))?;
    let id = request.headers().get("x-asset-id").and_then(|v| v.to_str().ok()).ok_or_else(|| other("missing x-asset-id"))?;
    let mut all = incoming(&assets);
    let file = all.get_mut(id).ok_or_else(|| other("no such incoming file"))?;
    if let Err(e) = file.write(&bytes) {
        all.remove(id).expect("found above").discard();
        return Err(e.into());
    }
    Ok(())
}

#[tauri::command]
pub fn asset_cancel(assets: tauri::State<AssetState>, id: String) {
    if let Some(file) = incoming(&assets).remove(&id) {
        file.discard();
    }
}

/// Stores the finished file. HEIC photos become JPEG on Apple systems: the
/// other systems' web views cannot show HEIC (design/attachments.md §3.5).
#[tauri::command]
pub fn asset_finish(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    assets: tauri::State<AssetState>,
    id: String,
    name: String,
    mime: String,
) -> CmdResult<AssetInfo> {
    let file = incoming(&assets).remove(&id).ok_or_else(|| other("no such incoming file"))?;
    let (file, name, mime) = match heic::convert(&file, &name, &mime) {
        Some(Ok((jpeg, name))) => {
            file.discard();
            (jpeg, name, "image/jpeg".to_owned())
        }
        Some(Err(e)) => {
            tracing::warn!(error = %e, "could not convert a HEIC photo; keeping it as it is");
            (file, name, mime)
        }
        None => (file, name, mime),
    };
    let mime = if mime.is_empty() { "application/octet-stream".to_owned() } else { mime };
    let info = lock(&state)?.add_asset(file, &name, &mime, now_ms())?;
    tracing::info!(asset = %info.sha256, size = info.size, mime = %info.mime, "added a file");
    // Up soon, once the card that uses it is saved.
    crate::sync::poke_files(&app);
    Ok(info)
}

/// Opens a file with the system's app for it. The app gets a copy under
/// the original name in a temporary folder: it must not change the
/// library's file, and the library's name for it is only the hash.
#[tauri::command]
pub fn asset_open(app: tauri::AppHandle, state: tauri::State<AppState>, sha256: String, name: String) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let (path, _) = lock(&state)?.asset_file(&sha256)?.ok_or_else(|| other("[not-here] this file is not on this device"))?;
    let dir = std::env::temp_dir().join("folio-open").join(&sha256[..16]);
    std::fs::create_dir_all(&dir).map_err(other)?;
    let stem = folio_io::file_stem(&name);
    let target = dir.join(if stem.is_empty() { "file".to_owned() } else { stem });
    if !target.exists() {
        std::fs::copy(&path, &target).map_err(other)?;
    }
    app.opener().open_path(target.to_string_lossy(), None::<&str>).map_err(other)
}

/// Which of these files this device has.
#[tauri::command]
pub fn asset_have(state: tauri::State<AppState>, sha256s: Vec<String>) -> CmdResult<Vec<String>> {
    let store = lock(&state)?;
    let mut here = Vec::new();
    for sha in sha256s {
        if store.asset_file(&sha)?.is_some() {
            here.push(sha);
        }
    }
    Ok(here)
}

/// Hourly, with the backup check: marks files no card uses and deletes
/// those unused long enough.
pub fn sweep(state: &AppState) {
    match lock(state).map(|mut s| s.sweep_assets(now_ms())) {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => tracing::error!(error = %e, "sweeping files failed"),
        Err(e) => tracing::error!(error = %e, "sweeping files failed"),
    }
}

/// `folio-asset://localhost/<sha256>` (`http://folio-asset.localhost/…` on
/// Windows and Android). Answered off the main thread.
pub fn protocol<R: Runtime>(ctx: UriSchemeContext<'_, R>, request: HttpRequest<Vec<u8>>, responder: UriSchemeResponder) {
    let app = ctx.app_handle().clone();
    std::thread::spawn(move || {
        let response = serve(&app.state::<AppState>(), &request).unwrap_or_else(|status| {
            HttpResponse::builder().status(status).header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*").body(Vec::new()).expect("response")
        });
        responder.respond(response);
    });
}

fn serve(state: &AppState, request: &HttpRequest<Vec<u8>>) -> Result<HttpResponse<Vec<u8>>, StatusCode> {
    let sha256 = request.uri().path().trim_start_matches('/');
    let found = lock(state).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?.asset_file(sha256).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let (path, mime) = found.ok_or(StatusCode::NOT_FOUND)?;
    let mut file = std::fs::File::open(&path).map_err(|_| StatusCode::NOT_FOUND)?;
    let len = file.metadata().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?.len();
    let builder = HttpResponse::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        // The content of a hash never changes.
        .header(header::CACHE_CONTROL, "max-age=31536000, immutable")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    let range = request.headers().get(header::RANGE).and_then(|v| v.to_str().ok()).and_then(|v| parse_range(v, len));
    let read = |file: &mut std::fs::File, start: u64, n: u64| -> Result<Vec<u8>, StatusCode> {
        let mut out = vec![0u8; n as usize];
        file.seek(SeekFrom::Start(start)).and_then(|_| file.read_exact(&mut out)).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        Ok(out)
    };
    match range {
        Some((start, end)) => {
            let body = read(&mut file, start, end - start + 1)?;
            builder
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
                .body(body)
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
        }
        None => builder.body(read(&mut file, 0, len)?).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR),
    }
}

/// `bytes=a-b`, `bytes=a-` or `bytes=-n` within a file of `len` bytes, as
/// an inclusive range; None for anything else (the whole file is sent).
fn parse_range(value: &str, len: u64) -> Option<(u64, u64)> {
    let spec = value.strip_prefix("bytes=")?;
    if spec.contains(',') || len == 0 {
        return None;
    }
    let (a, b) = spec.split_once('-')?;
    let (start, end) = match (a.trim(), b.trim()) {
        ("", n) => {
            let n: u64 = n.parse().ok()?;
            (len.saturating_sub(n), len - 1)
        }
        (a, "") => (a.parse().ok()?, len - 1),
        (a, b) => (a.parse().ok()?, b.parse::<u64>().ok()?.min(len - 1)),
    };
    (start <= end && start < len).then_some((start, end))
}

/// HEIC → JPEG with the system's ImageIO, keeping the photo's metadata
/// (orientation included).
mod heic {
    use folio_store::Incoming;

    /// HEIF brands of photos (ISO/IEC 23008-12); AVIF is left alone.
    const BRANDS: [&[u8; 4]; 6] = [b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis"];

    pub fn is_heic(head: &[u8], name: &str, mime: &str) -> bool {
        let by_bytes = head.len() >= 12 && &head[4..8] == b"ftyp" && BRANDS.iter().any(|b| &head[8..12] == *b);
        let lower = name.to_lowercase();
        by_bytes || matches!(mime, "image/heic" | "image/heif") || lower.ends_with(".heic") || lower.ends_with(".heif")
    }

    /// The name with a .jpg extension.
    pub fn jpeg_name(name: &str) -> String {
        let stem = std::path::Path::new(name).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        format!("{}.jpg", if stem.is_empty() { "photo" } else { &stem })
    }

    /// None when the file is not HEIC or this system cannot convert it.
    pub fn convert(file: &Incoming, name: &str, mime: &str) -> Option<Result<(Incoming, String), String>> {
        let mut head = [0u8; 12];
        let n = std::fs::File::open(file.path()).and_then(|mut f| std::io::Read::read(&mut f, &mut head)).unwrap_or(0);
        if !is_heic(&head[..n], name, mime) {
            return None;
        }
        convert_heic(file).map(|r| r.map(|jpeg| (jpeg, jpeg_name(name))))
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    fn convert_heic(file: &Incoming) -> Option<Result<Incoming, String>> {
        let run = || -> Result<Incoming, String> {
            let bytes = std::fs::read(file.path()).map_err(|e| e.to_string())?;
            let jpeg = imageio::to_jpeg(&bytes, 0.9).ok_or("ImageIO could not convert it")?;
            let dir = file.path().parent().and_then(|p| p.parent()).ok_or("no assets folder")?;
            let mut out = Incoming::create(dir).map_err(|e| e.to_string())?;
            out.write(&jpeg).map_err(|e| e.to_string())?;
            Ok(out)
        };
        Some(run())
    }

    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    fn convert_heic(_file: &Incoming) -> Option<Result<Incoming, String>> {
        None
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    mod imageio {
        use std::ffi::c_void;

        type Ref = *const c_void;
        const UTF8: u32 = 0x0800_0100;
        const DOUBLE: isize = 13;

        #[link(name = "CoreFoundation", kind = "framework")]
        unsafe extern "C" {
            static kCFTypeDictionaryKeyCallBacks: c_void;
            static kCFTypeDictionaryValueCallBacks: c_void;
            fn CFDataCreate(alloc: Ref, bytes: *const u8, len: isize) -> Ref;
            fn CFDataCreateMutable(alloc: Ref, capacity: isize) -> Ref;
            fn CFDataGetLength(data: Ref) -> isize;
            fn CFDataGetBytePtr(data: Ref) -> *const u8;
            fn CFStringCreateWithCString(alloc: Ref, s: *const std::ffi::c_char, encoding: u32) -> Ref;
            fn CFNumberCreate(alloc: Ref, kind: isize, value: *const c_void) -> Ref;
            fn CFDictionaryCreate(alloc: Ref, keys: *const Ref, values: *const Ref, n: isize, kcb: *const c_void, vcb: *const c_void) -> Ref;
            fn CFRelease(r: Ref);
        }

        #[link(name = "ImageIO", kind = "framework")]
        unsafe extern "C" {
            static kCGImageDestinationLossyCompressionQuality: Ref;
            fn CGImageSourceCreateWithData(data: Ref, options: Ref) -> Ref;
            fn CGImageSourceGetCount(src: Ref) -> usize;
            fn CGImageSourceGetPrimaryImageIndex(src: Ref) -> usize;
            fn CGImageDestinationCreateWithData(data: Ref, kind: Ref, count: usize, options: Ref) -> Ref;
            fn CGImageDestinationAddImageFromSource(dest: Ref, src: Ref, index: usize, properties: Ref);
            fn CGImageDestinationFinalize(dest: Ref) -> bool;
        }

        /// Releases a Core Foundation object when dropped.
        struct Owned(Ref);
        impl Drop for Owned {
            fn drop(&mut self) {
                if !self.0.is_null() {
                    // SAFETY: a +1 reference from a Create function.
                    unsafe { CFRelease(self.0) }
                }
            }
        }

        /// The primary image as JPEG at `quality` (0–1), with its metadata.
        pub fn to_jpeg(bytes: &[u8], quality: f64) -> Option<Vec<u8>> {
            // SAFETY: Core Foundation / ImageIO calls with live arguments;
            // every created object is released by `Owned`.
            unsafe {
                let data = Owned(CFDataCreate(std::ptr::null(), bytes.as_ptr(), bytes.len() as isize));
                let src = Owned(CGImageSourceCreateWithData(data.0, std::ptr::null()));
                if src.0.is_null() || CGImageSourceGetCount(src.0) == 0 {
                    return None;
                }
                let out = Owned(CFDataCreateMutable(std::ptr::null(), 0));
                let jpeg = Owned(CFStringCreateWithCString(std::ptr::null(), c"public.jpeg".as_ptr(), UTF8));
                let dest = Owned(CGImageDestinationCreateWithData(out.0, jpeg.0, 1, std::ptr::null()));
                if dest.0.is_null() {
                    return None;
                }
                let q = Owned(CFNumberCreate(std::ptr::null(), DOUBLE, (&quality as *const f64).cast()));
                let keys = [kCGImageDestinationLossyCompressionQuality];
                let values = [q.0];
                let props = Owned(CFDictionaryCreate(
                    std::ptr::null(),
                    keys.as_ptr(),
                    values.as_ptr(),
                    1,
                    &kCFTypeDictionaryKeyCallBacks,
                    &kCFTypeDictionaryValueCallBacks,
                ));
                CGImageDestinationAddImageFromSource(dest.0, src.0, CGImageSourceGetPrimaryImageIndex(src.0), props.0);
                if !CGImageDestinationFinalize(dest.0) {
                    return None;
                }
                let len = CFDataGetLength(out.0) as usize;
                Some(std::slice::from_raw_parts(CFDataGetBytePtr(out.0), len).to_vec())
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn recognises_heic_by_content_or_name() {
            let mut head = [0u8; 12];
            head[4..8].copy_from_slice(b"ftyp");
            head[8..12].copy_from_slice(b"heic");
            assert!(is_heic(&head, "IMG_1.bin", ""));
            head[8..12].copy_from_slice(b"avif");
            assert!(!is_heic(&head, "a.avif", "image/avif"));
            assert!(is_heic(b"", "IMG_2.HEIC", ""));
            assert!(is_heic(b"", "x", "image/heif"));
            assert!(!is_heic(b"\x89PNG\r\n\x1a\n....", "a.png", "image/png"));
            assert_eq!(jpeg_name("IMG_2.HEIC"), "IMG_2.jpg");
            assert_eq!(jpeg_name(""), "photo.jpg");
        }

        /// Converts a real HEIC photo made by the system's own encoder.
        #[cfg(target_os = "macos")]
        #[test]
        fn converts_a_heic_photo_to_jpeg() {
            let dir = tempfile::tempdir().unwrap();
            let png = dir.path().join("a.png");
            let heic_path = dir.path().join("a.heic");
            // A 2×1 PNG.
            std::fs::write(&png, b"\x89\x50\x4e\x47\x0d\x0a\x1a\x0a\x00\x00\x00\x0d\x49\x48\x44\x52\x00\x00\x00\x02\x00\x00\x00\x01\x08\x02\x00\x00\x00\x7b\x40\xe8\xdd\x00\x00\x00\x0d\x49\x44\x41\x54\x78\x9c\x63\xf8\xcf\x00\x04\xff\x01\x07\x00\x01\xff\xe2\x23\x9e\x59\x00\x00\x00\x00\x49\x45\x4e\x44\xae\x42\x60\x82").unwrap();
            let ok = std::process::Command::new("sips").args(["-s", "format", "heic"]).arg(&png).arg("--out").arg(&heic_path).output().map(|o| o.status.success()).unwrap_or(false);
            if !ok {
                eprintln!("sips cannot write HEIC here; skipped");
                return;
            }
            let bytes = std::fs::read(&heic_path).unwrap();
            assert!(is_heic(&bytes[..12], "a.heic", ""));
            let jpeg = imageio::to_jpeg(&bytes, 0.9).expect("converted");
            assert_eq!(&jpeg[..3], b"\xff\xd8\xff", "a JPEG");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::parse_range;

    #[test]
    fn byte_ranges() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=900-", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=990-2000", 1000), Some((990, 999)));
        assert_eq!(parse_range("bytes=1000-", 1000), None);
        assert_eq!(parse_range("bytes=5-1", 1000), None);
        assert_eq!(parse_range("bytes=0-1,5-6", 1000), None);
        assert_eq!(parse_range("items=0-1", 1000), None);
    }
}
