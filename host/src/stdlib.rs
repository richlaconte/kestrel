// The webview-side std-lib (RFC-0001 §3, #17): commands kestrel-native calls
// straight from the webview, no native.ts needed. Each one rejects with a
// KestrelError, and the gated ones check the manifest's permissions first.
//
// Window commands are sync, so Tauri runs them on the main thread where
// window calls belong. File and store commands are async, so a big file never
// blocks painting.

use serde::Deserialize;
use tauri::{ipc::Response, AppHandle, Manager, State, WebviewWindow};

use crate::{error::KestrelError, scope, store::Store, window, Manifest};

/// The fs grant the webview's `fs` module checks: the same one native code
/// gets, so both sides of the app always see the same files.
pub struct WebFs(pub Option<scope::Fs>);

impl WebFs {
    fn get(&self, call: &str) -> Result<&scope::Fs, KestrelError> {
        self.0.as_ref().ok_or_else(|| {
            KestrelError::new(
                "permission_denied",
                format!(
                    "{call} needs the \"fs:app-data\", \"fs:pick\" or \"fs:all\" permission in kestrel.json"
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

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpenOptions {
    /// Names the window. Opening a label that's already open focuses it.
    label: Option<String>,
    title: Option<String>,
    width: Option<f64>,
    height: Option<f64>,
    #[serde(flatten)]
    window: window::WindowOptions,
}

/// Another window on one of the app's pages, with the same storage, lock and
/// IPC as the main one. Resolves to its label. Async: on Windows, creating a
/// window from a sync command deadlocks.
#[tauri::command]
pub async fn window_open(
    app: AppHandle,
    manifest: State<'_, Manifest>,
    shared: State<'_, window::Shared>,
    path: String,
    opts: Option<OpenOptions>,
) -> Result<String, KestrelError> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(1);

    let opts = opts.unwrap_or_default();
    let url = window::app_page(&path)?;
    let bad = |msg: String| KestrelError::new("io", format!("appWindow.open: {msg}"));
    let o = &opts.window;
    for (name, v) in [
        ("width", opts.width),
        ("height", opts.height),
        ("minWidth", o.min_width),
        ("minHeight", o.min_height),
        ("maxWidth", o.max_width),
        ("maxHeight", o.max_height),
    ] {
        if v.is_some_and(|v| !(v.is_finite() && v > 0.0)) {
            return Err(bad(format!("`{name}` must be a positive number")));
        }
    }
    let label = match opts.label {
        Some(l) => {
            let ok = !l.is_empty()
                && l.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_/:".contains(c));
            if !ok {
                return Err(bad(format!(
                    "`label` must be letters, digits, -, _, / and : (got {l:?})"
                )));
            }
            l
        }
        None => loop {
            let l = format!("window-{}", NEXT.fetch_add(1, Ordering::Relaxed));
            if app.get_webview_window(&l).is_none() {
                break l;
            }
        },
    };
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.unminimize();
        w.set_focus().map_err(window_err)?;
        return Ok(label);
    }
    let (w, h) = o.clamp(
        opts.width.unwrap_or(manifest.width),
        opts.height.unwrap_or(manifest.height),
    );
    let mut b = o
        .apply(window::app_window(&app, &label, url, &shared).map_err(window_err)?)
        .title(opts.title.as_deref().unwrap_or(&manifest.title))
        .inner_size(w, h);
    if o.center {
        b = b.center();
    }
    b.build().map_err(window_err)?;
    Ok(label)
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

// ---- permissions for the non-fs modules ----

fn require(manifest: &Manifest, permission: &str, call: &str) -> Result<(), KestrelError> {
    if manifest.permissions.iter().any(|p| p == permission) {
        Ok(())
    } else {
        Err(KestrelError::new(
            "permission_denied",
            format!("{call} needs the \"{permission}\" permission in kestrel.json"),
        ))
    }
}

// ---- dialog ----
// Showing a dialog needs no permission: the user is in control. Under
// `fs:pick`, what they pick becomes readable and writable through `fs`.
// The blocking calls run off the main thread (async commands); the main
// thread keeps the dialog itself responsive.

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FileDialogOptions {
    title: Option<String>,
    default_path: Option<String>,
    filters: Vec<FileFilter>,
}

#[derive(Deserialize)]
pub struct FileFilter {
    name: String,
    extensions: Vec<String>,
}

fn file_dialog(
    app: &AppHandle,
    window: &WebviewWindow,
    opts: FileDialogOptions,
) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    use tauri_plugin_dialog::DialogExt;
    let mut d = app.dialog().file().set_parent(window);
    if let Some(t) = opts.title {
        d = d.set_title(t);
    }
    if let Some(p) = opts.default_path {
        let p = std::path::PathBuf::from(p);
        // A path to a file names the file; a folder is where to start.
        match (p.is_dir(), p.file_name()) {
            (false, Some(name)) => {
                d = d.set_file_name(name.to_string_lossy());
                if let Some(dir) = p.parent().filter(|d| !d.as_os_str().is_empty()) {
                    d = d.set_directory(dir);
                }
            }
            _ => d = d.set_directory(p),
        }
    }
    for f in opts.filters {
        let exts: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
        d = d.add_filter(f.name, &exts);
    }
    d
}

/// The picked path as a string, recorded for `fs:pick`. None: cancelled.
fn picked(
    fs: &WebFs,
    path: Option<tauri_plugin_dialog::FilePath>,
    folder: bool,
) -> Result<Option<String>, KestrelError> {
    let Some(path) = path else { return Ok(None) };
    let path = path
        .into_path()
        .map_err(|e| KestrelError::new("io", e.to_string()))?;
    if let Some(fs) = &fs.0 {
        fs.record_pick(&path, folder);
    }
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn dialog_pick_file(
    app: AppHandle,
    window: WebviewWindow,
    fs: State<'_, WebFs>,
    opts: Option<FileDialogOptions>,
) -> Result<Option<String>, KestrelError> {
    let d = file_dialog(&app, &window, opts.unwrap_or_default());
    picked(&fs, d.blocking_pick_file(), false)
}

#[tauri::command]
pub async fn dialog_pick_folder(
    app: AppHandle,
    window: WebviewWindow,
    fs: State<'_, WebFs>,
    opts: Option<FileDialogOptions>,
) -> Result<Option<String>, KestrelError> {
    let d = file_dialog(&app, &window, opts.unwrap_or_default());
    picked(&fs, d.blocking_pick_folder(), true)
}

#[tauri::command]
pub async fn dialog_save(
    app: AppHandle,
    window: WebviewWindow,
    fs: State<'_, WebFs>,
    opts: Option<FileDialogOptions>,
) -> Result<Option<String>, KestrelError> {
    let d = file_dialog(&app, &window, opts.unwrap_or_default());
    picked(&fs, d.blocking_save_file(), false)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageOptions {
    message: String,
    #[serde(default)]
    title: Option<String>,
    /// "info" (default), "warning" or "error".
    #[serde(default)]
    kind: Option<String>,
    /// "ok" (default), "okCancel" or "yesNo".
    #[serde(default)]
    buttons: Option<String>,
}

/// True for OK/Yes, false for Cancel/No or a closed dialog.
#[tauri::command]
pub async fn dialog_message(
    app: AppHandle,
    window: WebviewWindow,
    opts: MessageOptions,
) -> Result<bool, KestrelError> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let bad = |field: &str, v: &str, ok: &str| {
        KestrelError::new(
            "io",
            format!("dialog.message: `{field}` must be {ok} (got {v:?})"),
        )
    };
    let kind = match opts.kind.as_deref().unwrap_or("info") {
        "info" => MessageDialogKind::Info,
        "warning" => MessageDialogKind::Warning,
        "error" => MessageDialogKind::Error,
        v => return Err(bad("kind", v, "\"info\", \"warning\" or \"error\"")),
    };
    let buttons = match opts.buttons.as_deref().unwrap_or("ok") {
        "ok" => MessageDialogButtons::Ok,
        "okCancel" => MessageDialogButtons::OkCancel,
        "yesNo" => MessageDialogButtons::YesNo,
        v => return Err(bad("buttons", v, "\"ok\", \"okCancel\" or \"yesNo\"")),
    };
    let mut d = app
        .dialog()
        .message(opts.message)
        .parent(&window)
        .kind(kind)
        .buttons(buttons);
    if let Some(t) = opts.title {
        d = d.title(t);
    }
    Ok(d.blocking_show())
}

// ---- notify ----

#[tauri::command]
pub async fn notify(
    app: AppHandle,
    manifest: State<'_, Manifest>,
    title: String,
    body: Option<String>,
) -> Result<(), KestrelError> {
    use tauri_plugin_notification::NotificationExt;
    require(&manifest, "notifications", "notify")?;
    let mut n = app.notification().builder().title(title);
    if let Some(b) = body {
        n = n.body(b);
    }
    n.show().map_err(|e| KestrelError::new("io", e.to_string()))
}

// ---- clipboard ----

#[tauri::command]
pub async fn clipboard_read_text(
    app: AppHandle,
    manifest: State<'_, Manifest>,
) -> Result<String, KestrelError> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    require(&manifest, "clipboard", "clipboard.readText")?;
    app.clipboard()
        .read_text()
        .map_err(|e| KestrelError::new("io", e.to_string()))
}

#[tauri::command]
pub async fn clipboard_write_text(
    app: AppHandle,
    manifest: State<'_, Manifest>,
    text: String,
) -> Result<(), KestrelError> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    require(&manifest, "clipboard", "clipboard.writeText")?;
    app.clipboard()
        .write_text(text)
        .map_err(|e| KestrelError::new("io", e.to_string()))
}

// ---- shell ----

#[tauri::command]
pub fn shell_open(manifest: State<Manifest>, url: String) -> Result<(), KestrelError> {
    require(&manifest, "shell:open", "shell.open")?;
    let parsed: tauri::Url = url
        .parse()
        .map_err(|e| KestrelError::new("io", format!("shell.open: {url:?} is not a URL ({e})")))?;
    crate::serve::open_external(&parsed).map_err(|e| KestrelError::new("io", e))
}
