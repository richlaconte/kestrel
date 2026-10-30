// kestrel-host — Phase 0 spike
// One precompiled, generic Tauri v2 binary. Everything app-specific comes from a
// runtime manifest (kestrel.json): window config, app identity, and a frontend
// directory served over a custom kestrel:// protocol. No per-app compilation.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

mod error;
mod scope;
mod serve;
mod stdlib;
mod store;
mod window;

use error::KestrelError;
use serde::{Deserialize, Serialize};
use tauri::{State, WebviewUrl, WebviewWindowBuilder};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    app_id: String,
    title: String,
    /// The app's version, for `app.version()`. The CLI fills it from
    /// kestrel.json or package.json.
    #[serde(default = "default_version")]
    version: String,
    #[serde(default = "default_width")]
    width: f64,
    #[serde(default = "default_height")]
    height: f64,
    /// resizable, min/max size, center, decorations, titleBarStyle,
    /// rememberWindow (#23).
    #[serde(flatten)]
    window: window::WindowOptions,
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
    /// Content-Security-Policy for the built app's HTML. Absent: the
    /// default policy. Empty string: none. Never applied in dev.
    #[serde(default)]
    csp: Option<String>,
    /// Capabilities granted to native code (RFC-0001 §6). Empty: no host
    /// bindings beyond logging, a pure sandboxed webview.
    #[serde(default)]
    permissions: Vec<String>,
    /// Dev only: reload the native module from disk whenever a
    /// `reload-native` line arrives on stdin. `kestrel dev` sends one after
    /// it recompiles native.ts.
    #[serde(default)]
    dev_reload: bool,
    /// Headless-run safety net: exit after N ms so CI runs always terminate.
    #[serde(default)]
    exit_after_ms: Option<u64>,
}

fn default_version() -> String {
    "0.0.0".into()
}
fn default_width() -> f64 {
    800.0
}
fn default_height() -> f64 {
    600.0
}

// ---- native-functions engine (QuickJS on a dedicated thread) ----

/// What the engine thread receives: a call, or (dev only) an order to reload
/// the native module from disk.
enum EngineMsg {
    Call(
        String, // function name
        String, // args as JSON
        std::sync::mpsc::Sender<Result<String, KestrelError>>,
    ),
    Reload,
}

struct NativeEngine(Option<Mutex<std::sync::mpsc::Sender<EngineMsg>>>);

// Engine: rquickjs (QuickJS with first-class MSVC support — the earlier
// quick-js crate could not build on Windows, which blocked the CI matrix).
// One engine thread per app; calls and reloads are handled in order, so a
// reload never lands in the middle of a call.
fn start_native_engine(
    script_path: PathBuf,
    fs: Option<scope::Fs>,
) -> std::sync::mpsc::Sender<EngineMsg> {
    let (tx, rx) = std::sync::mpsc::channel::<EngineMsg>();
    std::thread::spawn(move || {
        let mut engine = LoadedModule::load(&script_path, fs.clone());
        while let Ok(msg) = rx.recv() {
            match msg {
                EngineMsg::Call(name, args, reply) => {
                    let _ = reply.send(engine.call(&name, args));
                }
                // A fresh runtime: module state resets, as documented.
                EngineMsg::Reload => {
                    engine = LoadedModule::load(&script_path, fs.clone());
                    if engine.load_error.is_none() {
                        eprintln!("kestrel-host: native module reloaded");
                    }
                }
            }
        }
    });
    tx
}

/// A QuickJS runtime with the prelude, the granted bindings and the user's
/// module evaluated. A module that fails to load keeps the error and rejects
/// every call with it.
struct LoadedModule {
    // Field order is drop order: the context goes before its runtime.
    context: rquickjs::Context,
    rt: rquickjs::Runtime,
    load_error: Option<KestrelError>,
}

impl LoadedModule {
    fn load(script_path: &Path, fs: Option<scope::Fs>) -> Self {
        use rquickjs::{function::Func, Context, Ctx, Exception, Runtime};

        let rt = Runtime::new().expect("quickjs runtime");
        let context = Context::full(&rt).expect("quickjs context");

        let load_error: Option<KestrelError> = context.with(|ctx| {
            let globals = ctx.globals();
            // Host bindings: the privileged surface native functions may touch.
            // Only what the manifest grants is installed; an ungranted
            // binding is absent, not a stub that refuses.
            if let Some(fs) = fs {
                // A thrown binding error is a JS Error with a `code`; a
                // native function that doesn't catch it passes the code on.
                let throw = |ctx: &Ctx<'_>, e: KestrelError| -> rquickjs::Error {
                    match Exception::from_message(ctx.clone(), &e.message) {
                        Ok(exc) => {
                            let obj = exc.into_object();
                            let _ = obj.set("code", e.code);
                            ctx.throw(obj.into_value())
                        }
                        Err(err) => err,
                    }
                };
                let f = fs.clone();
                globals
                    .set(
                        "hostReadFile",
                        Func::from(move |ctx: Ctx<'_>, path: String| {
                            f.read(&path).map_err(|e| throw(&ctx, e))
                        }),
                    )
                    .expect("bind hostReadFile");
                let f = fs.clone();
                globals
                    .set(
                        "hostWriteFile",
                        Func::from(move |ctx: Ctx<'_>, path: String, contents: String| {
                            f.write(&path, &contents).map_err(|e| throw(&ctx, e))
                        }),
                    )
                    .expect("bind hostWriteFile");
                let f = fs.clone();
                globals
                    .set(
                        "hostExists",
                        Func::from(move |ctx: Ctx<'_>, path: String| {
                            f.exists(&path).map_err(|e| throw(&ctx, e))
                        }),
                    )
                    .expect("bind hostExists");
                let root = fs.root.to_string_lossy().into_owned();
                globals
                    .set("hostAppDataDir", Func::from(move || root.clone()))
                    .expect("bind hostAppDataDir");
            }
            globals
                .set(
                    "hostLog",
                    Func::from(|msg: String| -> bool {
                        eprintln!("[native] {msg}");
                        true
                    }),
                )
                .expect("bind hostLog");

            let codes = serde_json::to_string(error::CODES).expect("codes");
            ctx.eval::<(), _>(
                r#"
                globalThis.native = {};
                // Calls are serialized per engine (RFC-0001 §4(b)), so one
                // settle slot is enough. A sync result settles immediately;
                // a thenable settles once the host drains the job queue.
                // Every failure settles as a KestrelError JSON string.
                let __kestrel_slot = null;
                const __kestrel_json = (v) => JSON.stringify(v === undefined ? null : v);
                function __kestrel_err(e, name) {
                    const obj = e !== null && typeof e === "object";
                    const err = {
                        code: obj && __KESTREL_CODES__.includes(e.code) ? e.code : "native_function",
                        message: obj && "message" in e ? String(e.message) : String(e),
                        detail: { function: name },
                    };
                    if (obj && e.detail !== undefined) {
                        try { err.detail = JSON.parse(JSON.stringify(e.detail)); } catch (_) {}
                    }
                    return JSON.stringify(err);
                }
                function __kestrel_dispatch(name, argsJson) {
                    const fn = globalThis.native[name];
                    if (typeof fn !== "function") {
                        const e = new Error("no native function: " + name);
                        e.code = "not_found";
                        __kestrel_slot = { done: true, err: __kestrel_err(e, name) };
                        return;
                    }
                    const slot = (__kestrel_slot = { done: false });
                    const ok = (v) => {
                        try { slot.ok = __kestrel_json(v); }
                        catch (e) { slot.err = __kestrel_err(e, name); }
                        slot.done = true;
                    };
                    const fail = (e) => { slot.err = __kestrel_err(e, name); slot.done = true; };
                    let result;
                    try { result = fn(JSON.parse(argsJson)); }
                    catch (e) { return fail(e); }
                    if (result && typeof result.then === "function") result.then(ok, fail);
                    else ok(result);
                }
                // "p" pending, "o<json>" resolved, "e<error json>" rejected.
                function __kestrel_settle() {
                    const s = __kestrel_slot;
                    if (!s || !s.done) return "p";
                    __kestrel_slot = null;
                    return s.err !== undefined ? "e" + s.err : "o" + s.ok;
                }
                "#
                .replace("__KESTREL_CODES__", &codes),
            )
            .expect("prelude");

            // A broken module must not take the engine down: report it once
            // and reject every call with the same message.
            let file = script_path.display();
            let user_src = match std::fs::read_to_string(script_path) {
                Ok(src) => src,
                Err(e) => {
                    return Some(KestrelError::new(
                        "native_function",
                        format!("cannot read native module {file}: {e}"),
                    ))
                }
            };
            match ctx.eval::<(), _>(user_src) {
                Ok(()) => None,
                Err(e) => {
                    let exc = ctx.catch();
                    let exc = exc.as_exception();
                    let msg = exc
                        .and_then(|x| x.message())
                        .unwrap_or_else(|| e.to_string());
                    let at = exc
                        .and_then(|x| x.line())
                        .map(|l| format!("{file}:{l}"))
                        .unwrap_or_else(|| file.to_string());
                    Some(KestrelError::new(
                        "native_function",
                        format!("native module failed to load ({at}): {msg}"),
                    ))
                }
            }
        });
        if let Some(err) = &load_error {
            eprintln!("kestrel-host: error: {}", err.message);
        }
        LoadedModule {
            context,
            rt,
            load_error,
        }
    }

    fn call(&self, name: &str, args: String) -> Result<String, KestrelError> {
        use rquickjs::Function;

        let (rt, context) = (&self.rt, &self.context);
        if let Some(err) = &self.load_error {
            return Err(err.clone());
        }
        let internal = |e: rquickjs::Error| {
            KestrelError::new("native_function", e.to_string())
                .with_detail(serde_json::json!({ "function": name }))
        };
        let res = context.with(|ctx| -> Result<(), KestrelError> {
            let dispatch: Function = ctx.globals().get("__kestrel_dispatch").map_err(internal)?;
            dispatch
                .call::<_, ()>((name.to_string(), args))
                .map_err(internal)
        });
        // Drive promises: run queued jobs until the call settles or no
        // work is left. No host async bindings exist yet, so a promise
        // still pending after the queue drains can never settle.
        res.and_then(|()| {
            while rt.is_job_pending() {
                if rt.execute_pending_job().is_err() {
                    break; // the exception lands in the promise's rejection
                }
            }
            context.with(|ctx| -> Result<String, KestrelError> {
                let settle: Function = ctx.globals().get("__kestrel_settle").map_err(internal)?;
                let out: String = settle.call(()).map_err(internal)?;
                match out.split_at(1) {
                    ("o", json) => Ok(json.to_string()),
                    ("e", json) => Err(serde_json::from_str(json).unwrap_or_else(|_| {
                        KestrelError::new("native_function", json.to_string())
                    })),
                    _ => Err(KestrelError::new(
                        "native_function",
                        format!("native function `{name}` returned a promise that never settled"),
                    )
                    .with_detail(serde_json::json!({ "function": name }))),
                }
            })
        })
    }
}

// ---- the generic command surface (spike subset of `kestrel/native`) ----

#[tauri::command]
fn get_manifest(state: State<Manifest>) -> Manifest {
    state.inner().clone()
}

/// Bridge: webview -> user's native function inside the embedded engine.
/// `async` so Tauri runs it off the main thread: a slow native function must
/// never freeze painting or input. No timeout: long jobs are legitimate.
#[tauri::command]
async fn call_native(
    engine: State<'_, NativeEngine>,
    name: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, KestrelError> {
    let stopped = || KestrelError::new("native_function", "native engine stopped");
    let tx = engine
        .0
        .as_ref()
        .ok_or_else(|| KestrelError::new("not_found", "this app declares no native module"))?;
    let (rtx, rrx) = std::sync::mpsc::channel();
    tx.lock()
        .unwrap()
        .send(EngineMsg::Call(name, args.to_string(), rtx))
        .map_err(|_| stopped())?;
    let json = tauri::async_runtime::spawn_blocking(move || rrx.recv())
        .await
        .map_err(|_| stopped())?
        .map_err(|_| stopped())??;
    serde_json::from_str(&json).map_err(|e| KestrelError::new("native_function", e.to_string()))
}

/// Dev: turn each `reload-native` line into an engine reload, until the
/// input or the engine goes away.
fn watch_stdin_for_reloads(input: impl std::io::BufRead, tx: std::sync::mpsc::Sender<EngineMsg>) {
    for line in input.lines().map_while(Result::ok) {
        if line.trim() == "reload-native" && tx.send(EngineMsg::Reload).is_err() {
            break;
        }
    }
}

/// A loaded manifest with every path resolved and checked.
struct Prepared {
    manifest: Manifest,
    frontend_dir: PathBuf,
    fs_scope: Option<scope::FsScope>,
}

/// Load and validate the manifest. Errors are single-line and name the file
/// and the field to fix: they are the user's first contact with a mistake.
fn prepare(manifest_path: &Path) -> Result<Prepared, String> {
    let shown = manifest_path.display();
    let raw = fs::read_to_string(manifest_path).map_err(|e| {
        format!(
            "cannot read manifest {shown}: {e}. Pass the path to kestrel.json, \
             or put kestrel.json next to the executable."
        )
    })?;
    let mut manifest: Manifest =
        serde_json::from_str(&raw).map_err(|e| format!("invalid manifest {shown}: {e}"))?;

    // The app id names the data dir, so it must be a plain path segment.
    let id_ok = manifest.app_id.bytes().enumerate().all(|(i, b)| {
        b.is_ascii_lowercase() || b.is_ascii_digit() || (i > 0 && b"-.".contains(&b))
    });
    if manifest.app_id.is_empty() || !id_ok {
        return Err(format!(
            "invalid manifest {shown}: `appId` must be lowercase letters, digits, dots \
             and dashes (got {:?})",
            manifest.app_id
        ));
    }
    let fs_scope = scope::parse(&manifest.permissions)
        .map_err(|e| format!("invalid manifest {shown}: {e}. Check the `permissions` field."))?;

    // Relative paths in the manifest resolve against the manifest's own
    // directory, never the process cwd.
    let manifest_dir = manifest_path
        .canonicalize()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .ok_or_else(|| format!("cannot resolve the directory of {shown}"))?;

    let frontend_dir = manifest_dir
        .join(&manifest.frontend)
        .canonicalize()
        .map_err(|e| {
            format!(
                "frontend directory `{}` (from {shown}) not found: {e}. \
                 Check the `frontend` field.",
                manifest.frontend
            )
        })?;
    if manifest.dev_url.is_none() && !frontend_dir.join("index.html").is_file() {
        return Err(format!(
            "no index.html in frontend directory {} (from {shown}). \
             Build the frontend first, or check the `frontend` field.",
            frontend_dir.display()
        ));
    }
    if let Some(n) = &manifest.native {
        let p = manifest_dir.join(n).canonicalize().map_err(|e| {
            format!("native module `{n}` (from {shown}) not found: {e}. Check the `native` field.")
        })?;
        manifest.native = Some(p.to_string_lossy().into_owned());
    }
    Ok(Prepared {
        manifest,
        frontend_dir,
        fs_scope,
    })
}

fn main() {
    // Manifest location: argv[1], else kestrel.json BESIDE THE EXECUTABLE —
    // a built bundle must work when double-clicked from any cwd.
    let manifest_path: PathBuf = match std::env::args().nth(1) {
        Some(p) => PathBuf::from(p),
        None => std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|d| d.join("kestrel.json")))
            .unwrap_or_else(|| PathBuf::from("kestrel.json")),
    };
    let fail = |e: String| -> ! {
        eprintln!("kestrel-host: error: {e}");
        std::process::exit(1);
    };
    let Prepared {
        mut manifest,
        frontend_dir,
        fs_scope,
    } = prepare(&manifest_path).unwrap_or_else(|e| fail(e));
    // Everything per-app derives from appId, never the shared host
    // identifier: native file access and the webview's own storage.
    let data_dir = scope::app_data_dir(&manifest.app_id).unwrap_or_else(|e| fail(e));
    let picks = manifest.permissions.iter().any(|p| p == "fs:pick");
    let fs = fs_scope.map(|s| {
        scope::Fs::new(s, &data_dir)
            .unwrap_or_else(|e| fail(e))
            .with_pick(picks)
    });
    let window_state = manifest
        .window
        .remember_window
        .then(|| window::WindowState::open(&data_dir));
    let saver = window_state.clone();
    let webview_dir = scope::webview_data_dir(&data_dir);
    let store_id = scope::webview_store_id(&manifest.app_id);

    // Test hook for headless CI runs of built bundles.
    if let Ok(ms) = std::env::var("KESTREL_EXIT_AFTER_MS") {
        if let Ok(ms) = ms.parse::<u64>() {
            manifest.exit_after_ms = Some(ms);
        }
    }

    let dev_base = manifest.dev_url.clone();
    let csp = manifest
        .csp
        .clone()
        .unwrap_or_else(|| serve::DEFAULT_CSP.to_string());

    let engine = NativeEngine(
        manifest
            .native
            .as_ref()
            .map(|p| Mutex::new(start_native_engine(PathBuf::from(p), fs.clone()))),
    );

    if manifest.dev_reload {
        if let Some(tx) = engine.0.as_ref().map(|m| m.lock().unwrap().clone()) {
            std::thread::spawn(move || watch_stdin_for_reloads(std::io::stdin().lock(), tx));
        }
    }

    let window_cfg = manifest.clone();

    tauri::Builder::default()
        // Rust-side only: the capability grants none of their JS commands,
        // so the webview reaches them through stdlib's gated commands.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(manifest)
        .manage(engine)
        .manage(stdlib::WebFs(fs))
        .manage(store::Store::open(&data_dir))
        .register_asynchronous_uri_scheme_protocol("kestrel", move |_ctx, request, responder| {
            match &dev_base {
                // Dev: reverse-proxy to the frontend dev server, off the
                // main thread so a slow transform never blocks the UI.
                Some(base) => {
                    let base = base.clone();
                    std::thread::spawn(move || responder.respond(serve::proxy(&base, &request)));
                }
                None => responder.respond(serve::serve_static(
                    &frontend_dir,
                    request.uri().path(),
                    &csp,
                )),
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_manifest,
            call_native,
            stdlib::app_version,
            stdlib::app_quit,
            stdlib::window_set_title,
            stdlib::window_minimize,
            stdlib::window_maximize,
            stdlib::window_close,
            stdlib::fs_read_text,
            stdlib::fs_read_bytes,
            stdlib::fs_write_text,
            stdlib::fs_exists,
            stdlib::fs_app_data_dir,
            stdlib::store_get,
            stdlib::store_set,
            stdlib::store_delete,
            stdlib::store_keys,
            stdlib::dialog_pick_file,
            stdlib::dialog_pick_folder,
            stdlib::dialog_save,
            stdlib::dialog_message,
            stdlib::notify,
            stdlib::clipboard_read_text,
            stdlib::clipboard_write_text,
            stdlib::shell_open,
        ])
        .setup(move |app| {
            let url: tauri::Url = "kestrel://localhost/index.html".parse()?;
            let opts = &window_cfg.window;
            // Last run's bounds, if remembered; the position only if it's
            // still on a display.
            let saved = window_state.as_ref().and_then(|s| s.saved());
            let (w, h) = saved.map_or((window_cfg.width, window_cfg.height), |s| {
                (s.rect.width, s.rect.height)
            });
            let (w, h) = opts.clamp(w, h);
            let displays: Vec<window::Rect> = app
                .available_monitors()?
                .iter()
                .map(|m| {
                    let (a, s) = (m.work_area(), m.scale_factor());
                    window::Rect {
                        x: a.position.x as f64 / s,
                        y: a.position.y as f64 / s,
                        width: a.size.width as f64 / s,
                        height: a.size.height as f64 / s,
                    }
                })
                .collect();
            let place = saved
                .map(|s| s.rect)
                .filter(|r| window::reachable(*r, &displays));
            let mut builder = opts
                .apply(WebviewWindowBuilder::new(
                    app,
                    "main",
                    WebviewUrl::External(url),
                ))
                .title(&window_cfg.title)
                .inner_size(w, h);
            builder = match place {
                Some(r) => builder.position(r.x, r.y),
                None if opts.center => builder.center(),
                None => builder,
            };
            let main = builder
                // Every app shares this binary and the kestrel://localhost
                // origin, so storage must be split per app explicitly:
                // a data directory on Windows/Linux, a data store on macOS
                // (14+; older macOS falls back to the shared default store).
                .data_directory(webview_dir)
                .data_store_identifier(store_id)
                // The window only ever shows the app. External links open
                // in the system browser; anything else is refused.
                .on_navigation(|url| {
                    if serve::is_app_url(url) || url.scheme() == "about" {
                        return true;
                    }
                    if let Err(e) = serve::open_external(url) {
                        eprintln!("kestrel-host: {e}");
                    }
                    false
                })
                .on_new_window(|url, _| {
                    if !serve::is_app_url(&url) {
                        if let Err(e) = serve::open_external(&url) {
                            eprintln!("kestrel-host: {e}");
                        }
                    }
                    tauri::webview::NewWindowResponse::Deny
                })
                .build()?;
            if let Some(state) = window_state {
                if saved.is_some_and(|s| s.maximized) {
                    main.maximize()?;
                }
                let w = main.clone();
                // Once now, for a size the min/max bounds changed.
                state.track(&main);
                main.on_window_event(move |e| {
                    if let tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) = e {
                        state.track(&w);
                    }
                });
            }
            if let Some(ms) = window_cfg.exit_after_ms {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(ms));
                    handle.exit(0);
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while starting kestrel-host")
        .run(move |_, event| {
            if let (tauri::RunEvent::Exit, Some(s)) = (event, &saver) {
                s.save();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Start an engine on `src` and return a caller: name + args JSON →
    /// result, with errors flattened to "code: message".
    fn engine(src: &str) -> impl Fn(&str, &str) -> Result<String, String> {
        engine_with(src, None)
    }

    fn engine_with(
        src: &str,
        fs: Option<scope::Fs>,
    ) -> impl Fn(&str, &str) -> Result<String, String> {
        let call = engine_raw(src, fs);
        move |name, args| call(name, args).map_err(|e| e.to_string())
    }

    fn engine_raw(
        src: &str,
        fs: Option<scope::Fs>,
    ) -> impl Fn(&str, &str) -> Result<String, KestrelError> {
        let dir = std::env::temp_dir().join(format!(
            "kestrel-engine-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let script = dir.join("native.js");
        fs::write(&script, src).unwrap();
        let tx = start_native_engine(script, fs);
        move |name, args| {
            let (rtx, rrx) = std::sync::mpsc::channel();
            tx.send(EngineMsg::Call(name.into(), args.into(), rtx))
                .unwrap();
            rrx.recv().unwrap()
        }
    }

    #[test]
    fn sync_values_round_trip() {
        let call = engine("native.double = ({ n }) => n * 2; native.nothing = () => {};");
        assert_eq!(call("double", r#"{"n":21}"#), Ok("42".into()));
        assert_eq!(call("nothing", "{}"), Ok("null".into()));
    }

    #[test]
    fn async_values_resolve() {
        let call = engine(
            "native.later = async ({ n }) => { await null; return { n: await Promise.resolve(n) }; };",
        );
        assert_eq!(call("later", r#"{"n":7}"#), Ok(r#"{"n":7}"#.into()));
    }

    #[test]
    fn errors_carry_the_js_message() {
        let call = engine(
            "native.boom = () => { throw new Error('sync'); };
             native.reject = async () => { throw new Error('async'); };
             native.rejectValue = () => Promise.reject('plain');",
        );
        assert_eq!(call("boom", "{}"), Err("native_function: sync".into()));
        assert_eq!(call("reject", "{}"), Err("native_function: async".into()));
        assert_eq!(
            call("rejectValue", "{}"),
            Err("native_function: plain".into())
        );
        assert_eq!(
            call("missing", "{}"),
            Err("not_found: no native function: missing".into())
        );
    }

    #[test]
    fn errors_are_structured_with_codes_and_detail() {
        let data = app(&[]).join("data");
        let fs = scope::Fs::new(scope::FsScope::AppData, &data).unwrap();
        let call = engine_raw(
            r#"native.read = () => hostReadFile("nope.txt");
               native.escape = async () => { await null; return hostReadFile("../x"); };
               native.cancel = () => { const e = new Error("user closed it"); e.code = "cancelled"; e.detail = { step: 2 }; throw e; };
               native.weird = () => { const e = new Error("hm"); e.code = "EWHATEVER"; throw e; };
               native.plainObject = () => { throw { code: "timeout", message: "too slow" }; };
               native.big = () => 1n;"#,
            Some(fs),
        );
        let err = |code: &str, message: &str, detail: serde_json::Value| KestrelError {
            code: code.into(),
            message: message.into(),
            detail: Some(detail),
        };
        let f = |name: &str| serde_json::json!({ "function": name });
        // An uncaught binding error keeps the binding's code.
        let e = call("read", "{}").unwrap_err();
        assert_eq!((e.code.as_str(), e.detail), ("not_found", Some(f("read"))));
        assert!(e.message.starts_with("nope.txt: "), "{}", e.message);
        assert_eq!(call("escape", "{}").unwrap_err().code, "permission_denied");
        // Native code can pick a code from the closed set, and a detail.
        assert_eq!(
            call("cancel", "{}"),
            Err(err(
                "cancelled",
                "user closed it",
                serde_json::json!({ "step": 2 })
            ))
        );
        assert_eq!(
            call("plainObject", "{}"),
            Err(err("timeout", "too slow", f("plainObject")))
        );
        // Codes outside the set are not passed through.
        assert_eq!(
            call("weird", "{}"),
            Err(err("native_function", "hm", f("weird")))
        );
        assert_eq!(call("big", "{}").unwrap_err().code, "native_function");
    }

    #[test]
    fn never_settling_promise_errors_and_engine_survives() {
        let call = engine("native.hang = () => new Promise(() => {}); native.ok = () => 1;");
        assert!(call("hang", "{}").unwrap_err().contains("never settled"));
        assert_eq!(call("ok", "{}"), Ok("1".into()));
    }

    #[test]
    fn broken_module_rejects_calls_with_file_and_line() {
        let call = engine("native.ok = () => 1;\nnative.bad = (;\n");
        let err = call("ok", "{}").unwrap_err();
        assert!(err.contains("native module failed to load"), "{err}");
        assert!(err.contains("native.js:2"), "{err}");
        // The engine stays up and keeps answering.
        assert_eq!(call("ok", "{}"), Err(err));
    }

    #[test]
    fn reload_picks_up_new_code_resets_state_and_recovers_from_errors() {
        let script =
            app(&[("native.js", "let n = 0; native.v = () => ++n * 1;")]).join("native.js");
        let tx = start_native_engine(script.clone(), None);
        let call = |name: &str| {
            let (rtx, rrx) = std::sync::mpsc::channel();
            tx.send(EngineMsg::Call(name.into(), "{}".into(), rtx))
                .unwrap();
            rrx.recv().unwrap().map_err(|e| e.to_string())
        };
        assert_eq!(call("v"), Ok("1".into()));
        assert_eq!(call("v"), Ok("2".into()));

        fs::write(&script, "let n = 0; native.v = () => ++n * 10;").unwrap();
        tx.send(EngineMsg::Reload).unwrap();
        assert_eq!(call("v"), Ok("10".into()), "new code, fresh module state");

        fs::write(&script, "native.v = (;").unwrap();
        tx.send(EngineMsg::Reload).unwrap();
        assert!(call("v").unwrap_err().contains("failed to load"));

        fs::write(&script, "native.v = () => 'back';").unwrap();
        tx.send(EngineMsg::Reload).unwrap();
        assert_eq!(call("v"), Ok(r#""back""#.into()));
    }

    #[test]
    fn stdin_reload_lines_become_engine_reloads() {
        let (tx, rx) = std::sync::mpsc::channel();
        watch_stdin_for_reloads(&b"reload-native\nnoise\n  reload-native  \n"[..], tx);
        let msgs: Vec<_> = rx.try_iter().collect();
        assert_eq!(msgs.len(), 2);
        assert!(msgs.iter().all(|m| matches!(m, EngineMsg::Reload)));
    }

    #[test]
    fn module_that_throws_at_load_is_reported() {
        let call = engine("throw new Error('boot failed');");
        let err = call("x", "{}").unwrap_err();
        assert!(err.contains("boot failed"), "{err}");
    }

    /// Write files into a fresh dir and return it.
    fn app(files: &[(&str, &str)]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kestrel-prepare-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        for (name, body) in files {
            let p = dir.join(name);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, body).unwrap();
        }
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn prepare_err(dir: &Path) -> String {
        match prepare(&dir.join("kestrel.json")) {
            Ok(_) => panic!("expected an error"),
            Err(e) => e,
        }
    }

    const OK: &str = r#"{"appId":"a","title":"A","frontend":"web","native":"native.js"}"#;

    #[test]
    fn prepare_accepts_a_valid_app_and_resolves_paths() {
        let dir = app(&[
            ("kestrel.json", OK),
            ("web/index.html", ""),
            ("native.js", ""),
        ]);
        let p = prepare(&dir.join("kestrel.json")).unwrap();
        assert!(p.frontend_dir.is_absolute());
        assert!(Path::new(p.manifest.native.as_deref().unwrap()).is_absolute());
    }

    #[test]
    fn prepare_reports_each_failure_mode() {
        let missing = app(&[]);
        assert!(prepare_err(&missing).starts_with("cannot read manifest"));

        let bad_json = app(&[("kestrel.json", "{ nope")]);
        assert!(prepare_err(&bad_json).contains("invalid manifest"));

        let no_field = app(&[("kestrel.json", r#"{"title":"A","frontend":"."}"#)]);
        assert!(prepare_err(&no_field).contains("missing field `appId`"));

        let no_frontend = app(&[("kestrel.json", OK), ("native.js", "")]);
        let e = prepare_err(&no_frontend);
        assert!(
            e.contains("frontend directory `web`") && e.contains("`frontend` field"),
            "{e}"
        );

        let no_index = app(&[("kestrel.json", OK), ("web/x.css", ""), ("native.js", "")]);
        assert!(prepare_err(&no_index).contains("no index.html"));

        let no_native = app(&[("kestrel.json", OK), ("web/index.html", "")]);
        let e = prepare_err(&no_native);
        assert!(
            e.contains("native module `native.js`") && e.contains("`native` field"),
            "{e}"
        );
    }

    #[test]
    fn ungranted_fs_bindings_are_absent() {
        let call = engine(
            "native.kinds = () => [typeof hostReadFile, typeof hostWriteFile, \
             typeof hostExists, typeof hostAppDataDir, typeof hostLog];",
        );
        assert_eq!(
            call("kinds", "{}"),
            Ok(r#"["undefined","undefined","undefined","undefined","function"]"#.into())
        );
    }

    #[test]
    fn granted_fs_bindings_are_scoped_and_throw() {
        let data = app(&[]).join("data");
        let fs = scope::Fs::new(scope::FsScope::AppData, &data).unwrap();
        let root = fs.root.clone();
        let call = engine_with(
            r#"native.save = ({ t }) => { hostWriteFile("n/t.txt", t); return hostReadFile("n/t.txt"); };
               native.has = ({ p }) => hostExists(p);
               native.dir = () => hostAppDataDir();
               native.escape = () => hostReadFile("../../etc/passwd");
               native.caught = () => { try { hostReadFile("missing"); } catch (e) { return e.code + ": " + e.message; } };"#,
            Some(fs),
        );
        assert_eq!(call("save", r#"{"t":"hi"}"#), Ok(r#""hi""#.into()));
        assert!(root.join("n/t.txt").is_file());
        assert_eq!(call("has", r#"{"p":"n/t.txt"}"#), Ok("true".into()));
        assert_eq!(
            call("dir", "{}"),
            Ok(serde_json::to_string(&root.to_string_lossy()).unwrap())
        );
        assert!(call("escape", "{}")
            .unwrap_err()
            .starts_with("permission_denied:"));
        assert!(call("caught", "{}").unwrap().starts_with(r#""not_found:"#));
    }

    #[test]
    fn prepare_rejects_bad_permissions_and_app_ids() {
        let unknown = app(&[
            (
                "kestrel.json",
                r#"{"appId":"a","title":"A","frontend":"web","permissions":["fs:root"]}"#,
            ),
            ("web/index.html", ""),
        ]);
        let e = prepare_err(&unknown);
        assert!(
            e.contains("`fs:root` is not a known permission") && e.contains("`permissions`"),
            "{e}"
        );

        for id in ["../x", "A", "a/b", ".a", ""] {
            let m = format!(r#"{{"appId":{id:?},"title":"A","frontend":"web"}}"#);
            let dir = app(&[("kestrel.json", &m), ("web/index.html", "")]);
            assert!(prepare_err(&dir).contains("`appId` must be"), "{id}");
        }

        let ok = app(&[
            (
                "kestrel.json",
                r#"{"appId":"my.app-2","title":"A","frontend":"web","permissions":["fs:app-data"]}"#,
            ),
            ("web/index.html", ""),
        ]);
        let p = prepare(&ok.join("kestrel.json")).unwrap();
        assert_eq!(p.fs_scope, Some(scope::FsScope::AppData));
    }

    #[test]
    fn unserializable_result_is_an_error() {
        let call = engine("native.big = async () => 1n;");
        assert!(call("big", "{}").is_err());
    }
}
