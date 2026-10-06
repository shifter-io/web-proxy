use crate::{
    State,
    config::{COUNTRIES, is_id, random_id, valid_country},
    store::{Session, Store},
};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State as AxumState},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::atomic::Ordering;

pub struct ApiError(pub StatusCode, pub &'static str);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
fn storage_error(_: anyhow::Error) -> ApiError {
    ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        "Session storage unavailable",
    )
}
fn check_origin(headers: &HeaderMap, state: &State) -> Result<(), ApiError> {
    if headers.get("origin").and_then(|x| x.to_str().ok())
        != Some(state.cfg.control_origin.as_str())
    {
        return Err(ApiError(StatusCode::FORBIDDEN, "Invalid request origin"));
    }
    Ok(())
}
fn visitor(headers: &HeaderMap) -> Option<String> {
    headers
        .get("cookie")?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|p| {
            let (name, value) = p.trim().split_once('=')?;
            (name == "shifter_dev" && is_id(value)).then(|| value.to_string())
        })
}
async fn session(headers: &HeaderMap, state: &State) -> Result<Session, ApiError> {
    let v = visitor(headers).ok_or(ApiError(
        StatusCode::UNAUTHORIZED,
        "Start a browsing session",
    ))?;
    state
        .store
        .get(&Store::key(&v))
        .await
        .map_err(storage_error)?
        .ok_or(ApiError(StatusCode::NOT_FOUND, "No browsing session"))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Selection {
    country: String,
}
fn country(s: &Selection) -> Result<(), ApiError> {
    if !valid_country(&s.country) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Select an available country",
        ));
    }
    Ok(())
}
pub fn router(state: State) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/metrics", get(metrics))
        .route("/api/countries", get(countries))
        .route("/api/sessions", post(start))
        .route("/api/session", get(current).delete(stop))
        .route("/api/session/tickets", post(ticket))
        .route("/api/session/reconnect", post(reconnect))
        .route("/api/session/country", post(change))
        .layer(DefaultBodyLimit::max(1024))
        .fallback_service(tower_http::services::ServeDir::new(format!(
            "{}/control",
            state.cfg.web_dir
        )))
        .with_state(state)
}
pub async fn health(AxumState(state): AxumState<State>) -> Response {
    let result: redis::RedisResult<String> = redis::cmd("PING")
        .query_async(&mut state.store.db.clone())
        .await;
    if result.is_ok() {
        (
            StatusCode::OK,
            Json(json!({"ok":true,"replica":state.cfg.replica})),
        )
            .into_response()
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, "unavailable").into_response()
    }
}
pub async fn runtime_settings(AxumState(s): AxumState<State>) -> Json<Value> {
    Json(json!({"controlOrigin":s.cfg.control_origin}))
}
pub async fn metrics(AxumState(s): AxumState<State>) -> Json<Value> {
    let m = &s.metrics;
    Json(
        json!({"replica":s.cfg.replica,"connections":m.connections.load(Ordering::Relaxed),
        "streams":m.streams.load(Ordering::Relaxed),"accepted":m.accepted.load(Ordering::Relaxed),
        "rejected":m.rejected.load(Ordering::Relaxed),"bytesUp":m.bytes_up.load(Ordering::Relaxed),
        "bytesDown":m.bytes_down.load(Ordering::Relaxed)}),
    )
}
async fn countries(AxumState(s): AxumState<State>) -> Json<Value> {
    Json(
        json!({"countries":COUNTRIES.iter().map(|(code,name)|json!({"code":code,"name":name})).collect::<Vec<_>>(),
        "runtimeOrigin":s.cfg.runtime_origin,"developmentIdentity":true,"testMode":s.cfg.test_mode}),
    )
}
async fn start(
    AxumState(s): AxumState<State>,
    headers: HeaderMap,
    Json(input): Json<Selection>,
) -> Result<Response, ApiError> {
    check_origin(&headers, &s)?;
    country(&input)?;
    let v = visitor(&headers).unwrap_or_else(random_id);
    let session = s
        .store
        .start(&v, &input.country, &s.cfg)
        .await
        .map_err(storage_error)?;
    let mut response = Json(session.public()).into_response();
    response.headers_mut().insert(
        "set-cookie",
        HeaderValue::from_str(&format!(
            "shifter_dev={v}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=172800"
        ))
        .unwrap(),
    );
    Ok(response)
}
async fn current(
    AxumState(s): AxumState<State>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(session(&headers, &s).await?.public()))
}
async fn ticket(
    AxumState(s): AxumState<State>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    check_origin(&headers, &s)?;
    let session = session(&headers, &s).await?;
    if !session.active() {
        return Err(ApiError(StatusCode::GONE, "Daily browsing allowance ended"));
    }
    let ticket = s.store.ticket(&session).await.map_err(storage_error)?;
    Ok(Json(
        json!({"ticket":ticket,"expiresIn":30,"runtimeOrigin":s.cfg.runtime_origin}),
    ))
}
async fn reconnect(
    AxumState(s): AxumState<State>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    check_origin(&headers, &s)?;
    let session = session(&headers, &s).await?;
    if !session.active() {
        return Err(ApiError(StatusCode::GONE, "Daily browsing allowance ended"));
    }
    s.store.reconnect(&session).await.map_err(storage_error)?;
    Ok(Json(json!({"status":"reconnecting"})))
}
async fn change(
    AxumState(s): AxumState<State>,
    headers: HeaderMap,
    Json(input): Json<Selection>,
) -> Result<Json<Value>, ApiError> {
    check_origin(&headers, &s)?;
    country(&input)?;
    let session = session(&headers, &s).await?;
    if !session.active() {
        return Err(ApiError(StatusCode::GONE, "Daily browsing allowance ended"));
    }
    s.store
        .change(&session, Some(&input.country))
        .await
        .map_err(storage_error)?;
    Ok(Json(
        s.store
            .get(&session.key)
            .await
            .map_err(storage_error)?
            .unwrap()
            .public(),
    ))
}
async fn stop(AxumState(s): AxumState<State>, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    check_origin(&headers, &s)?;
    let session = session(&headers, &s).await?;
    s.store
        .change(&session, None)
        .await
        .map_err(storage_error)?;
    Ok(Json(json!({"status":"stopped"})))
}
