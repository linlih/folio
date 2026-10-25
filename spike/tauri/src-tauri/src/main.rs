// Minimal shell: loads the spike page in the platform WebView (WKWebView on
// macOS/iOS) and lets it write benchmark results next to the other results.
use std::path::PathBuf;

use tauri::Manager;

fn results_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../results")
}

#[tauri::command]
fn save_results(name: String, json: String) -> Result<(), String> {
    let dir = results_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("webview-{name}.json")), json).map_err(|e| e.to_string())
}

#[tauri::command]
fn finish(app: tauri::AppHandle) {
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // SPIKE_AUTO=typo|css|perf|board picks the page; default is ?auto=all.
            if let Ok(page) = std::env::var("SPIKE_AUTO") {
                if let Some(window) = app.get_webview_window("main") {
                    let url: tauri::Url = format!("http://localhost:5199/?auto={page}").parse()?;
                    window.navigate(url)?;
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![save_results, finish])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
