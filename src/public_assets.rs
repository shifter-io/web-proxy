//! Only deliberately published browser assets may reach a static file server.
use axum::{
    Router,
    extract::{Request, State},
    http::{Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use std::{path::PathBuf, sync::Arc};
use tower_http::services::ServeDir;

#[derive(Clone, Copy)]
pub enum Kind {
    Control,
    Runtime,
    Sdk,
}

struct Assets {
    root: PathBuf,
    kind: Kind,
}

pub fn router(root: impl Into<PathBuf>, kind: Kind) -> Router {
    let root = root.into();
    Router::new()
        .fallback_service(ServeDir::new(&root))
        .layer(middleware::from_fn_with_state(
            Arc::new(Assets { root, kind }),
            guard,
        ))
}

fn public_path(kind: Kind, path: &str) -> Option<&str> {
    // Match the raw URI before ServeDir decodes it. No encoded aliases, traversal,
    // backslashes, hidden files, directory indexes, or backup suffixes are public.
    let file = match path {
        "/" => "index.html",
        _ => path.strip_prefix('/')?,
    };
    let allowed = match kind {
        Kind::Control => {
            matches!(
                file,
                "index.html"
                    | "minimal.html"
                    | "app.js"
                    | "base.css"
                    | "style.css"
                    | "country-order.js"
                    | "country-orbits.js"
                    | "country-marquee.js"
                    | "country-picker.js"
                    | "page-loading.js"
                    | "shifter-reveal.js"
                    | "assets/favicon.svg"
                    | "assets/shifter-logo.svg"
                    | "assets/geist-latin.woff2"
                    | "assets/geist-OFL.txt"
            ) || file
                .strip_prefix("assets/flags/")
                .and_then(|s| s.strip_suffix(".svg"))
                .is_some_and(|s| s.len() == 2 && s.bytes().all(|b| b.is_ascii_lowercase()))
        }
        Kind::Runtime => matches!(
            file,
            "index.html"
                | "runtime.js"
                | "runtime-data.js"
                | "public-suffix-list.dat"
                | "bridge.js"
                | "sw.js"
                | "transport-compat.js"
                | "reset.html"
                | "reset.js"
                | "vendor/scram/scramjet.all.js"
                | "vendor/scram/scramjet.sync.js"
                | "vendor/scram/scramjet.wasm.wasm"
                | "vendor/baremux/index.js"
                | "vendor/baremux/index.mjs"
                | "vendor/baremux/worker.js"
                | "vendor/libcurl/index.mjs"
        ),
        Kind::Sdk => {
            file == "v1/shifter-web-proxy.js"
                || file
                    .strip_prefix("releases/")
                    .and_then(|s| s.split_once('/'))
                    .is_some_and(|(version, asset)| {
                        let parts: Vec<_> = version.split('.').collect();
                        parts.len() == 3
                            && parts
                                .iter()
                                .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
                            && matches!(asset, "client.js" | "captcha.js" | "manifest.json")
                    })
        }
    };
    allowed.then_some(file)
}

async fn guard(State(assets): State<Arc<Assets>>, request: Request, next: Next) -> Response {
    if !matches!(*request.method(), Method::GET | Method::HEAD) {
        return not_found();
    }
    let Some(file) = public_path(assets.kind, request.uri().path()) else {
        return not_found();
    };
    // Refuse symlinks, including directory links, even at an allowed public name.
    // Deployment serves a read-only image tree; secret mounts live outside it.
    match tokio::fs::symlink_metadata(&assets.root).await {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
        _ => return not_found(),
    }
    let mut path = assets.root.clone();
    let mut components = file.split('/').peekable();
    while let Some(component) = components.next() {
        path.push(component);
        match tokio::fs::symlink_metadata(&path).await {
            Ok(meta)
                if !meta.file_type().is_symlink()
                    && if components.peek().is_some() {
                        meta.is_dir()
                    } else {
                        meta.is_file()
                    } => {}
            _ => return not_found(),
        }
    }
    next.run(request).await
}

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        [("cache-control", "no-store")],
        "Not found",
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{Body, to_bytes};
    use tower::ServiceExt;

    #[tokio::test]
    async fn only_public_assets_are_readable_even_with_secrets_in_the_web_tree() {
        let dir = std::env::temp_dir().join(format!("asset-security-{}", rand::random::<u64>()));
        tokio::fs::create_dir_all(dir.join("sdk/releases/1.0.0"))
            .await
            .unwrap();
        tokio::fs::create_dir_all(dir.join("control/.secrets"))
            .await
            .unwrap();
        for file in [
            "control/index.html",
            "control/app.js",
            "control/.env.captcha",
            "control/.secrets/key",
            "control/app.js.bak",
            "control/credentials.json",
            "sdk/releases/1.0.0/client.js",
            "sdk/releases/1.0.0/.env",
        ] {
            tokio::fs::write(dir.join(file), b"fixture").await.unwrap();
        }
        let app = Router::new()
            .nest_service("/sdk", router(dir.join("sdk"), Kind::Sdk))
            .fallback_service(router(dir.join("control"), Kind::Control));
        tokio::fs::create_dir_all(dir.join("control/base.css"))
            .await
            .unwrap();
        tokio::fs::write(dir.join("control/base.css/index.html"), b"fixture")
            .await
            .unwrap();
        for path in [
            "/",
            "/index.html",
            "/app.js?cache=1",
            "/sdk/releases/1.0.0/client.js",
        ] {
            for method in [Method::GET, Method::HEAD] {
                let response = app
                    .clone()
                    .oneshot(
                        Request::builder()
                            .method(method)
                            .uri(path)
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::OK, "{path}");
            }
        }
        for path in [
            "/base.css",
            "/.env.captcha",
            "/.secrets/key",
            "/app.js.bak",
            "/credentials.json",
            "/%2eenv.captcha",
            "/%252eenv.captcha",
            "/../.env",
            "/%2e%2e/.env",
            "/app.js/../.env.captcha",
            "/app.js%00",
            "//app.js",
            "/sdk/src/client.js",
            "/sdk/releases/1.0.0/.env",
            "/sdk/releases/1.0.0/../../src/client.js",
            "/sdk/releases/1.0.0/client.js.bak",
            "/sdk/releases/1.0.0%2fclient.js",
        ] {
            for method in [Method::GET, Method::HEAD] {
                let response = app
                    .clone()
                    .oneshot(
                        Request::builder()
                            .method(method)
                            .uri(path)
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
                assert!(
                    !to_bytes(response.into_body(), 1024)
                        .await
                        .unwrap()
                        .windows(7)
                        .any(|w| w == b"fixture")
                );
            }
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                dir.join("control/.env.captcha"),
                dir.join("control/style.css"),
            )
            .unwrap();
            std::os::unix::fs::symlink(
                dir.join("sdk/releases/1.0.0"),
                dir.join("sdk/releases/1.0.1"),
            )
            .unwrap();
            for path in ["/style.css", "/sdk/releases/1.0.1/client.js"] {
                let response = app
                    .clone()
                    .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
            }
        }
        tokio::fs::remove_dir_all(dir).await.unwrap();
    }
}
