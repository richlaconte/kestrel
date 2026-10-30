// The kestrel:// protocol: static files from the app's frontend dir in
// production, a reverse proxy to the frontend dev server in dev.

use std::{fs, path::Path};

use percent_encoding::percent_decode_str;
use tauri::http::{Request, Response};

pub type Resp = Response<Vec<u8>>;

/// Content types for what a built frontend ships. Strict MIME checks
/// (module scripts, `instantiateStreaming`, fonts) need these to be right.
pub fn mime_for(path: &str) -> &'static str {
    let ext = path.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    match ext.to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "webmanifest" => "application/manifest+json",
        "txt" => "text/plain; charset=utf-8",
        "xml" => "application/xml",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

fn respond(status: u16, mime: &str, body: Vec<u8>) -> Resp {
    Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .body(body)
        .unwrap()
}

/// Serve `uri_path` from `root` (canonical). Missing extensionless paths
/// fall back to index.html, so client-side routes survive a reload.
pub fn serve_static(root: &Path, uri_path: &str) -> Resp {
    let decoded = percent_decode_str(uri_path).decode_utf8_lossy();
    let rel = decoded.trim_start_matches('/');
    let rel = if rel.is_empty() || rel.ends_with('/') {
        format!("{rel}index.html")
    } else {
        rel.to_string()
    };

    // Guard against path traversal out of the frontend dir.
    let inside = |p: &Path| {
        p.canonicalize()
            .map(|f| f.starts_with(root) && f.is_file())
            .unwrap_or(false)
    };
    if rel.split(['/', '\\']).any(|seg| seg == "..") {
        return respond(404, "text/plain", b"not found".to_vec());
    }
    let file = root.join(&rel);
    let last = rel.rsplit('/').next().unwrap_or("");
    let (file, rel) = if inside(&file) {
        (file, rel)
    } else if !last.contains('.') {
        (root.join("index.html"), "index.html".to_string())
    } else {
        return respond(404, "text/plain", b"not found".to_vec());
    };

    match fs::read(&file) {
        Ok(body) => {
            let mut r = respond(200, mime_for(&rel), body);
            if rel.ends_with("index.html") {
                r.headers_mut()
                    .insert("Cache-Control", "no-cache".parse().unwrap());
            }
            r
        }
        Err(_) => respond(404, "text/plain", b"not found".to_vec()),
    }
}

/// Headers that describe one hop, not the message; never forwarded.
const HOP: &[&str] = &[
    "host",
    "connection",
    "keep-alive",
    "proxy-connection",
    "transfer-encoding",
    "upgrade",
    "te",
    "trailer",
    "content-length",
    // minreq doesn't decompress, so ask the dev server for identity.
    "accept-encoding",
];

/// Forward `req` to the dev server at `base`: method, headers and body in,
/// status, headers and body out. Blocking; call it off the main thread.
pub fn proxy(base: &str, req: &Request<Vec<u8>>) -> Resp {
    use minreq::Method;
    let pq = req
        .uri()
        .path_and_query()
        .map(|x| x.as_str())
        .unwrap_or("/");
    let target = format!("{}{}", base.trim_end_matches('/'), pq);
    let method = match req.method().as_str() {
        "GET" => Method::Get,
        "HEAD" => Method::Head,
        "POST" => Method::Post,
        "PUT" => Method::Put,
        "DELETE" => Method::Delete,
        "OPTIONS" => Method::Options,
        "PATCH" => Method::Patch,
        other => Method::Custom(other.to_string()),
    };
    let mut out = minreq::Request::new(method, target).with_max_redirects(0);
    for (k, v) in req.headers() {
        if HOP.contains(&k.as_str()) {
            continue;
        }
        if let Ok(v) = v.to_str() {
            out = out.with_header(k.as_str(), v);
        }
    }
    if !req.body().is_empty() {
        out = out.with_body(req.body().clone());
    }
    match out.send() {
        Ok(resp) => {
            let mut b = Response::builder().status(resp.status_code as u16);
            for (k, v) in &resp.headers {
                if !HOP.contains(&k.as_str()) && k != "content-encoding" {
                    b = b.header(k.as_str(), v.as_str());
                }
            }
            b.body(resp.into_bytes()).unwrap_or_else(|e| {
                respond(502, "text/plain", format!("kestrel dev proxy: {e}").into())
            })
        }
        Err(e) => respond(
            502,
            "text/plain",
            format!("kestrel dev proxy: {e}").into_bytes(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;

    fn site() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kestrel-serve-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("assets")).unwrap();
        fs::write(dir.join("index.html"), "<h1>app</h1>").unwrap();
        fs::write(dir.join("assets/app.wasm"), b"\0asm").unwrap();
        fs::write(dir.join("assets/my font.woff2"), b"wOF2").unwrap();
        dir.canonicalize().unwrap()
    }

    fn header(r: &Resp, k: &str) -> String {
        r.headers()
            .get(k)
            .map(|v| v.to_str().unwrap().to_string())
            .unwrap_or_default()
    }

    #[test]
    fn mime_types() {
        assert_eq!(mime_for("a/b.wasm"), "application/wasm");
        assert_eq!(mime_for("x.WOFF2"), "font/woff2");
        assert_eq!(mime_for("x.mjs"), "text/javascript; charset=utf-8");
        assert_eq!(mime_for("noext"), "application/octet-stream");
    }

    #[test]
    fn serves_files_with_types_and_decodes_paths() {
        let root = site();
        let r = serve_static(&root, "/assets/app.wasm");
        assert_eq!(r.status(), 200);
        assert_eq!(header(&r, "content-type"), "application/wasm");
        let r = serve_static(&root, "/assets/my%20font.woff2");
        assert_eq!(r.status(), 200);
        assert_eq!(header(&r, "content-type"), "font/woff2");
    }

    #[test]
    fn index_is_not_cached() {
        let r = serve_static(&site(), "/");
        assert_eq!(r.body(), b"<h1>app</h1>");
        assert_eq!(header(&r, "cache-control"), "no-cache");
    }

    #[test]
    fn client_routes_fall_back_to_index_but_missing_assets_404() {
        let root = site();
        let r = serve_static(&root, "/settings/profile");
        assert_eq!(r.status(), 200);
        assert_eq!(r.body(), b"<h1>app</h1>");
        assert_eq!(serve_static(&root, "/assets/missing.js").status(), 404);
    }

    #[test]
    fn traversal_is_refused() {
        let root = site();
        assert_eq!(serve_static(&root, "/../../etc/passwd").status(), 404);
        assert_eq!(
            serve_static(&root, "/%2e%2e/%2e%2e/etc/hosts").status(),
            404
        );
    }

    /// One-shot HTTP server that echoes the request back as the body.
    fn echo_server() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(s.try_clone().unwrap());
            let mut head = String::new();
            let mut len = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap();
                }
                if line == "\r\n" {
                    break;
                }
                head.push_str(&line);
            }
            let mut body = vec![0; len];
            reader.read_exact(&mut body).unwrap();
            let echo = format!("{head}\n{}", String::from_utf8_lossy(&body));
            write!(
                s,
                "HTTP/1.1 201 Created\r\nContent-Type: text/plain\r\nETag: \"v1\"\r\nX-Custom: yes\r\nContent-Length: {}\r\n\r\n{echo}",
                echo.len()
            )
            .unwrap();
        });
        format!("http://{addr}/")
    }

    #[test]
    fn proxy_forwards_method_headers_body_and_returns_headers() {
        let base = echo_server();
        let req = Request::builder()
            .method("POST")
            .uri("kestrel://localhost/api/notes?x=1")
            .header("Content-Type", "application/json")
            .header("X-Token", "abc")
            .body(br#"{"text":"hi"}"#.to_vec())
            .unwrap();
        let r = proxy(&base, &req);
        assert_eq!(r.status(), 201);
        assert_eq!(header(&r, "etag"), "\"v1\"");
        assert_eq!(header(&r, "x-custom"), "yes");
        let echoed = String::from_utf8(r.body().clone()).unwrap();
        assert!(
            echoed.starts_with("POST /api/notes?x=1 HTTP/1.1"),
            "{echoed}"
        );
        assert!(
            echoed.to_ascii_lowercase().contains("x-token: abc"),
            "{echoed}"
        );
        assert!(echoed.ends_with(r#"{"text":"hi"}"#), "{echoed}");
    }

    #[test]
    fn proxy_reports_unreachable_dev_server() {
        let req = Request::builder()
            .uri("kestrel://localhost/")
            .body(Vec::new())
            .unwrap();
        let r = proxy("http://127.0.0.1:1/", &req);
        assert_eq!(r.status(), 502);
    }
}
