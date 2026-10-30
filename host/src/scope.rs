// Manifest permissions (RFC-0001 §6) and the filesystem scope they grant.
// The manifest's `permissions` array is the only source of authority: an
// ungranted capability's host bindings are never installed in the engine.

use std::path::{Component, Path, PathBuf};

use crate::error::KestrelError;

/// Every permission the host understands. Unknown names are a manifest
/// error, not a silent no-op: a grant that does nothing would mislead.
pub const KNOWN: &[&str] = &["fs:app-data", "fs:all"];

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FsScope {
    /// Reads and writes stay inside the app's data dir.
    AppData,
    /// Any path the user can access. Relative paths still resolve in the
    /// app's data dir, never the process cwd.
    All,
}

/// Reject unknown or duplicate permissions; return the fs scope granted.
pub fn parse(perms: &[String]) -> Result<Option<FsScope>, String> {
    let mut seen = Vec::new();
    for p in perms {
        if !KNOWN.contains(&p.as_str()) {
            return Err(format!(
                "`{p}` is not a known permission (available: {})",
                KNOWN.join(", ")
            ));
        }
        if seen.contains(&p) {
            return Err(format!("permission `{p}` is listed twice"));
        }
        seen.push(p);
    }
    let has = |n: &str| perms.iter().any(|p| p == n);
    Ok(if has("fs:all") {
        Some(FsScope::All)
    } else if has("fs:app-data") {
        Some(FsScope::AppData)
    } else {
        None
    })
}

/// The platform data dir for `app_id`: ~/Library/Application Support/<id>,
/// %APPDATA%\<id>, or $XDG_DATA_HOME/<id>. `KESTREL_DATA_DIR` overrides it
/// (tests and CI point it at a temp dir).
pub fn app_data_dir(app_id: &str) -> Result<PathBuf, String> {
    if let Some(d) = std::env::var_os("KESTREL_DATA_DIR").filter(|d| !d.is_empty()) {
        return Ok(PathBuf::from(d));
    }
    dirs::data_dir()
        .map(|d| d.join(app_id))
        .ok_or_else(|| "cannot determine the platform data directory".to_string())
}

/// Kestrel's own state inside the app data dir (the webview's storage:
/// localStorage, IndexedDB, cookies). Native code can't reach it under
/// `fs:app-data`.
pub const RESERVED: &str = ".kestrel";

/// Where the webview keeps its storage for this app (Windows, Linux).
pub fn webview_data_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(RESERVED).join("webview")
}

/// A stable 16-byte id for the app's WKWebView data store (macOS 14+, which
/// has no data directory setting). Two 64-bit FNV-1a passes over the app id
/// with different offset bases: not cryptographic, only needs to be stable
/// across launches and distinct between app ids.
pub fn webview_store_id(app_id: &str) -> [u8; 16] {
    let fnv = |basis: u64| {
        app_id.bytes().fold(basis, |h, b| {
            (h ^ u64::from(b)).wrapping_mul(0x0000_0100_0000_01b3)
        })
    };
    let mut id = [0u8; 16];
    id[..8].copy_from_slice(&fnv(0xcbf2_9ce4_8422_2325).to_be_bytes());
    id[8..].copy_from_slice(&fnv(0x6c62_272e_07bb_0142).to_be_bytes());
    id
}

/// A filesystem grant: a scope plus the app's (canonical) data dir.
#[derive(Clone, Debug)]
pub struct Fs {
    pub scope: FsScope,
    pub root: PathBuf,
}

impl Fs {
    /// Create the data dir if needed and pin its canonical path, so that
    /// containment checks compare like with like (/var vs /private/var,
    /// \\?\ prefixes on Windows).
    pub fn new(scope: FsScope, data_dir: &Path) -> Result<Fs, String> {
        std::fs::create_dir_all(data_dir)
            .and_then(|_| data_dir.canonicalize())
            .map(|root| Fs { scope, root })
            .map_err(|e| format!("cannot create app data dir {}: {e}", data_dir.display()))
    }

    /// Map a path from native code to the real path it may touch.
    /// Relative paths resolve in the data dir. Under `AppData`, `..` is
    /// refused outright and the nearest existing ancestor is canonicalized,
    /// so a symlink that points outside the data dir is an escape too.
    pub fn resolve(&self, p: &str) -> Result<PathBuf, KestrelError> {
        if p.is_empty() {
            return Err(KestrelError::new("io", "empty path"));
        }
        let path = Path::new(p);
        let joined = if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.root.join(path)
        };
        if self.scope == FsScope::All {
            return Ok(joined);
        }
        if path.components().any(|c| c == Component::ParentDir) {
            return Err(KestrelError::new(
                "permission_denied",
                format!("`..` is not allowed in {p}"),
            ));
        }
        // Walk up to the nearest ancestor that exists, then put the
        // not-yet-existing tail back on its canonical form.
        let mut existing = joined.as_path();
        let mut tail = Vec::new();
        let real = loop {
            match existing.canonicalize() {
                Ok(c) => break c,
                // There but unresolvable: a dangling symlink, which a
                // write would follow to wherever it points.
                Err(_) if existing.symlink_metadata().is_ok() => {
                    return Err(KestrelError::new(
                        "permission_denied",
                        format!("{p} is a broken symlink"),
                    ));
                }
                Err(_) => match (existing.parent(), existing.file_name()) {
                    (Some(parent), Some(name)) => {
                        tail.push(name.to_owned());
                        existing = parent;
                    }
                    _ => return Err(KestrelError::new("io", format!("cannot resolve {p}"))),
                },
            }
        };
        if !real.starts_with(&self.root) {
            return Err(KestrelError::new(
                "permission_denied",
                format!("{p} is outside the app data dir (fs:app-data)"),
            ));
        }
        // Case-insensitive: macOS and Windows filesystems usually are.
        let first = real
            .strip_prefix(&self.root)
            .ok()
            .and_then(|r| r.components().next())
            .or_else(|| tail.last().map(|n| Component::Normal(n.as_os_str())));
        if let Some(Component::Normal(n)) = first {
            if n.to_string_lossy().eq_ignore_ascii_case(RESERVED) {
                return Err(KestrelError::new(
                    "permission_denied",
                    format!("{p} is Kestrel's own storage, not app data"),
                ));
            }
        }
        Ok(tail.iter().rev().fold(real, |acc, n| acc.join(n)))
    }

    pub fn read(&self, p: &str) -> Result<String, KestrelError> {
        let real = self.resolve(p)?;
        std::fs::read_to_string(&real).map_err(|e| io_err(p, e))
    }

    pub fn read_bytes(&self, p: &str) -> Result<Vec<u8>, KestrelError> {
        let real = self.resolve(p)?;
        std::fs::read(&real).map_err(|e| io_err(p, e))
    }

    pub fn write(&self, p: &str, contents: &str) -> Result<(), KestrelError> {
        let real = self.resolve(p)?;
        if let Some(parent) = real.parent() {
            std::fs::create_dir_all(parent).map_err(|e| io_err(p, e))?;
            // Creating the parents could have walked through a symlink
            // planted after `resolve`; check the result again.
            if self.scope == FsScope::AppData {
                let parent = parent.canonicalize().map_err(|e| io_err(p, e))?;
                if !parent.starts_with(&self.root) {
                    return Err(KestrelError::new(
                        "permission_denied",
                        format!("{p} is outside the app data dir (fs:app-data)"),
                    ));
                }
            }
        }
        std::fs::write(&real, contents).map_err(|e| io_err(p, e))
    }

    pub fn exists(&self, p: &str) -> Result<bool, KestrelError> {
        Ok(self.resolve(p)?.exists())
    }
}

fn io_err(p: &str, e: std::io::Error) -> KestrelError {
    let code = match e.kind() {
        std::io::ErrorKind::NotFound => "not_found",
        std::io::ErrorKind::PermissionDenied => "permission_denied",
        _ => "io",
    };
    KestrelError::new(code, format!("{p}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "kestrel-scope-{tag}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn perms(p: &[&str]) -> Vec<String> {
        p.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parse_grants_and_rejects() {
        assert_eq!(parse(&[]), Ok(None));
        assert_eq!(parse(&perms(&["fs:app-data"])), Ok(Some(FsScope::AppData)));
        assert_eq!(
            parse(&perms(&["fs:app-data", "fs:all"])),
            Ok(Some(FsScope::All))
        );
        let e = parse(&perms(&["fs:everything"])).unwrap_err();
        assert!(
            e.contains("not a known permission") && e.contains("fs:app-data"),
            "{e}"
        );
        assert!(parse(&perms(&["fs:all", "fs:all"]))
            .unwrap_err()
            .contains("twice"));
    }

    #[test]
    fn app_data_relative_paths_round_trip_inside_the_root() {
        let fs = Fs::new(FsScope::AppData, &tmp("rt").join("data")).unwrap();
        fs.write("notes/a.txt", "hi").unwrap();
        assert_eq!(fs.read("notes/a.txt").unwrap(), "hi");
        assert!(fs.root.join("notes/a.txt").is_file());
        assert!(fs.exists("notes/a.txt").unwrap());
        assert!(!fs.exists("nope.txt").unwrap());
        assert!(fs.read("nope.txt").unwrap_err().code == "not_found");
        // An absolute path inside the root is fine too.
        let abs = fs.root.join("notes/a.txt");
        assert_eq!(fs.read(abs.to_str().unwrap()).unwrap(), "hi");
    }

    #[test]
    fn app_data_refuses_escapes() {
        let base = tmp("esc");
        std::fs::write(base.join("secret.txt"), "s").unwrap();
        let fs = Fs::new(FsScope::AppData, &base.join("data")).unwrap();
        for p in ["../secret.txt", "../../etc/passwd", "a/../../secret.txt"] {
            let e = fs.read(p).unwrap_err();
            assert!(e.code == "permission_denied", "{p}: {e}");
        }
        let outside = base.join("secret.txt");
        let e = fs.read(outside.to_str().unwrap()).unwrap_err();
        assert!(e.code == "permission_denied", "{e}");
        let e = fs.write(outside.to_str().unwrap(), "x").unwrap_err();
        assert!(e.code == "permission_denied", "{e}");
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "s");
    }

    #[test]
    fn app_data_refuses_kestrels_own_storage() {
        let fs = Fs::new(FsScope::AppData, &tmp("res").join("data")).unwrap();
        std::fs::create_dir_all(webview_data_dir(&fs.root)).unwrap();
        for p in [
            ".kestrel/webview/x",
            ".kestrel",
            ".KESTREL/new.txt",
            "./.kestrel/x",
        ] {
            let e = fs.write(p, "x").unwrap_err();
            assert!(e.code == "permission_denied", "{p}: {e}");
        }
        let abs = fs.root.join(".kestrel/webview/x");
        assert!(fs.read(abs.to_str().unwrap()).unwrap_err().code == "permission_denied");
        // Lookalikes are ordinary app data.
        fs.write(".kestrel-notes.txt", "ok").unwrap();
        fs.write("sub/.kestrel/x", "ok").unwrap();
    }

    #[test]
    fn store_ids_are_stable_and_distinct() {
        assert_eq!(webview_store_id("my-app"), webview_store_id("my-app"));
        assert_ne!(webview_store_id("my-app"), webview_store_id("my-app2"));
        assert_ne!(webview_store_id("a"), webview_store_id("b"));
    }

    #[cfg(unix)]
    #[test]
    fn app_data_refuses_symlink_escapes() {
        use std::os::unix::fs::symlink;
        let base = tmp("sym");
        std::fs::write(base.join("secret.txt"), "s").unwrap();
        std::fs::create_dir_all(base.join("elsewhere")).unwrap();
        let fs = Fs::new(FsScope::AppData, &base.join("data")).unwrap();
        symlink(base.join("secret.txt"), fs.root.join("link.txt")).unwrap();
        symlink(base.join("elsewhere"), fs.root.join("dir")).unwrap();

        assert!(fs.read("link.txt").unwrap_err().code == "permission_denied");
        assert!(fs.write("link.txt", "x").unwrap_err().code == "permission_denied");
        // A new file under a symlinked dir would land outside.
        assert!(fs.write("dir/new.txt", "x").unwrap_err().code == "permission_denied");
        assert!(fs.write("dir/deep/new.txt", "x").unwrap_err().code == "permission_denied");
        // A dangling link would be followed by the write.
        symlink(base.join("planted.txt"), fs.root.join("dangling.txt")).unwrap();
        assert!(fs.write("dangling.txt", "x").unwrap_err().code == "permission_denied");
        assert!(!base.join("planted.txt").exists());
        assert!(!base.join("elsewhere/new.txt").exists());
        assert!(!base.join("elsewhere/deep").exists());
        assert_eq!(
            std::fs::read_to_string(base.join("secret.txt")).unwrap(),
            "s"
        );
    }

    #[test]
    fn fs_all_reaches_outside_but_relative_stays_in_the_data_dir() {
        let base = tmp("all");
        std::fs::write(base.join("outside.txt"), "o").unwrap();
        let fs = Fs::new(FsScope::All, &base.join("data")).unwrap();
        let outside = base.join("outside.txt");
        assert_eq!(fs.read(outside.to_str().unwrap()).unwrap(), "o");
        fs.write("rel.txt", "r").unwrap();
        assert!(fs.root.join("rel.txt").is_file());
    }
}
