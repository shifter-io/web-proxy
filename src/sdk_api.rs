use crate::{
    State, captcha,
    config::{COUNTRIES, Integration, random_id, valid_country},
    store::{Session, Store},
};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State as AppState, rejection::JsonRejection},
    http::{
        HeaderMap, HeaderValue, Method, StatusCode,
        header::{AUTHORIZATION, CONTENT_TYPE},
    },
    response::{IntoResponse, Response},
    routing::{get, post},
};
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const IDENTITY_TTL: u64 = 30 * 86400;
type Result<T> = std::result::Result<T, Error>;
pub struct Error(StatusCode, &'static str, &'static str);
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"code": self.1, "error": self.2}))).into_response()
    }
}
fn storage(_: impl std::fmt::Display) -> Error {
    Error(
        StatusCode::SERVICE_UNAVAILABLE,
        "STORAGE_UNAVAILABLE",
        "Session storage unavailable",
    )
}
fn unauthorized() -> Error {
    Error(
        StatusCode::UNAUTHORIZED,
        "AUTH_REQUIRED",
        "Start a browsing session",
    )
}
fn bad_input(_: JsonRejection) -> Error {
    Error(
        StatusCode::UNPROCESSABLE_ENTITY,
        "INVALID_INPUT",
        "Invalid request body",
    )
}
fn integration<'a>(h: &HeaderMap, s: &'a State) -> Result<&'a Integration> {
    let origin = h.get("origin").and_then(|h| h.to_str().ok());
    // Browsers omit Origin on same-origin GETs. Require their Fetch Metadata signal
    // and an exact configured Host; cross-origin and mutating requests use Origin.
    let same_origin = origin.is_none()
        && h.get("sec-fetch-site").and_then(|h| h.to_str().ok()) == Some("same-origin");
    s.cfg
        .integrations
        .iter()
        .find(|i| {
            if origin == Some(i.origin.as_str()) {
                return true;
            }
            if !same_origin {
                return false;
            }
            let parsed = url::Url::parse(&i.origin).unwrap();
            let host = &i.origin[parsed.scheme().len() + 3..];
            h.get("host").and_then(|h| h.to_str().ok()) == Some(host)
        })
        .ok_or(Error(
            StatusCode::FORBIDDEN,
            "ORIGIN_DENIED",
            "This website is not allowed",
        ))
}

fn digest(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
#[derive(Serialize, Deserialize)]
struct Identity {
    site: String,
    visitor: String,
}
fn bearer(h: &HeaderMap) -> Result<Option<&str>> {
    let Some(h) = h.get(AUTHORIZATION) else {
        return Ok(None);
    };
    let token = h
        .to_str()
        .ok()
        .and_then(|h| h.strip_prefix("Bearer "))
        .ok_or_else(unauthorized)?;
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(unauthorized());
    }
    Ok(Some(token))
}
async fn identity(h: &HeaderMap, s: &State, site: &str) -> Result<Option<(String, Identity)>> {
    let Some(token) = bearer(h)? else {
        return Ok(None);
    };
    let key = format!("identity:{}", digest(token));
    let value: Option<String> = s.store.db.clone().get(&key).await.map_err(storage)?;
    let identity: Identity =
        serde_json::from_str(&value.ok_or_else(unauthorized)?).map_err(storage)?;
    if identity.site != site {
        return Err(unauthorized());
    }
    Ok(Some((key, identity)))
}
async fn session(h: &HeaderMap, s: &State) -> Result<Session> {
    let site = &integration(h, s)?.site;
    let (_, id) = identity(h, s, site).await?.ok_or_else(unauthorized)?;
    s.store
        .get(&Store::key(&format!("{}:{}", id.site, id.visitor)))
        .await
        .map_err(storage)?
        .ok_or(Error(
            StatusCode::NOT_FOUND,
            "NO_SESSION",
            "No browsing session",
        ))
}
fn active(s: &Session) -> Result<()> {
    if !s.active() {
        return Err(Error(
            StatusCode::GONE,
            "SESSION_ENDED",
            "Browsing session ended",
        ));
    }
    Ok(())
}
fn public(s: &Session) -> Value {
    let mut v = s.public();
    v.as_object_mut().unwrap().remove("developmentIdentity");
    v
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Start {
    country: String,
    captcha_token: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Selection {
    country: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Recovery {
    revision: u64,
    url: String,
    reason: String,
}
fn country(value: &str) -> Result<()> {
    if !valid_country(value) {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "INVALID_COUNTRY",
            "Select an available country",
        ));
    }
    Ok(())
}

pub fn router(s: &State) -> Router<State> {
    let origins: Vec<HeaderValue> = s
        .cfg
        .integrations
        .iter()
        .map(|i| i.origin.parse().unwrap())
        .collect();
    let cors = tower_http::cors::CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([Method::GET, Method::POST, Method::DELETE])
        .allow_headers([AUTHORIZATION, CONTENT_TYPE]);
    Router::new()
        .route("/api/v1/config", get(config))
        .route("/api/v1/sessions", post(start))
        .route("/api/v1/session", get(current).delete(stop))
        .route("/api/v1/session/tickets", post(ticket))
        .route("/api/v1/session/reconnect", post(reconnect))
        .route("/api/v1/session/recover", post(recover))
        .route("/api/v1/session/country", post(change))
        .layer(DefaultBodyLimit::max(16 * 1024))
        .layer(cors)
}
async fn config(AppState(s): AppState<State>, h: HeaderMap) -> Result<Json<Value>> {
    let site = integration(&h, &s)?;
    Ok(Json(
        json!({"site":site.site, "countries":COUNTRIES.iter().map(|(code,name)|json!({"code":code,"name":name})).collect::<Vec<_>>(),
        "runtimeOrigin":s.cfg.runtime_origin,"captchaSiteKey":s.cfg.captcha_site_key,"protocolVersion":1}),
    ))
}
async fn start(
    AppState(s): AppState<State>,
    h: HeaderMap,
    input: std::result::Result<Json<Start>, JsonRejection>,
) -> Result<Json<Value>> {
    let site = integration(&h, &s)?;
    let Json(input) = input.map_err(bad_input)?;
    country(&input.country)?;
    if input.captcha_token.is_empty() || input.captcha_token.len() > 8192 {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "CAPTCHA_REQUIRED",
            "Complete the verification challenge",
        ));
    }
    let existing = identity(&h, &s, &site.site).await?;
    let hostname = url::Url::parse(&site.origin)
        .unwrap()
        .host_str()
        .unwrap()
        .to_owned();
    // Reserve the hash before verification to prevent concurrent/replayed use across replicas.
    // No raw CAPTCHA responses are persisted.
    let token_key = format!("captcha:{}", digest(&input.captcha_token));
    let reserved: Option<String> = redis::cmd("SET")
        .arg(&token_key)
        .arg("1")
        .arg("NX")
        .arg("EX")
        .arg(180)
        .query_async(&mut s.store.db.clone())
        .await
        .map_err(storage)?;
    if reserved.is_none() {
        return Err(Error(
            StatusCode::FORBIDDEN,
            "CAPTCHA_REJECTED",
            "Verification expired or already used; try again",
        ));
    }
    // Test tokens are random, one-use records installed directly in private Redis by tests.
    // This branch cannot be activated in production or development.
    let verified = if s.cfg.test_mode {
        let expected: Option<String> = redis::cmd("GETDEL")
            .arg(format!("test-captcha:{}", digest(&input.captcha_token)))
            .query_async(&mut s.store.db.clone())
            .await
            .map_err(storage)?;
        expected.as_deref() == Some(hostname.as_str())
    } else {
        captcha::verify(&s, &input.captcha_token, &hostname)
            .await
            .map_err(|_| {
                Error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "CAPTCHA_UNAVAILABLE",
                    "Verification unavailable; please try again",
                )
            })?
    };
    if !verified {
        return Err(Error(
            StatusCode::FORBIDDEN,
            "CAPTCHA_REJECTED",
            "Verification failed; please try again",
        ));
    }
    let (key, id, credential) = match existing {
        Some((key, id)) => (key, id, None),
        None => {
            let token = format!("{}{}", random_id(), random_id());
            (
                format!("identity:{}", digest(&token)),
                Identity {
                    site: site.site.clone(),
                    visitor: random_id(),
                },
                Some(token),
            )
        }
    };
    let current = s
        .store
        .start(
            &format!("{}:{}", id.site, id.visitor),
            &input.country,
            &s.cfg,
        )
        .await
        .map_err(storage)?;
    // Refresh only after successful verification; keep the visitor ID and its existing budget.
    let _: () = s
        .store
        .db
        .clone()
        .set_ex(
            key,
            serde_json::to_string(&id).map_err(storage)?,
            IDENTITY_TTL,
        )
        .await
        .map_err(storage)?;
    Ok(Json(
        json!({"session":public(&current),"credential":credential}),
    ))
}
async fn current(AppState(s): AppState<State>, h: HeaderMap) -> Result<Json<Value>> {
    Ok(Json(public(&session(&h, &s).await?)))
}
async fn ticket(AppState(s): AppState<State>, h: HeaderMap) -> Result<Json<Value>> {
    let current = session(&h, &s).await?;
    active(&current)?;
    Ok(Json(
        json!({"ticket":s.store.ticket(&current).await.map_err(storage)?,"revision":current.revision,"expiresIn":30,"runtimeOrigin":s.cfg.runtime_origin}),
    ))
}
async fn reconnect(AppState(s): AppState<State>, h: HeaderMap) -> Result<Json<Value>> {
    let current = session(&h, &s).await?;
    active(&current)?;
    s.store.reconnect(&current).await.map_err(storage)?;
    Ok(Json(json!({"status":"reconnecting"})))
}
async fn recover(
    AppState(s): AppState<State>,
    h: HeaderMap,
    input: std::result::Result<Json<Recovery>, JsonRejection>,
) -> Result<Json<Value>> {
    let current = session(&h, &s).await?;
    active(&current)?;
    let Json(input) = input.map_err(bad_input)?;
    let url = url::Url::parse(&input.url).ok().filter(|u| {
        matches!(u.scheme(), "http" | "https")
            && u.host_str().is_some()
            && u.username().is_empty()
            && u.password().is_none()
            && matches!(u.port_or_known_default(), Some(80 | 443))
    });
    let Some(url) = url else {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "INVALID_INPUT",
            "Invalid recovery request",
        ));
    };
    if !matches!(input.reason.as_str(), "websocket" | "upstream") {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "INVALID_INPUT",
            "Invalid recovery request",
        ));
    }
    if !s
        .store
        .recover(
            &current,
            input.revision,
            url.host_str().unwrap(),
            input.reason == "upstream",
        )
        .await
        .map_err(storage)?
    {
        return Err(Error(
            StatusCode::CONFLICT,
            "RECOVERY_UNAVAILABLE",
            "The connection could not be restored. Please try again.",
        ));
    }
    Ok(Json(json!({"status":"reconnecting","retryAfterMs":6500})))
}
async fn change(
    AppState(s): AppState<State>,
    h: HeaderMap,
    input: std::result::Result<Json<Selection>, JsonRejection>,
) -> Result<Json<Value>> {
    let current = session(&h, &s).await?;
    active(&current)?;
    let Json(input) = input.map_err(bad_input)?;
    country(&input.country)?;
    s.store
        .change(&current, Some(&input.country))
        .await
        .map_err(storage)?;
    Ok(Json(public(&session(&h, &s).await?)))
}
async fn stop(AppState(s): AppState<State>, h: HeaderMap) -> Result<Json<Value>> {
    let current = session(&h, &s).await?;
    s.store.change(&current, None).await.map_err(storage)?;
    Ok(Json(json!({"status":"stopped"})))
}
