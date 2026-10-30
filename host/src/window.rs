// Window options from the manifest (#23), and remembering the main window's
// size and position between runs.
//
// The state lives in `<data dir>/.kestrel/window.json`. Moves and resizes
// update it in memory; a saver thread writes it once they stop, and once more
// on exit. A window that was on a display that's gone opens at its default
// spot instead.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{Runtime, WebviewWindow, WebviewWindowBuilder};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TitleBar {
    #[default]
    Visible,
    Transparent,
    Overlay,
}

/// The manifest's window fields, flattened into `Manifest`.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowOptions {
    #[serde(default = "yes")]
    pub resizable: bool,
    #[serde(default)]
    pub min_width: Option<f64>,
    #[serde(default)]
    pub min_height: Option<f64>,
    #[serde(default)]
    pub max_width: Option<f64>,
    #[serde(default)]
    pub max_height: Option<f64>,
    /// Center on first launch (a remembered position wins).
    #[serde(default)]
    pub center: bool,
    #[serde(default = "yes")]
    pub decorations: bool,
    /// macOS only; the other platforms always show a normal title bar.
    #[serde(default)]
    pub title_bar_style: TitleBar,
    /// Reopen at the size and position the user left it.
    #[serde(default = "yes")]
    pub remember_window: bool,
}

fn yes() -> bool {
    true
}

impl Default for WindowOptions {
    fn default() -> Self {
        serde_json::from_str("{}").expect("all fields have defaults")
    }
}

impl WindowOptions {
    pub fn apply<'a, R: Runtime, M: tauri::Manager<R>>(
        &self,
        mut b: WebviewWindowBuilder<'a, R, M>,
    ) -> WebviewWindowBuilder<'a, R, M> {
        b = b.resizable(self.resizable).decorations(self.decorations);
        if self.min_width.is_some() || self.min_height.is_some() {
            b = b.min_inner_size(
                self.min_width.unwrap_or(0.0),
                self.min_height.unwrap_or(0.0),
            );
        }
        if self.max_width.is_some() || self.max_height.is_some() {
            b = b.max_inner_size(
                self.max_width.unwrap_or(f64::MAX),
                self.max_height.unwrap_or(f64::MAX),
            );
        }
        #[cfg(target_os = "macos")]
        {
            b = match self.title_bar_style {
                TitleBar::Visible => b,
                TitleBar::Transparent => b.title_bar_style(tauri::TitleBarStyle::Transparent),
                TitleBar::Overlay => b
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true),
            };
        }
        b
    }

    /// A size inside the min/max bounds.
    pub fn clamp(&self, width: f64, height: f64) -> (f64, f64) {
        let fit = |v: f64, lo: Option<f64>, hi: Option<f64>| {
            let v = hi.map_or(v, |hi| v.min(hi));
            lo.map_or(v, |lo| v.max(lo))
        };
        (
            fit(width, self.min_width, self.max_width),
            fit(height, self.min_height, self.max_height),
        )
    }
}

/// A rectangle in logical pixels.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
pub struct Saved {
    #[serde(flatten)]
    pub rect: Rect,
    #[serde(default)]
    pub maximized: bool,
}

/// True if enough of the window's title bar would land on some display to
/// grab it: a strip 100 px wide and 30 px tall at the top of the window.
pub fn reachable(window: Rect, displays: &[Rect]) -> bool {
    displays.iter().any(|d| {
        let overlap_x = (window.x + window.width).min(d.x + d.width) - window.x.max(d.x);
        let top_inside = window.y >= d.y && window.y + 30.0 <= d.y + d.height;
        overlap_x >= 100.0 && top_inside
    })
}

pub struct WindowState {
    path: PathBuf,
    latest: Mutex<Option<Saved>>,
    dirty: Mutex<mpsc::Sender<()>>,
}

impl WindowState {
    /// Load what the last run left, and start the saver thread.
    pub fn open(data_dir: &Path) -> Arc<WindowState> {
        let path = data_dir.join(crate::scope::RESERVED).join("window.json");
        // A missing or unreadable file just means the default placement.
        let latest = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok());
        let (tx, rx) = mpsc::channel();
        let state = Arc::new(WindowState {
            path,
            latest: Mutex::new(latest),
            dirty: Mutex::new(tx),
        });
        let weak = Arc::downgrade(&state);
        std::thread::spawn(move || {
            // Save once the window has been still for a moment.
            while rx.recv().is_ok() {
                while rx.recv_timeout(Duration::from_millis(400)).is_ok() {}
                match weak.upgrade() {
                    Some(s) => s.save(),
                    None => break,
                }
            }
        });
        state
    }

    pub fn saved(&self) -> Option<Saved> {
        *self.latest.lock().unwrap()
    }

    /// Record the window's current bounds. While it's maximized the bounds to
    /// restore to are kept; a minimized window records nothing.
    pub fn track<R: Runtime>(&self, w: &WebviewWindow<R>) {
        if w.is_minimized().unwrap_or(false) || w.is_fullscreen().unwrap_or(false) {
            return;
        }
        let maximized = w.is_maximized().unwrap_or(false);
        let mut latest = self.latest.lock().unwrap();
        let next = if maximized {
            match *latest {
                Some(s) => Saved {
                    maximized: true,
                    ..s
                },
                None => return,
            }
        } else {
            let (Ok(scale), Ok(pos), Ok(size)) =
                (w.scale_factor(), w.outer_position(), w.inner_size())
            else {
                return;
            };
            let (pos, size) = (pos.to_logical::<f64>(scale), size.to_logical::<f64>(scale));
            Saved {
                rect: Rect {
                    x: pos.x,
                    y: pos.y,
                    width: size.width,
                    height: size.height,
                },
                maximized: false,
            }
        };
        if *latest != Some(next) {
            *latest = Some(next);
            let _ = self.dirty.lock().unwrap().send(());
        }
    }

    pub fn save(&self) {
        let Some(saved) = self.saved() else { return };
        let write = || -> std::io::Result<()> {
            fs::create_dir_all(self.path.parent().expect("has a parent"))?;
            let tmp = self.path.with_extension("json.tmp");
            fs::write(&tmp, serde_json::to_vec_pretty(&saved).expect("serializes"))?;
            fs::rename(&tmp, &self.path)
        };
        if let Err(e) = write() {
            eprintln!(
                "kestrel-host: warning: cannot save window state to {}: {e}",
                self.path.display()
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DISPLAY: Rect = Rect {
        x: 0.0,
        y: 0.0,
        width: 1440.0,
        height: 900.0,
    };

    fn at(x: f64, y: f64) -> Rect {
        Rect {
            x,
            y,
            width: 800.0,
            height: 600.0,
        }
    }

    #[test]
    fn reachable_needs_the_title_bar_on_a_display() {
        assert!(reachable(at(100.0, 100.0), &[DISPLAY]));
        // Hanging off the right edge but still grabbable.
        assert!(reachable(at(1300.0, 100.0), &[DISPLAY]));
        // Only a sliver on screen, or the title bar above the top.
        assert!(!reachable(at(1400.0, 100.0), &[DISPLAY]));
        assert!(!reachable(at(100.0, -50.0), &[DISPLAY]));
        // On a second display that has since been unplugged.
        let right = Rect {
            x: 1440.0,
            ..DISPLAY
        };
        assert!(reachable(at(2000.0, 100.0), &[DISPLAY, right]));
        assert!(!reachable(at(2000.0, 100.0), &[DISPLAY]));
        assert!(!reachable(at(100.0, 100.0), &[]));
    }

    #[test]
    fn options_default_and_parse() {
        let d = WindowOptions::default();
        assert!(d.resizable && d.decorations && d.remember_window && !d.center);
        assert_eq!(d.title_bar_style, TitleBar::Visible);
        let o: WindowOptions =
            serde_json::from_str(r#"{"titleBarStyle":"overlay","resizable":false,"minWidth":400}"#)
                .unwrap();
        assert_eq!(o.title_bar_style, TitleBar::Overlay);
        assert!(!o.resizable);
        assert_eq!(o.min_width, Some(400.0));
        assert!(serde_json::from_str::<WindowOptions>(r#"{"titleBarStyle":"hidden"}"#).is_err());
    }

    #[test]
    fn clamp_respects_bounds() {
        let o: WindowOptions =
            serde_json::from_str(r#"{"minWidth":400,"maxWidth":1000,"maxHeight":700}"#).unwrap();
        assert_eq!(o.clamp(300.0, 900.0), (400.0, 700.0));
        assert_eq!(o.clamp(1200.0, 100.0), (1000.0, 100.0));
        assert_eq!(WindowOptions::default().clamp(5.0, 5.0), (5.0, 5.0));
    }

    #[test]
    fn state_round_trips_and_ignores_garbage() {
        let dir = std::env::temp_dir().join(format!(
            "kestrel-window-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let s = WindowState::open(&dir);
        assert_eq!(s.saved(), None);
        s.save(); // nothing to save: no file
        assert!(!dir.join(".kestrel/window.json").exists());

        let saved = Saved {
            rect: at(10.0, 20.0),
            maximized: true,
        };
        *s.latest.lock().unwrap() = Some(saved);
        s.save();
        assert_eq!(WindowState::open(&dir).saved(), Some(saved));

        fs::write(dir.join(".kestrel/window.json"), "{ nope").unwrap();
        assert_eq!(WindowState::open(&dir).saved(), None);
    }
}
