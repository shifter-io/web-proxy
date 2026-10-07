mod api;
mod captcha;
mod config;
mod dns;
mod public_assets;
mod relay;
mod sdk_api;
mod store;

use anyhow::Result;
use axum::http::{HeaderName, HeaderValue};
use axum::{Router, routing::get};
use config::Config;
use std::sync::{Arc, atomic::AtomicU64};
use store::Store;
use tower_http::set_header::SetResponseHeaderLayer;

#[derive(Default)]
pub struct Metrics {
    pub connections: AtomicU64,
    pub streams: AtomicU64,
    pub accepted: AtomicU64,
    pub rejected: AtomicU64,
    pub bytes_up: AtomicU64,
    pub bytes_down: AtomicU64,
}
pub struct App {
    pub cfg: Config,
    pub store: Store,
    pub metrics: Metrics,
    pub resolver: dns::Resolver,
    pub captcha_client: reqwest::Client,
}
pub type State = Arc<App>;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "shifter_web=info".into()),
        )
        .init();
    let cfg = Config::load().await?;
    let store = Store::new(&cfg.redis, cfg.redis_ca_file.as_deref()).await?;
    let state = Arc::new(App {
        cfg,
        store,
        metrics: Metrics::default(),
        resolver: dns::Resolver::default(),
        captcha_client: reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(8))
            .redirect(reqwest::redirect::Policy::none())
            .build()?,
    });
    let app = if state.cfg.role == "api" {
        api::router(state.clone())
    } else {
        Router::new()
            .route("/wisp/", get(relay::upgrade))
            .route("/wisp/{ticket}/", get(relay::upgrade_path))
            .route("/settings", get(api::runtime_settings))
            .route("/health", get(api::health))
            .route("/metrics", get(api::metrics))
            .fallback_service(public_assets::router(
                format!("{}/runtime", state.cfg.web_dir),
                public_assets::Kind::Runtime,
            ))
            .with_state(state.clone())
    };
    let app = app
        .nest_service(
            "/sdk",
            public_assets::router(
                format!("{}/sdk", state.cfg.web_dir),
                public_assets::Kind::Sdk,
            ),
        )
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            asset_headers,
        ))
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("cross-origin-resource-policy"),
            HeaderValue::from_static("cross-origin"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("referrer-policy"),
            HeaderValue::from_static("no-referrer"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("x-content-type-options"),
            HeaderValue::from_static("nosniff"),
        ));
    let listener = tokio::net::TcpListener::bind(&state.cfg.listen).await?;
    if state.cfg.test_mode {
        tracing::warn!("synthetic test mode: legacy cookie API enabled");
    }
    tracing::info!(role=%state.cfg.role,replica=%state.cfg.replica,"ready");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

async fn asset_headers(
    axum::extract::State(state): axum::extract::State<State>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let path = request.uri().path().to_owned();
    let mut response = next.run(request).await;
    let cache = if !response.status().is_success() {
        "no-store"
    } else if path.starts_with("/sdk/releases/") {
        "public, max-age=31536000, immutable"
    } else if path.starts_with("/sdk/v1/") {
        "public, no-cache"
    } else {
        "no-store"
    };
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static(cache));
    if path.starts_with("/sdk/") {
        response
            .headers_mut()
            .insert("access-control-allow-origin", HeaderValue::from_static("*"));
    }
    let ancestors = format!(
        "frame-ancestors 'self' {}",
        state
            .cfg
            .integrations
            .iter()
            .map(|i| i.origin.as_str())
            .collect::<Vec<_>>()
            .join(" ")
    );
    response.headers_mut().insert(
        "content-security-policy",
        HeaderValue::from_str(&ancestors).unwrap(),
    );
    response
}
