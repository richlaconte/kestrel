// kestrel-host — Phase 0 spike
// One precompiled, generic Tauri v2 binary. Everything app-specific comes from a
// runtime manifest (kestrel.json): window config, app identity, and a frontend
// directory served over a custom kestrel:// protocol. No per-app compilation.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{State, WebviewUrl, WebviewWindowBuilder};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    app_id: String,
    title: String,
    #[serde(default = "default_width")]
    width: f64,
    #[serde(default = "default_height")]
    height: f64,
    /// Directory containing the app's built frontend (index.html at its root).
    frontend: String,
    /// Optional "native functions" module: privileged JS run in an embedded
    /// QuickJS engine inside the host (the spike's server-actions analogue).
    #[serde(default)]
    native: Option<String>,
    /// Dev mode: the kestrel:// protocol reverse-proxies to this URL (a Vite
    /// dev server) instead of serving `frontend` from disk. The window origin
    /// stays kestrel://localhost in dev and prod — IPC policy is identical —
    /// while Vite's HMR websocket connects to the dev server directly.
    #[serde(default)]
    dev_url: Option<String>,
    /// Headless-run safety net: exit after N ms so CI runs always terminate.
    #[serde(default)]
    exit_after_ms: Option<u64>,
}

fn default_width() -> f64 {
    800.0
}
fn default_height() -> f64 {
    600.0
}

/// Stand-in for the "store" std-lib module: an in-memory KV per app run.
struct Kv(Mutex<HashMap<String, String>>);

// ---- native-functions engine (QuickJS on a dedicated thread) ----

type NativeCall = (
    String, // function name
    String, // args as JSON
    std::sync::mpsc::Sender<Result<String, String>>,
);

struct NativeEngine(Option<Mutex<std::sync::mpsc::Sender<NativeCall>>>);

// Engine: rquickjs (QuickJS with first-class MSVC support — the earlier
// quick-js crate could not build on Windows, which blocked the CI matrix).
fn start_native_engine(script_path: PathBuf) -> std::sync::mpsc::Sender<NativeCall> {
    use rquickjs::{function::Func, Context, Function, Runtime};

    let (tx, rx) = std::sync::mpsc::channel::<NativeCall>();
    std::thread::spawn(move || {
        let rt = Runtime::new().expect("quickjs runtime");
        let context = Context::full(&rt).expect("quickjs context");

        context.with(|ctx| {
            let globals = ctx.globals();
            // Host bindings: the privileged surface native functions may touch.
            globals
                .set(
                    "hostReadFile",
                    Func::from(|path: String| -> String {
                        std::fs::read_to_string(&path).unwrap_or_else(|e| format!("ERR: {e}"))
                    }),
                )
                .expect("bind hostReadFile");
            globals
                .set(
                    "hostWriteFile",
                    Func::from(|path: String, contents: String| -> String {
                        match std::fs::write(&path, contents) {
                            Ok(_) => "ok".to_string(),
                            Err(e) => format!("ERR: {e}"),
                        }
                    }),
                )
                .expect("bind hostWriteFile");
            globals
                .set(
                    "hostLog",
                    Func::from(|msg: String| -> bool {
                        eprintln!("[native] {msg}");
                        true
                    }),
                )
                .expect("bind hostLog");

            ctx.eval::<(), _>(
                r#"
                globalThis.native = {};
                function __kestrel_dispatch(name, argsJson) {
                    const fn = globalThis.native[name];
                    if (!fn) throw new Error("no native function: " + name);
                    const result = fn(JSON.parse(argsJson));
                    return JSON.stringify(result === undefined ? null : result);
                }
                "#,
            )
            .expect("prelude");

            let user_src = std::fs::read_to_string(&script_path).expect("read native module");
            if let Err(e) = ctx.eval::<(), _>(user_src) {
                let detail = format!("{:?}", ctx.catch());
                panic!("eval native module: {e}: {detail}");
            }
        });

        while let Ok((name, args, reply)) = rx.recv() {
            let res = context.with(|ctx| -> Result<String, String> {
                let dispatch: Function = ctx
                    .globals()
                    .get("__kestrel_dispatch")
                    .map_err(|e| e.to_string())?;
                dispatch.call::<_, String>((name, args)).map_err(|e| {
                    // Surface the JS exception message when there is one.
                    let exc = ctx.catch();
                    exc.as_exception()
                        .and_then(|x| x.message())
                        .unwrap_or_else(|| e.to_string())
                })
            });
            let _ = reply.send(res);
        }
    });
    tx
}

// ---- the generic command surface (spike subset of `kestrel/native`) ----

#[tauri::command]
fn get_manifest(state: State<Manifest>) -> Manifest {
    state.inner().clone()
}

#[tauri::command]
fn kv_set(state: State<Kv>, key: String, value: String) {
    state.0.lock().unwrap().insert(key, value);
}

#[tauri::command]
fn kv_get(state: State<Kv>, key: String) -> Option<String> {
    state.0.lock().unwrap().get(&key).cloned()
}

/// Bridge: webview -> user's native function inside the embedded engine.
#[tauri::command]
fn call_native(
    engine: State<NativeEngine>,
    name: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let tx = engine
        .0
        .as_ref()
        .ok_or("this app declares no native module")?;
    let (rtx, rrx) = std::sync::mpsc::channel();
    tx.lock()
        .unwrap()
        .send((name, args.to_string(), rtx))
        .map_err(|e| e.to_string())?;
    let json = rrx
        .recv_timeout(std::time::Duration::from_secs(10))
        .map_err(|e| e.to_string())??;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

#[tauri::command]
fn echo(msg: String) -> String {
    format!("host echoes: {msg}")
}

/// Writes an on-disk proof that this app ran IPC against the shared host.
#[tauri::command]
fn prove(state: State<Manifest>, payload: String) -> Result<String, String> {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64;
    let proof = serde_json::json!({
        "appId": state.app_id,
        "title": state.title,
        "payload": payload,
        "provedAtMs": ts,
        "host": "kestrel-host 0.1.0 (shared binary, no recompile)",
    });
    let path = format!("/tmp/kestrel-proof-{}.json", state.app_id);
    fs::write(&path, serde_json::to_string_pretty(&proof).unwrap()).map_err(|e| e.to_string())?;
    Ok(format!("proof written to {path}"))
}

fn main() {
    // Manifest location: argv[1], else kestrel.json BESIDE THE EXECUTABLE —
    // a built bundle must work when double-clicked from any cwd.
    let manifest_path: PathBuf = match std::env::args().nth(1) {
        Some(p) => PathBuf::from(p),
        None => std::env::current_exe()
            .expect("current_exe")
            .parent()
            .expect("exe dir")
            .join("kestrel.json"),
    };
    let raw = fs::read_to_string(&manifest_path)
        .unwrap_or_else(|e| panic!("cannot read manifest {}: {e}", manifest_path.display()));
    let mut manifest: Manifest =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("invalid manifest: {e}"));

    // Test hook for headless CI runs of built bundles.
    if let Ok(ms) = std::env::var("KESTREL_EXIT_AFTER_MS") {
        if let Ok(ms) = ms.parse::<u64>() {
            manifest.exit_after_ms = Some(ms);
        }
    }

    // Relative paths in the manifest resolve against the manifest's own
    // directory, never the process cwd.
    let manifest_dir = manifest_path
        .canonicalize()
        .unwrap_or_else(|e| panic!("manifest path: {e}"))
        .parent()
        .expect("manifest dir")
        .to_path_buf();

    let frontend_dir: PathBuf = manifest_dir
        .join(&manifest.frontend)
        .canonicalize()
        .unwrap_or_else(|e| panic!("frontend dir {}: {e}", manifest.frontend));
    if let Some(n) = &manifest.native {
        manifest.native = Some(
            manifest_dir
                .join(n)
                .canonicalize()
                .unwrap_or_else(|e| panic!("native module {n}: {e}"))
                .to_string_lossy()
                .into_owned(),
        );
    }
    let dev_base = manifest.dev_url.clone();

    let engine = NativeEngine(manifest.native.as_ref().map(|p| {
        let script = PathBuf::from(p)
            .canonicalize()
            .unwrap_or_else(|e| panic!("native module {p}: {e}"));
        Mutex::new(start_native_engine(script))
    }));

    let window_cfg = manifest.clone();

    tauri::Builder::default()
        .manage(manifest)
        .manage(engine)
        .manage(Kv(Mutex::new(HashMap::new())))
        .register_uri_scheme_protocol("kestrel", move |_ctx, request| {
            // Dev mode: reverse-proxy everything to the frontend dev server.
            if let Some(base) = &dev_base {
                let pq = request
                    .uri()
                    .path_and_query()
                    .map(|x| x.as_str())
                    .unwrap_or("/");
                let target = format!("{}{}", base.trim_end_matches('/'), pq);
                return match minreq::get(&target).send() {
                    Ok(resp) => {
                        let mime = resp
                            .headers
                            .get("content-type")
                            .cloned()
                            .unwrap_or_else(|| "application/octet-stream".into());
                        tauri::http::Response::builder()
                            .status(resp.status_code as u16)
                            .header("Content-Type", mime)
                            .body(resp.into_bytes())
                            .unwrap()
                    }
                    Err(e) => tauri::http::Response::builder()
                        .status(502)
                        .header("Content-Type", "text/plain")
                        .body(format!("kestrel dev proxy: {e}").into_bytes())
                        .unwrap(),
                };
            }
            let rel = request.uri().path().trim_start_matches('/');
            let rel = if rel.is_empty() { "index.html" } else { rel };
            // Guard against path traversal out of the frontend dir.
            let file = frontend_dir.join(rel);
            let ok = file
                .canonicalize()
                .map(|f| f.starts_with(&frontend_dir))
                .unwrap_or(false);
            match (ok, fs::read(&file)) {
                (true, Ok(body)) => {
                    let mime = match rel.rsplit('.').next() {
                        Some("html") => "text/html",
                        Some("js") => "text/javascript",
                        Some("css") => "text/css",
                        Some("svg") => "image/svg+xml",
                        Some("json") => "application/json",
                        Some("png") => "image/png",
                        _ => "application/octet-stream",
                    };
                    tauri::http::Response::builder()
                        .header("Content-Type", mime)
                        .body(body)
                        .unwrap()
                }
                _ => tauri::http::Response::builder()
                    .status(404)
                    .body(Vec::new())
                    .unwrap(),
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_manifest,
            kv_set,
            kv_get,
            echo,
            prove,
            call_native
        ])
        .setup(move |app| {
            let url: tauri::Url = "kestrel://localhost/index.html".parse()?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title(&window_cfg.title)
                .inner_size(window_cfg.width, window_cfg.height)
                .build()?;
            if let Some(ms) = window_cfg.exit_after_ms {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(ms));
                    handle.exit(0);
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running kestrel-host");
}
