//! Saving the page as a PDF file with no print dialog (web/src/print/print.ts
//! puts what is to be saved into #print-root; print.css lets only that onto
//! paper). Each desktop webview has its own way: WebKit's print operation
//! saving to a file on macOS, WebView2's PrintToPdf on Windows, WebKitGTK's
//! print operation to the "Print to File" printer on Linux.

use std::path::PathBuf;
use std::time::Duration;

/// Writes the page to `path` as PDF; returns once the file is written.
pub(crate) fn write(webview: &tauri::Webview, path: PathBuf) -> Result<(), String> {
    // A file of that name was agreed to be replaced in the save dialog; it
    // is removed first so that, on macOS, its appearing tells the save is done.
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    start(webview, path.clone(), tx)?;
    match rx.recv_timeout(Duration::from_secs(60)) {
        Ok(done) => done?,
        Err(_) => return Err("saving the PDF took too long".into()),
    }
    wait_for(&path)
}

/// The file is there and has stopped growing (macOS reports nothing when
/// the save ends; the others report it, so this returns at once there).
fn wait_for(path: &std::path::Path) -> Result<(), String> {
    let mut last = None;
    for _ in 0..300 {
        let size = std::fs::metadata(path).map(|m| m.len()).ok().filter(|&n| n > 0);
        if size.is_some() && size == last {
            return Ok(());
        }
        last = size;
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("the PDF was not written".into())
}

#[cfg(target_os = "macos")]
fn start(webview: &tauri::Webview, path: PathBuf, tx: std::sync::mpsc::Sender<Result<(), String>>) -> Result<(), String> {
    webview
        .with_webview(move |w| {
            use objc2_app_kit::{NSPrintInfo, NSPrintJobSavingURL, NSPrintSaveJob};
            use objc2_foundation::{NSString, NSURL};
            use objc2_web_kit::WKWebView;
            // SAFETY: on macOS the platform webview is a WKWebView, and this
            // runs on the main thread, as AppKit wants.
            let done = unsafe {
                let view: &WKWebView = &*(w.inner() as *const WKWebView);
                let info = NSPrintInfo::new();
                // print.css's @page margins (18mm by 16mm), which WebKit leaves to AppKit.
                info.setTopMargin(51.0);
                info.setBottomMargin(51.0);
                info.setLeftMargin(45.0);
                info.setRightMargin(45.0);
                info.setJobDisposition(NSPrintSaveJob);
                let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
                info.dictionary().insert(NSPrintJobSavingURL, &*url);
                let op = view.printOperationWithPrintInfo(&info);
                op.setShowsPrintPanel(false);
                op.setShowsProgressPanel(false);
                op.setCanSpawnSeparateThread(true);
                match view.window() {
                    // As a sheet, so WebKit lays the page out before it is saved
                    // (a plain runOperation comes out blank).
                    Some(window) => {
                        op.runOperationModalForWindow_delegate_didRunSelector_contextInfo(&window, None, None, std::ptr::null_mut());
                        Ok(())
                    }
                    None => Err("the window is not open".to_string()),
                }
            };
            let _ = tx.send(done);
        })
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "windows")]
fn start(webview: &tauri::Webview, path: PathBuf, tx: std::sync::mpsc::Sender<Result<(), String>>) -> Result<(), String> {
    webview
        .with_webview(move |w| {
            use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_7;
            use webview2_com::PrintToPdfCompletedHandler;
            use windows::core::{Interface, HSTRING};
            let reply = tx.clone();
            // SAFETY: WebView2 calls made on the thread that owns the webview.
            let started = unsafe {
                (|| -> windows::core::Result<()> {
                    let core: ICoreWebView2_7 = w.controller().CoreWebView2()?.cast()?;
                    let handler = PrintToPdfCompletedHandler::create(Box::new(move |result, ok| {
                        let ok: bool = ok.into();
                        let _ = reply.send(match result {
                            Err(e) => Err(e.to_string()),
                            Ok(()) if !ok => Err("the PDF was not written".into()),
                            Ok(()) => Ok(()),
                        });
                        Ok(())
                    }));
                    core.PrintToPdf(&HSTRING::from(path.as_path()), None, &handler)
                })()
            };
            if let Err(e) = started {
                let _ = tx.send(Err(e.to_string()));
            }
        })
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn start(webview: &tauri::Webview, path: PathBuf, tx: std::sync::mpsc::Sender<Result<(), String>>) -> Result<(), String> {
    webview
        .with_webview(move |w| {
            use webkit2gtk::PrintOperationExt;
            let done = (|| -> Result<(), String> {
                let uri = gtk::glib::filename_to_uri(&path, None).map_err(|e| e.to_string())?;
                let settings = gtk::PrintSettings::new();
                settings.set_printer("Print to File");
                settings.set("output-file-format", Some("pdf"));
                settings.set("output-uri", Some(uri.as_str()));
                let op = webkit2gtk::PrintOperation::new(&w.inner());
                op.set_print_settings(&settings);
                let reply = tx.clone();
                op.connect_finished(move |_| {
                    let _ = reply.send(Ok(()));
                });
                let reply = tx.clone();
                op.connect_failed(move |_, e| {
                    let _ = reply.send(Err(e.to_string()));
                });
                op.print();
                Ok(())
            })();
            if let Err(e) = done {
                let _ = tx.send(Err(e));
            }
        })
        .map_err(|e| e.to_string())
}
