// The webview-side std-lib (RFC-0001 §3, #17): commands kestrel-native calls
// straight from the webview, no native.ts needed. Each one rejects with a
// KestrelError, and the gated ones check the manifest's permissions first.
//
// Window commands are sync, so Tauri runs them on the main thread where
// window calls belong. File and store commands are async, so a big file never
// blocks painting.

use tauri::{ipc::Response, AppHandle, State, WebviewWindow};

use crate::{error::KestrelError, scope, store::Store, Manifest};

/// The fs grant the webview's `fs` module checks: the same one native code
/// gets, so both sides of the app always see the same files.
pub struct WebFs(pub Option<scope::Fs>);

impl WebFs {
    fn get(&self, call: &str) -> Result<&scope::Fs, KestrelError> {
        self.0.as_ref().ok_or_else(|| {
            KestrelError::new(
                "permission_denied",
                format!(
                    "{call} needs the \"fs:app-data\" or \"fs:all\" permission in kestrel.json"
                ),
            )
        })
    }
}

fn window_err(e: tauri::Error) -> KestrelError {
    KestrelError::new("io", e.to_string())
}

// ---- app ----

#[tauri::command]
pub fn app_version(manifest: State<Manifest>) -> String {
    manifest.version.clone()
}

#[tauri::command]
pub fn app_quit(app: AppHandle) {
    app.exit(0);
}

// ---- window ----

#[tauri::command]
pub fn window_set_title(window: WebviewWindow, title: String) -> Result<(), KestrelError> {
    window.set_title(&title).map_err(window_err)
}

#[tauri::command]
pub fn window_minimize(window: WebviewWindow) -> Result<(), KestrelError> {
    window.minimize().map_err(window_err)
}

#[tauri::command]
pub fn window_maximize(window: WebviewWindow) -> Result<(), KestrelError> {
    window.maximize().map_err(window_err)
}

#[tauri::command]
pub fn window_close(window: WebviewWindow) -> Result<(), KestrelError> {
    window.close().map_err(window_err)
}

// ---- fs ----

#[tauri::command]
pub async fn fs_read_text(fs: State<'_, WebFs>, path: String) -> Result<String, KestrelError> {
    fs.get("fs.readText")?.read(&path)
}

#[tauri::command]
pub async fn fs_read_bytes(fs: State<'_, WebFs>, path: String) -> Result<Response, KestrelError> {
    // Raw bytes: the webview gets an ArrayBuffer, not a JSON number array.
    fs.get("fs.readBytes")?.read_bytes(&path).map(Response::new)
}

#[tauri::command]
pub async fn fs_write_text(
    fs: State<'_, WebFs>,
    path: String,
    contents: String,
) -> Result<(), KestrelError> {
    fs.get("fs.writeText")?.write(&path, &contents)
}

#[tauri::command]
pub async fn fs_exists(fs: State<'_, WebFs>, path: String) -> Result<bool, KestrelError> {
    fs.get("fs.exists")?.exists(&path)
}

#[tauri::command]
pub fn fs_app_data_dir(fs: State<WebFs>) -> Result<String, KestrelError> {
    Ok(fs.get("fs.appDataDir")?.root.to_string_lossy().into_owned())
}

// ---- store ----
// No permission: like localStorage, it is the app's own and nobody else's.

#[tauri::command]
pub async fn store_get(
    store: State<'_, Store>,
    key: String,
) -> Result<Option<serde_json::Value>, KestrelError> {
    Ok(store.get(&key))
}

#[tauri::command]
pub async fn store_set(
    store: State<'_, Store>,
    key: String,
    value: serde_json::Value,
) -> Result<(), KestrelError> {
    store.set(key, value)
}

#[tauri::command]
pub async fn store_delete(store: State<'_, Store>, key: String) -> Result<bool, KestrelError> {
    store.delete(&key)
}

#[tauri::command]
pub async fn store_keys(store: State<'_, Store>) -> Result<Vec<String>, KestrelError> {
    Ok(store.keys())
}
