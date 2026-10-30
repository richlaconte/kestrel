// The `tray` std-lib module (#29): one icon in the menu bar / system tray,
// with the app's icon, a menu, and clicks sent to the webview as one
// `kestrel:tray` Tauri event. Needs the "tray" permission.
//
// The menu is a typed item list (RFC-0001 §3). It's validated here, before
// anything is built, so a bad item rejects with a message naming it instead
// of leaving half a tray behind.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Deserialize;
use serde_json::Value;
use tauri::{
    menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime, State,
};

use crate::{error::KestrelError, window, Manifest};

/// The Tauri event that carries tray clicks:
/// `{ kind: "menu", id, checked? }` or `{ kind: "click" }`.
pub const TRAY_EVENT: &str = "kestrel:tray";

/// The app has at most one tray icon, under this id.
const TRAY_ID: &str = "kestrel";

/// Menu ids are prefixed so a click on any other menu (the macOS app menu)
/// is never mistaken for a tray item.
const ID_PREFIX: &str = "kestrel-tray:";

/// Submenus nest at most this deep.
const MAX_DEPTH: usize = 4;

/// Whether closing the main window hides it while the tray is up.
#[derive(Default)]
pub struct CloseToTray(pub AtomicBool);

impl CloseToTray {
    pub fn get(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

#[derive(Debug, PartialEq)]
pub enum Item {
    Action {
        id: String,
        label: String,
        enabled: bool,
    },
    Check {
        id: String,
        label: String,
        enabled: bool,
        checked: bool,
    },
    Separator,
    Submenu {
        label: String,
        enabled: bool,
        items: Vec<Item>,
    },
}

/// Check a menu from the webview: every item is a separator, an action or
/// check item with a unique non-empty `id`, or a submenu with `items`.
pub fn parse_menu(menu: &[Value]) -> Result<Vec<Item>, KestrelError> {
    let mut ids = Vec::new();
    parse_items(menu, "menu", 1, &mut ids)
}

fn parse_items(
    items: &[Value],
    at: &str,
    depth: usize,
    ids: &mut Vec<String>,
) -> Result<Vec<Item>, KestrelError> {
    if depth > MAX_DEPTH {
        return Err(bad(format!("{at}: submenus nest at most {MAX_DEPTH} deep")));
    }
    items
        .iter()
        .enumerate()
        .map(|(i, v)| parse_item(v, &format!("{at}[{i}]"), depth, ids))
        .collect()
}

fn parse_item(
    v: &Value,
    at: &str,
    depth: usize,
    ids: &mut Vec<String>,
) -> Result<Item, KestrelError> {
    let Some(o) = v.as_object() else {
        return Err(bad(format!("{at} must be an object")));
    };
    let known = ["type", "id", "label", "enabled", "checked", "items"];
    if let Some(k) = o.keys().find(|k| !known.contains(&k.as_str())) {
        return Err(bad(format!(
            "{at} has an unknown field `{k}` (known: {})",
            known.join(", ")
        )));
    }
    match o.get("type").map(|t| t.as_str()) {
        None => {}
        Some(Some("separator")) => {
            return match o.len() {
                1 => Ok(Item::Separator),
                _ => Err(bad(format!("{at}: a separator has no other fields"))),
            }
        }
        Some(_) => return Err(bad(format!("{at}: `type` can only be \"separator\""))),
    }
    let label = match o.get("label") {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        _ => return Err(bad(format!("{at}: `label` must be a non-empty string"))),
    };
    let flag = |k: &str| -> Result<Option<bool>, KestrelError> {
        match o.get(k) {
            None => Ok(None),
            Some(Value::Bool(b)) => Ok(Some(*b)),
            Some(_) => Err(bad(format!("{at}: `{k}` must be true or false"))),
        }
    };
    let enabled = flag("enabled")?.unwrap_or(true);
    let checked = flag("checked")?;
    if let Some(items) = o.get("items") {
        let Value::Array(items) = items else {
            return Err(bad(format!("{at}: `items` must be an array")));
        };
        if o.contains_key("id") || checked.is_some() {
            return Err(bad(format!(
                "{at}: a submenu has `label` and `items`, not `id` or `checked`"
            )));
        }
        let items = parse_items(items, &format!("{at}.items"), depth + 1, ids)?;
        return Ok(Item::Submenu {
            label,
            enabled,
            items,
        });
    }
    let id = match o.get("id") {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        _ => return Err(bad(format!("{at}: `id` must be a non-empty string"))),
    };
    if ids.contains(&id) {
        return Err(bad(format!("{at}: id {id:?} is used twice")));
    }
    ids.push(id.clone());
    Ok(match checked {
        Some(checked) => Item::Check {
            id,
            label,
            enabled,
            checked,
        },
        None => Item::Action { id, label, enabled },
    })
}

fn bad(msg: String) -> KestrelError {
    KestrelError::new("io", format!("tray.create: {msg}"))
}

fn tray_err(e: tauri::Error) -> KestrelError {
    KestrelError::new("io", format!("tray: {e}"))
}

/// The menu's items, and each check item by id so a click can report its
/// new state.
type Checks<R> = Vec<(String, CheckMenuItem<R>)>;

fn build_items<R: Runtime>(
    app: &AppHandle<R>,
    items: &[Item],
    checks: &mut Checks<R>,
) -> tauri::Result<Vec<Box<dyn IsMenuItem<R>>>> {
    let mut out: Vec<Box<dyn IsMenuItem<R>>> = Vec::new();
    for item in items {
        out.push(match item {
            Item::Action { id, label, enabled } => Box::new(MenuItem::with_id(
                app,
                format!("{ID_PREFIX}{id}"),
                label,
                *enabled,
                None::<&str>,
            )?),
            Item::Check {
                id,
                label,
                enabled,
                checked,
            } => {
                let item = CheckMenuItem::with_id(
                    app,
                    format!("{ID_PREFIX}{id}"),
                    label,
                    *enabled,
                    *checked,
                    None::<&str>,
                )?;
                checks.push((id.clone(), item.clone()));
                Box::new(item)
            }
            Item::Separator => Box::new(PredefinedMenuItem::separator(app)?),
            Item::Submenu {
                label,
                enabled,
                items,
            } => {
                let children = build_items(app, items, checks)?;
                let refs: Vec<&dyn IsMenuItem<R>> = children.iter().map(|b| b.as_ref()).collect();
                Box::new(Submenu::with_items(app, label, *enabled, &refs)?)
            }
        });
    }
    Ok(out)
}

/// The tray needs libayatana-appindicator3 (or libappindicator3) on Linux,
/// and Tauri aborts the process when neither loads. Look first.
#[cfg(target_os = "linux")]
fn check_platform() -> Result<(), KestrelError> {
    const LIBS: [&str; 4] = [
        "libayatana-appindicator3.so.1",
        "libappindicator3.so.1",
        "libayatana-appindicator3.so",
        "libappindicator3.so",
    ];
    let found = LIBS.iter().any(|l| dlopen2::raw::Library::open(l).is_ok());
    if found {
        Ok(())
    } else {
        Err(KestrelError::new(
            "unsupported_platform",
            "tray needs libayatana-appindicator3 on Linux (apt install libayatana-appindicator3-1)",
        ))
    }
}

#[cfg(not(target_os = "linux"))]
fn check_platform() -> Result<(), KestrelError> {
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct TrayOptions {
    tooltip: Option<String>,
    /// Text beside the icon (macOS only).
    title: Option<String>,
    menu: Vec<Value>,
    /// Closing the main window hides it instead, so the app keeps running
    /// in the tray. `appWindow.show()` brings it back.
    close_to_tray: bool,
    /// false: left click is the app's (onClick) and the menu opens on right
    /// click.
    menu_on_left_click: bool,
}

impl Default for TrayOptions {
    fn default() -> Self {
        Self {
            tooltip: None,
            title: None,
            menu: Vec::new(),
            close_to_tray: false,
            menu_on_left_click: true,
        }
    }
}

/// Show the tray icon, replacing the one already up. Async: Tauri builds it
/// on the main thread itself, and a sync command would wait on itself there.
#[tauri::command]
pub async fn tray_create(
    app: AppHandle,
    manifest: State<'_, Manifest>,
    shared: State<'_, window::Shared>,
    close: State<'_, CloseToTray>,
    opts: Option<TrayOptions>,
) -> Result<(), KestrelError> {
    crate::stdlib::require(&manifest, "tray", "tray.create")?;
    let opts = opts.unwrap_or_default();
    let items = parse_menu(&opts.menu)?;
    check_platform()?;

    let mut checks = Vec::new();
    let children = build_items(&app, &items, &mut checks).map_err(tray_err)?;
    let mut b = TrayIconBuilder::with_id(TRAY_ID)
        // Windows and macOS; Linux always opens the menu on any click.
        .show_menu_on_left_click(opts.menu_on_left_click)
        .on_menu_event(move |app, e| {
            let Some(id) = e.id().as_ref().strip_prefix(ID_PREFIX) else {
                return;
            };
            let mut msg = serde_json::json!({ "kind": "menu", "id": id });
            // A check item has toggled itself by now; send where it landed.
            if let Some((_, item)) = checks.iter().find(|(i, _)| i == id) {
                if let Ok(c) = item.is_checked() {
                    msg["checked"] = c.into();
                }
            }
            if let Err(err) = app.emit(TRAY_EVENT, msg) {
                eprintln!("kestrel-host: tray event failed: {err}");
            }
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = e
            {
                let msg = serde_json::json!({ "kind": "click" });
                if let Err(err) = tray.app_handle().emit(TRAY_EVENT, msg) {
                    eprintln!("kestrel-host: tray event failed: {err}");
                }
            }
        });
    if let Some(icon) = &shared.icon {
        b = b.icon(icon.clone());
    }
    if let Some(t) = &opts.tooltip {
        b = b.tooltip(t);
    }
    if let Some(t) = &opts.title {
        b = b.title(t);
    }
    if !children.is_empty() {
        let refs: Vec<&dyn IsMenuItem<_>> = children.iter().map(|b| b.as_ref()).collect();
        b = b.menu(&Menu::with_items(&app, &refs).map_err(tray_err)?);
    }
    remove(&app);
    b.build(&app).map_err(tray_err)?;
    close.0.store(opts.close_to_tray, Ordering::Relaxed);
    Ok(())
}

/// Remove the tray icon. Resolves false if there wasn't one.
#[tauri::command]
pub async fn tray_destroy(
    app: AppHandle,
    manifest: State<'_, Manifest>,
    close: State<'_, CloseToTray>,
) -> Result<bool, KestrelError> {
    crate::stdlib::require(&manifest, "tray", "tray.destroy")?;
    close.0.store(false, Ordering::Relaxed);
    Ok(remove(&app))
}

/// Take the tray icon down; false if there wasn't one. The last handle must
/// drop on the main thread: AppKit traps on a status item removed off it.
fn remove<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some(tray) = app.remove_tray_by_id(TRAY_ID) else {
        return false;
    };
    if let Err(e) = app.run_on_main_thread(move || drop(tray)) {
        eprintln!("kestrel-host: removing the tray failed: {e}");
    }
    true
}

/// Bring back the main window that closing hid (macOS dock click).
#[cfg(target_os = "macos")]
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(v: Value) -> Result<Vec<Item>, String> {
        parse_menu(v.as_array().unwrap()).map_err(|e| e.message)
    }

    #[test]
    fn parses_every_item_kind() {
        let menu = parse(json!([
            { "id": "open", "label": "Open" },
            { "id": "mute", "label": "Mute", "checked": true },
            { "type": "separator" },
            { "label": "More", "items": [{ "id": "about", "label": "About", "enabled": false }] },
        ]))
        .unwrap();
        assert_eq!(
            menu,
            vec![
                Item::Action {
                    id: "open".into(),
                    label: "Open".into(),
                    enabled: true
                },
                Item::Check {
                    id: "mute".into(),
                    label: "Mute".into(),
                    enabled: true,
                    checked: true
                },
                Item::Separator,
                Item::Submenu {
                    label: "More".into(),
                    enabled: true,
                    items: vec![Item::Action {
                        id: "about".into(),
                        label: "About".into(),
                        enabled: false
                    }],
                },
            ]
        );
        assert_eq!(parse(json!([])).unwrap(), vec![]);
    }

    #[test]
    fn refuses_bad_items_by_path() {
        let err = |v| parse(v).unwrap_err();
        assert!(err(json!(["Open"])).contains("menu[0] must be an object"));
        assert!(err(json!([{ "id": "a" }])).contains("menu[0]: `label`"));
        assert!(err(json!([{ "label": "A" }])).contains("menu[0]: `id`"));
        assert!(err(json!([{ "id": "", "label": "A" }])).contains("`id`"));
        assert!(err(json!([{ "id": "a", "label": "A", "checked": "yes" }]))
            .contains("`checked` must be true or false"));
        assert!(err(json!([{ "id": "a", "label": "A", "onClick": 1 }]))
            .contains("unknown field `onClick`"));
        assert!(err(json!([{ "type": "radio", "label": "A" }])).contains("`type`"));
        assert!(err(json!([{ "type": "separator", "label": "A" }])).contains("separator"));
        assert!(err(json!([{ "label": "M", "id": "m", "items": [] }])).contains("submenu"));
        assert!(err(json!([{ "label": "M", "items": {} }])).contains("`items` must be an array"));
        assert!(
            err(json!([{ "label": "M", "items": [{ "id": "x", "label": 3 }] }]))
                .contains("menu[0].items[0]: `label`")
        );
    }

    #[test]
    fn ids_are_unique_across_submenus() {
        let e = parse(json!([
            { "id": "a", "label": "A" },
            { "label": "M", "items": [{ "id": "a", "label": "A again" }] },
        ]))
        .unwrap_err();
        assert!(
            e.contains("menu[1].items[0]: id \"a\" is used twice"),
            "{e}"
        );
    }

    #[test]
    fn options_default_to_menu_on_left_click() {
        let o: TrayOptions = serde_json::from_value(json!({ "tooltip": "t" })).unwrap();
        assert!(o.menu_on_left_click && !o.close_to_tray);
        let o: TrayOptions = serde_json::from_value(json!({ "menuOnLeftClick": false })).unwrap();
        assert!(!o.menu_on_left_click);
        assert!(serde_json::from_value::<TrayOptions>(json!({ "icon": "x.png" })).is_err());
    }

    #[test]
    fn submenus_nest_at_most_four_deep() {
        let nest = |depth: usize| {
            let mut v = json!([{ "id": "leaf", "label": "Leaf" }]);
            for _ in 1..depth {
                v = json!([{ "label": "Sub", "items": v }]);
            }
            v
        };
        assert!(parse(nest(4)).is_ok());
        assert!(parse(nest(5)).unwrap_err().contains("at most 4 deep"));
    }
}
