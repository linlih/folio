// No commands for the page: the app calls the plugin from Rust only.
fn main() {
    tauri_plugin::Builder::new(&[]).android_path("android").build();
}
