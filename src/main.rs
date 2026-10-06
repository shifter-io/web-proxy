mod api;
mod config;
mod relay;
mod store;

use anyhow::Result;
use axum::http::{HeaderName, HeaderValue};
use axum::{Router, routing::get};
use config::Config;
use std::sync::{Arc, atomic::AtomicU64};
use store::Store;
use tower_http::{services::ServeDir, set_header::SetResponseHeaderLayer};

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
}
pub type State = Arc<App>;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("shifter_web=info")
        .init();
    let cfg = Config::load().await?;
    let store = Store::new(&cfg.redis).await?;
    let state = Arc::new(App {
        cfg,
        store,
        metrics: Metrics::default(),
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
            .fallback_service(ServeDir::new(format!("{}/runtime", state.cfg.web_dir)))
            .with_state(state.clone())
    };
    let app = app
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("cross-origin-opener-policy"),
            HeaderValue::from_static("same-origin"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("cross-origin-embedder-policy"),
            HeaderValue::from_static("require-corp"),
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
        ))
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("cache-control"),
            HeaderValue::from_static("no-store"),
        ));
    let listener = tokio::net::TcpListener::bind(&state.cfg.listen).await?;
    tracing::info!(role=%state.cfg.role,replica=%state.cfg.replica,"ready; local development identity only");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
