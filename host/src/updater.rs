// The `updater` std-lib module (#28): check a feed for a newer version,
// download it, verify its Ed25519 signature against the public key in the
// manifest, install it in place and relaunch.
//
// The feed (`updater.endpoint`) is JSON:
//
//   { "version": "1.2.0", "notes": "…", "pubDate": "…",
//     "platforms": { "macos-aarch64": { "url": "…", "signature": "<base64>" }, … } }
//
// `url` may be relative to the feed. `kestrel build` writes the feed and the
// signed files; `kestrel updater merge` joins feeds built on several OSes.
//
// What gets replaced depends on how the app was installed:
//   macOS     the .app, from a .tar.gz of it
//   Linux     the AppImage file ($APPIMAGE)
//   Windows   the per-user install, by running the new setup.exe silently
// Anything else (dev, a portable folder, a .deb that apt owns) can check but
// not apply: apply rejects with unsupported_platform.

use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::{error::KestrelError, Manifest};

/// The manifest's `updater` block.
#[derive(Clone, Deserialize, Serialize)]
pub struct UpdaterConfig {
    /// The feed's URL: https, or http to localhost.
    pub endpoint: String,
    /// The Ed25519 public key that signs updates, base64 (32 bytes).
    pub pubkey: String,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Feed {
    pub version: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub pub_date: Option<String>,
    pub platforms: std::collections::HashMap<String, Artifact>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Artifact {
    pub url: String,
    pub signature: String,
}

/// What check() resolves to when there's something newer.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Available {
    pub version: String,
    pub notes: Option<String>,
    pub pub_date: Option<String>,
    /// False when this copy can't replace itself (dev, portable, .deb).
    pub can_apply: bool,
}

/// Updates are bigger than any app should be; past this, stop downloading.
const MAX_DOWNLOAD: u64 = 1 << 30;

fn io(msg: impl Into<String>) -> KestrelError {
    KestrelError::new("io", msg)
}

/// This machine's key in the feed's `platforms`.
pub fn platform_key() -> String {
    // Rust's names already match the feed's: macos/linux/windows and
    // x86_64/aarch64.
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

// ---- versions ----

/// Compare semver-style versions: numeric core, then a pre-release sorts
/// before its release, then pre-release identifiers in order (numbers
/// numerically, below words). Build metadata (+…) is ignored.
pub fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    fn split(v: &str) -> (Vec<u64>, Option<&str>) {
        let v = v.trim().trim_start_matches('v');
        let v = v.split('+').next().unwrap_or("");
        let (core, pre) = match v.split_once('-') {
            Some((c, p)) => (c, Some(p)),
            None => (v, None),
        };
        (
            core.split('.').map(|n| n.parse().unwrap_or(0)).collect(),
            pre,
        )
    }
    let ((ca, pa), (cb, pb)) = (split(a), split(b));
    for i in 0..ca.len().max(cb.len()) {
        let o = ca.get(i).unwrap_or(&0).cmp(cb.get(i).unwrap_or(&0));
        if o != Ordering::Equal {
            return o;
        }
    }
    match (pa, pb) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(pa), Some(pb)) => {
            let (ia, ib): (Vec<_>, Vec<_>) = (pa.split('.').collect(), pb.split('.').collect());
            for i in 0..ia.len().max(ib.len()) {
                let o = match (ia.get(i), ib.get(i)) {
                    (None, None) => Ordering::Equal,
                    (None, Some(_)) => Ordering::Less,
                    (Some(_), None) => Ordering::Greater,
                    (Some(x), Some(y)) => match (x.parse::<u64>(), y.parse::<u64>()) {
                        (Ok(x), Ok(y)) => x.cmp(&y),
                        (Ok(_), Err(_)) => Ordering::Less,
                        (Err(_), Ok(_)) => Ordering::Greater,
                        (Err(_), Err(_)) => x.cmp(y),
                    },
                };
                if o != Ordering::Equal {
                    return o;
                }
            }
            Ordering::Equal
        }
    }
}

// ---- signatures ----

/// Check `sig` (base64, 64 bytes) over `data` with `pubkey` (base64, 32 bytes).
pub fn verify(pubkey: &str, data: &[u8], sig: &str) -> Result<(), KestrelError> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let pk = b64
        .decode(pubkey.trim())
        .ok()
        .and_then(|k| ed25519_compact::PublicKey::from_slice(&k).ok())
        .ok_or_else(|| io("updater: `pubkey` in kestrel.json isn't a base64 Ed25519 public key"))?;
    let sig = b64
        .decode(sig.trim())
        .ok()
        .and_then(|s| ed25519_compact::Signature::from_slice(&s).ok())
        .ok_or_else(|| io("updater: the feed's signature isn't a base64 Ed25519 signature"))?;
    pk.verify(data, &sig).map_err(|_| {
        KestrelError::new(
            "permission_denied",
            "updater: the download's signature doesn't match the app's public key; not installing it",
        )
    })
}

// ---- fetching ----

/// https anywhere; http only to this machine (local testing).
pub fn allowed_url(url: &tauri::Url) -> bool {
    match url.scheme() {
        "https" => true,
        "http" => matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")),
        _ => false,
    }
}

fn get(url: &tauri::Url) -> Result<Vec<u8>, KestrelError> {
    if !allowed_url(url) {
        return Err(KestrelError::new(
            "permission_denied",
            format!("updater: {url} must be https (http only to localhost)"),
        ));
    }
    let res = minreq::get(url.as_str())
        .with_timeout(300)
        .with_max_redirects(5)
        .send()
        .map_err(|e| io(format!("updater: GET {url}: {e}")))?;
    if res.status_code == 404 {
        return Err(KestrelError::new(
            "not_found",
            format!("updater: {url} returned 404"),
        ));
    }
    if !(200..300).contains(&res.status_code) {
        return Err(io(format!("updater: GET {url}: HTTP {}", res.status_code)));
    }
    let body = res.into_bytes();
    if body.len() as u64 > MAX_DOWNLOAD {
        return Err(io(format!("updater: {url} is over 1 GB")));
    }
    Ok(body)
}

fn config(manifest: &Manifest) -> Result<(&UpdaterConfig, tauri::Url), KestrelError> {
    let cfg = manifest.updater.as_ref().ok_or_else(|| {
        KestrelError::new(
            "unsupported_platform",
            "updater: add \"updater\": { \"endpoint\", \"pubkey\" } to kestrel.json",
        )
    })?;
    let url = cfg.endpoint.parse().map_err(|e| {
        io(format!(
            "updater: endpoint {:?} isn't a URL ({e})",
            cfg.endpoint
        ))
    })?;
    Ok((cfg, url))
}

/// The feed, and this platform's artifact if there's a newer version.
fn newer(manifest: &Manifest) -> Result<Option<(Feed, Option<Artifact>)>, KestrelError> {
    let (_, endpoint) = config(manifest)?;
    let body = get(&endpoint)?;
    let feed: Feed = serde_json::from_slice(&body)
        .map_err(|e| io(format!("updater: the feed at {endpoint} isn't valid ({e})")))?;
    if compare_versions(&feed.version, &manifest.version) != std::cmp::Ordering::Greater {
        return Ok(None);
    }
    let artifact = feed.platforms.get(&platform_key()).cloned();
    Ok(Some((feed, artifact)))
}

// ---- how this copy was installed ----

#[derive(Debug, PartialEq)]
pub enum Install {
    /// The .app at this path.
    MacApp(PathBuf),
    /// The AppImage file at this path.
    AppImage(PathBuf),
    /// A per-user NSIS install in this folder.
    Nsis(PathBuf),
}

/// Work out what can be replaced, from the executable's path (and
/// $APPIMAGE on Linux). None: nothing this updater can replace.
pub fn install_kind(exe: &Path, appimage: Option<&str>) -> Option<Install> {
    if cfg!(target_os = "macos") {
        let macos = exe.parent()?;
        let contents = macos.parent()?;
        let app = contents.parent()?;
        let is_app = macos.file_name()? == "MacOS"
            && contents.file_name()? == "Contents"
            && app.extension().is_some_and(|e| e == "app");
        return is_app.then(|| Install::MacApp(app.to_path_buf()));
    }
    if cfg!(target_os = "linux") {
        return appimage
            .filter(|p| !p.is_empty())
            .map(|p| Install::AppImage(PathBuf::from(p)));
    }
    if cfg!(windows) {
        let dir = exe.parent()?;
        return dir
            .join("uninstall.exe")
            .is_file()
            .then(|| Install::Nsis(dir.to_path_buf()));
    }
    None
}

fn current_install() -> Option<Install> {
    let exe = std::env::current_exe().ok()?;
    install_kind(&exe, std::env::var("APPIMAGE").ok().as_deref())
}

// ---- commands ----

/// A newer version, or null.
#[tauri::command]
pub async fn updater_check(
    manifest: State<'_, Manifest>,
) -> Result<Option<Available>, KestrelError> {
    let Some((feed, artifact)) = newer(&manifest)? else {
        return Ok(None);
    };
    Ok(Some(Available {
        version: feed.version,
        notes: feed.notes,
        pub_date: feed.pub_date,
        can_apply: artifact.is_some() && current_install().is_some(),
    }))
}

/// Download, verify, install and relaunch. Resolves false when there's
/// nothing newer; on success the app quits and the new version starts.
#[tauri::command]
pub async fn updater_apply(
    app: AppHandle,
    manifest: State<'_, Manifest>,
) -> Result<bool, KestrelError> {
    let install = current_install().ok_or_else(|| {
        KestrelError::new(
            "unsupported_platform",
            "updater: this copy can't replace itself (dev, a portable folder, or a package manager's install)",
        )
    })?;
    let Some((feed, artifact)) = newer(&manifest)? else {
        return Ok(false);
    };
    let artifact = artifact.ok_or_else(|| {
        KestrelError::new(
            "unsupported_platform",
            format!(
                "updater: {} has no build for {}",
                feed.version,
                platform_key()
            ),
        )
    })?;
    let (cfg, endpoint) = config(&manifest)?;
    let url = endpoint
        .join(&artifact.url)
        .map_err(|e| io(format!("updater: bad url {:?} ({e})", artifact.url)))?;
    let data = get(&url)?;
    verify(&cfg.pubkey, &data, &artifact.signature)?;
    eprintln!(
        "kestrel-host: updating {} → {}",
        manifest.version, feed.version
    );
    install_and_relaunch(&install, &data, &manifest.app_id)?;
    app.exit(0);
    Ok(true)
}

fn install_and_relaunch(install: &Install, data: &[u8], app_id: &str) -> Result<(), KestrelError> {
    let ioe = |what: &str, e: std::io::Error| io(format!("updater: {what}: {e}"));
    match install {
        Install::MacApp(app) => {
            // Stage beside the .app, so the swap is two renames on one disk.
            let parent = app
                .parent()
                .ok_or_else(|| io("updater: the .app has no folder"))?;
            let stage = parent.join(format!(".{app_id}.update-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&stage);
            std::fs::create_dir_all(&stage).map_err(|e| ioe("staging", e))?;
            let result = (|| {
                let tgz = stage.join("update.tar.gz");
                std::fs::write(&tgz, data).map_err(|e| ioe("saving the download", e))?;
                let out = std::process::Command::new("/usr/bin/tar")
                    .arg("-xzf")
                    .arg(&tgz)
                    .arg("-C")
                    .arg(&stage)
                    .output()
                    .map_err(|e| ioe("running tar", e))?;
                if !out.status.success() {
                    return Err(io(format!(
                        "updater: unpacking failed: {}",
                        String::from_utf8_lossy(&out.stderr).trim()
                    )));
                }
                let new_app = std::fs::read_dir(&stage)
                    .map_err(|e| ioe("reading the update", e))?
                    .filter_map(|e| e.ok().map(|e| e.path()))
                    .find(|p| p.extension().is_some_and(|e| e == "app"))
                    .ok_or_else(|| io("updater: the update has no .app in it"))?;
                let old = stage.join("previous.app");
                std::fs::rename(app, &old).map_err(|e| ioe("moving the old version aside", e))?;
                if let Err(e) = std::fs::rename(&new_app, app) {
                    let _ = std::fs::rename(&old, app);
                    return Err(ioe("moving the new version in", e));
                }
                Ok(())
            })();
            let exe = std::env::current_exe()
                .ok()
                .and_then(|p| p.file_name().map(|n| n.to_owned()));
            let _ = std::fs::remove_dir_all(&stage);
            result?;
            let exe = app
                .join("Contents/MacOS")
                .join(exe.unwrap_or_else(|| app_id.into()));
            relaunch(&exe, &[])
        }
        Install::AppImage(path) => {
            let tmp = path.with_extension("AppImage.update");
            std::fs::write(&tmp, data).map_err(|e| ioe("saving the download", e))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))
                    .map_err(|e| ioe("making it executable", e))?;
            }
            // The running copy is mounted from the old file, which keeps
            // working after the rename replaces its name.
            std::fs::rename(&tmp, path).map_err(|e| {
                let _ = std::fs::remove_file(&tmp);
                ioe("replacing the AppImage", e)
            })?;
            relaunch(path, &[])
        }
        Install::Nsis(_) => {
            let setup = std::env::temp_dir().join(format!("{app_id}-update-setup.exe"));
            std::fs::write(&setup, data).map_err(|e| ioe("saving the installer", e))?;
            // /S: silent. --relaunch: start the app when done, after waiting
            // for this process to exit and let go of its files.
            relaunch(&setup, &["/S", "--relaunch"])
        }
    }
}

fn relaunch(program: &Path, args: &[&str]) -> Result<(), KestrelError> {
    std::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| io(format!("updater: starting {}: {e}", program.display())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering::*;

    #[test]
    fn versions_compare_like_semver() {
        assert_eq!(compare_versions("1.2.0", "1.10.0"), Less);
        assert_eq!(compare_versions("2.0.0", "1.99.99"), Greater);
        assert_eq!(compare_versions("1.0", "1.0.0"), Equal);
        assert_eq!(compare_versions("v1.0.1", "1.0.0"), Greater);
        assert_eq!(compare_versions("1.0.0-beta.1", "1.0.0"), Less);
        assert_eq!(compare_versions("1.0.0-beta.2", "1.0.0-beta.10"), Less);
        assert_eq!(compare_versions("1.0.0-alpha", "1.0.0-beta"), Less);
        assert_eq!(compare_versions("1.0.0-1", "1.0.0-alpha"), Less);
        assert_eq!(compare_versions("1.0.0-beta", "1.0.0-beta.1"), Less);
        assert_eq!(compare_versions("1.0.0+build.5", "1.0.0"), Equal);
    }

    // From Node, the way the CLI signs: crypto.generateKeyPairSync("ed25519"),
    // the raw public key (the SPKI's last 32 bytes), and
    // crypto.sign(null, Buffer.from("kestrel update"), privateKey).
    const NODE_PUBKEY: &str = "MoazJXfi3mmeMYPNrJc58l1wIA8C4dB34qMlvJa9AhE=";
    const NODE_SIG: &str =
        "1KmJm5M563u8fBmV+3rUU2hGAl8D/fbBrOvky7TuJdLeywhXBRcSIe/f/BC4yQUe5tUb0rtfJbS484FCM95KDw==";

    #[test]
    fn signatures_from_node_verify() {
        verify(NODE_PUBKEY, b"kestrel update", NODE_SIG).unwrap();
        assert_eq!(
            verify(NODE_PUBKEY, b"kestrel updatE", NODE_SIG)
                .unwrap_err()
                .code,
            "permission_denied"
        );
    }

    #[test]
    fn signatures_are_checked() {
        let (pk, sig) = test_vector();
        verify(&pk, b"kestrel update", &sig).unwrap();
        let e = verify(&pk, b"kestrel updatE", &sig).unwrap_err();
        assert_eq!(e.code, "permission_denied");
        assert!(e.message.contains("doesn't match"));
        assert_eq!(verify(&pk, b"x", "bm9wZQ==").unwrap_err().code, "io");
        assert!(verify("short", b"x", &sig)
            .unwrap_err()
            .message
            .contains("`pubkey`"));
        assert_eq!(
            verify(NODE_PUBKEY, b"kestrel update", &sig)
                .unwrap_err()
                .code,
            "permission_denied",
            "another key's signature"
        );
    }

    /// A key pair and a signature over "kestrel update", generated here so
    /// the test needs no fixture.
    fn test_vector() -> (String, String) {
        let b64 = base64::engine::general_purpose::STANDARD;
        let kp = ed25519_compact::KeyPair::from_seed(ed25519_compact::Seed::new([7; 32]));
        let sig = kp.sk.sign(b"kestrel update", None);
        (b64.encode(kp.pk.as_ref()), b64.encode(sig.as_ref()))
    }

    #[test]
    fn only_https_or_local_http() {
        let ok = |u: &str| allowed_url(&u.parse().unwrap());
        assert!(ok("https://example.com/latest.json"));
        assert!(ok("http://127.0.0.1:8080/latest.json"));
        assert!(ok("http://localhost/x"));
        assert!(!ok("http://example.com/latest.json"));
        assert!(!ok("file:///etc/passwd"));
        assert!(!ok("ftp://example.com/x"));
    }

    #[test]
    fn feeds_parse_and_urls_resolve_against_them() {
        let feed: Feed = serde_json::from_str(
            r#"{"version":"1.1.0","notes":"Fixes","platforms":{"macos-aarch64":{"url":"My-App.app.tar.gz","signature":"x"}}}"#,
        )
        .unwrap();
        assert_eq!(feed.version, "1.1.0");
        assert_eq!(feed.pub_date, None);
        let base: tauri::Url = "https://example.com/app/latest.json".parse().unwrap();
        let url = base.join(&feed.platforms["macos-aarch64"].url).unwrap();
        assert_eq!(url.as_str(), "https://example.com/app/My-App.app.tar.gz");
        assert_eq!(
            base.join("https://cdn.example.com/x").unwrap().as_str(),
            "https://cdn.example.com/x"
        );
    }

    #[test]
    fn the_platform_key_names_os_and_cpu() {
        let k = platform_key();
        assert!(
            [
                "macos-aarch64",
                "macos-x86_64",
                "linux-x86_64",
                "linux-aarch64",
                "windows-x86_64",
                "windows-aarch64"
            ]
            .contains(&k.as_str()),
            "{k}"
        );
    }

    #[test]
    fn install_kinds() {
        if cfg!(target_os = "macos") {
            assert_eq!(
                install_kind(
                    Path::new("/Applications/My App.app/Contents/MacOS/my-app"),
                    None
                ),
                Some(Install::MacApp("/Applications/My App.app".into()))
            );
            assert_eq!(
                install_kind(Path::new("/tmp/build/my-app/my-app"), None),
                None
            );
        }
        if cfg!(target_os = "linux") {
            assert_eq!(
                install_kind(
                    Path::new("/tmp/.mount_x/usr/lib/a/a"),
                    Some("/home/u/A.AppImage")
                ),
                Some(Install::AppImage("/home/u/A.AppImage".into()))
            );
            assert_eq!(
                install_kind(Path::new("/opt/a/a"), None),
                None,
                "a .deb install"
            );
        }
        if cfg!(windows) {
            let dir = std::env::temp_dir().join(format!("kestrel-nsis-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            assert_eq!(install_kind(&dir.join("a.exe"), None), None);
            std::fs::write(dir.join("uninstall.exe"), "").unwrap();
            assert_eq!(
                install_kind(&dir.join("a.exe"), None),
                Some(Install::Nsis(dir.clone()))
            );
            std::fs::remove_dir_all(&dir).unwrap();
        }
    }
}
