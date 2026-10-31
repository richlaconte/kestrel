// The `store` std-lib module (#18): a durable key-value map for the app, kept
// as one JSON file in Kestrel's reserved corner of the app data dir
// (`<data dir>/.kestrel/store.json`), which `fs:app-data` code can't touch.
//
// Every change is written through before it returns: serialize, write a temp
// file, fsync, rename over the old file. A crash leaves either the old map or
// the new one on disk, never half of one. Fine for settings-sized data; a
// SQLite module can come later for more.

use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

use crate::error::KestrelError;

pub struct Store {
    path: PathBuf,
    map: Mutex<BTreeMap<String, serde_json::Value>>,
}

impl Store {
    /// Load the store, or start empty if there is none yet. A file that
    /// isn't a JSON object (hand-edited, say) is moved aside rather than
    /// overwritten, and the app starts with an empty store.
    pub fn open(data_dir: &Path) -> Store {
        let path = data_dir.join(crate::scope::RESERVED).join("store.json");
        let map = match fs::read_to_string(&path) {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|e| {
                let aside = path.with_extension("json.corrupt");
                eprintln!(
                    "kestrel-host: warning: {} is not a JSON object ({e}); moved it to {} and started an empty store",
                    path.display(),
                    aside.display()
                );
                let _ = fs::rename(&path, &aside);
                BTreeMap::new()
            }),
            Err(_) => BTreeMap::new(),
        };
        Store {
            path,
            map: Mutex::new(map),
        }
    }

    pub fn get(&self, key: &str) -> Option<serde_json::Value> {
        self.map.lock().unwrap().get(key).cloned()
    }

    pub fn set(&self, key: String, value: serde_json::Value) -> Result<(), KestrelError> {
        let mut map = self.map.lock().unwrap();
        let old = map.insert(key.clone(), value);
        self.flush(&map).inspect_err(|_| {
            // Keep memory in step with disk when the write fails.
            match old {
                Some(v) => map.insert(key, v),
                None => map.remove(&key),
            };
        })
    }

    /// True if the key was there.
    pub fn delete(&self, key: &str) -> Result<bool, KestrelError> {
        let mut map = self.map.lock().unwrap();
        let Some(old) = map.remove(key) else {
            return Ok(false);
        };
        self.flush(&map)
            .inspect_err(|_| {
                map.insert(key.to_string(), old);
            })
            .map(|()| true)
    }

    pub fn keys(&self) -> Vec<String> {
        self.map.lock().unwrap().keys().cloned().collect()
    }

    fn flush(&self, map: &BTreeMap<String, serde_json::Value>) -> Result<(), KestrelError> {
        let io = |e: std::io::Error| {
            KestrelError::new("io", format!("cannot save {}: {e}", self.path.display()))
        };
        let dir = self.path.parent().expect("store path has a parent");
        fs::create_dir_all(dir).map_err(io)?;
        let tmp = self.path.with_extension("json.tmp");
        let json = serde_json::to_vec_pretty(map).expect("JSON values serialize");
        let mut f = fs::File::create(&tmp).map_err(io)?;
        f.write_all(&json).and_then(|()| f.sync_all()).map_err(io)?;
        drop(f);
        fs::rename(&tmp, &self.path).map_err(io)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp() -> PathBuf {
        // Unique per call: Windows' clock can repeat between quick calls.
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        std::env::temp_dir().join(format!(
            "kestrel-store-{}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn values_survive_a_reopen() {
        let dir = tmp();
        let s = Store::open(&dir);
        assert_eq!(s.get("theme"), None);
        s.set("theme".into(), json!("dark")).unwrap();
        s.set("window".into(), json!({ "w": 800, "pinned": [1, 2] }))
            .unwrap();
        s.set("gone".into(), json!(true)).unwrap();
        assert!(s.delete("gone").unwrap());
        assert!(!s.delete("gone").unwrap());

        let s = Store::open(&dir);
        assert_eq!(s.get("theme"), Some(json!("dark")));
        assert_eq!(s.get("window"), Some(json!({ "w": 800, "pinned": [1, 2] })));
        assert_eq!(s.keys(), vec!["theme", "window"]);
        assert_eq!(s.path, dir.join(".kestrel/store.json"));
        assert!(
            !dir.join(".kestrel/store.json.tmp").exists(),
            "the temp file is renamed into place"
        );
    }

    #[test]
    fn a_corrupt_file_is_moved_aside_not_overwritten() {
        let dir = tmp();
        fs::create_dir_all(dir.join(".kestrel")).unwrap();
        fs::write(dir.join(".kestrel/store.json"), "{ not json").unwrap();
        let s = Store::open(&dir);
        assert_eq!(s.keys(), Vec::<String>::new());
        assert_eq!(
            fs::read_to_string(dir.join(".kestrel/store.json.corrupt")).unwrap(),
            "{ not json"
        );
        s.set("k".into(), json!(1)).unwrap();
        assert_eq!(Store::open(&dir).get("k"), Some(json!(1)));
    }

    #[test]
    fn a_failed_write_leaves_memory_and_disk_unchanged() {
        let dir = tmp();
        let s = Store::open(&dir);
        s.set("k".into(), json!(1)).unwrap();
        // A directory where the temp file must go makes every flush fail.
        fs::create_dir_all(dir.join(".kestrel/store.json.tmp/x")).unwrap();
        assert_eq!(s.set("k".into(), json!(2)).unwrap_err().code, "io");
        assert_eq!(s.set("new".into(), json!(3)).unwrap_err().code, "io");
        assert_eq!(s.delete("k").unwrap_err().code, "io");
        assert_eq!((s.get("k"), s.get("new")), (Some(json!(1)), None));
        assert_eq!(Store::open(&dir).get("k"), Some(json!(1)));
    }
}
