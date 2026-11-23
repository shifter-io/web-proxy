//! Server-side CAPTCHA verification: Google reCAPTCHA, or self-hosted Cap
//! (CAPTCHA_PROVIDER=cap, one site key per embedding origin).
use crate::{State, captcha_config::CapConfig, config::now_ms};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct Verification {
    pub success: bool,
    pub hostname: Option<String>,
    pub challenge_ts: Option<String>,
    #[serde(rename = "error-codes", default)]
    pub errors: Vec<String>,
}

pub fn valid(result: &Verification, hostname: &str, now: u64) -> bool {
    let timestamp = result
        .challenge_ts
        .as_deref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.timestamp_millis());
    result.success
        && result.errors.is_empty()
        && result.hostname.as_deref() == Some(hostname)
        && timestamp.is_some_and(|t| t >= 0 && t as u64 <= now + 5000)
}

pub async fn verify(state: &State, token: &str, hostname: &str) -> Result<bool, ()> {
    let settings = &state.cfg.captcha;
    if settings.secret.is_empty() {
        return Err(());
    }
    if settings.cap_staging {
        // The pilot's isolated Compose network is the only Cap verifier target.
        let site = Site {
            base: "http://capd:3000",
            key: &settings.site_key,
            secret: &settings.secret,
        };
        return cap_siteverify(&state.captcha_client, &site, token).await;
    }
    let response = state
        .captcha_client
        .post("https://www.google.com/recaptcha/api/siteverify")
        .form(&[("secret", settings.secret.as_str()), ("response", token)])
        .send()
        .await
        .map_err(|_| ())?;
    if !response.status().is_success() {
        return Err(());
    }
    let result: Verification = response.json().await.map_err(|_| ())?;
    Ok(valid(&result, hostname, now_ms()))
}

enum Verifier<'a> {
    Cap(&'a CapConfig),
    Legacy,
}

fn verifier<'a>(cap: Option<&'a CapConfig>, accept_both: bool, token: &str) -> Verifier<'a> {
    match cap {
        // Cap carries a colon-delimited site key, challenge and answer. Never
        // fall back to another verifier after rejection or a transport error.
        Some(cap) if !accept_both || token.contains(':') => Verifier::Cap(cap),
        _ => Verifier::Legacy,
    }
}

pub async fn verify_for_integration(
    state: &State,
    token: &str,
    hostname: &str,
    integration_origin: &str,
) -> Result<bool, ()> {
    let settings = &state.cfg.captcha;
    match verifier(settings.cap.as_ref(), settings.accept_both, token) {
        Verifier::Cap(cap) => {
            verify_cap(&state.captcha_client, cap, token, integration_origin).await
        }
        Verifier::Legacy => verify(state, token, hostname).await,
    }
}

/// Use the Cap key for the matched integration, not one supplied by the browser.
async fn verify_cap(
    client: &reqwest::Client,
    cap: &CapConfig,
    token: &str,
    integration_origin: &str,
) -> Result<bool, ()> {
    let Some(site) = cap.site(integration_origin) else {
        return Err(());
    };
    let site = Site {
        base: &cap.verify_url,
        key: &site.site_key,
        secret: &site.secret,
    };
    cap_siteverify(client, &site, token).await
}

/// One Cap site as the verifier sees it: its base URL, key and secret.
struct Site<'a> {
    base: &'a str,
    key: &'a str,
    secret: &'a str,
}

/// 200 with `success` decides; 400, 403 and 404 reject; anything else is unavailable.
async fn cap_siteverify(
    client: &reqwest::Client,
    site: &Site<'_>,
    token: &str,
) -> Result<bool, ()> {
    if site.secret.is_empty() {
        return Err(());
    }
    if !cap_site_matches(token, site.key) {
        return Ok(false);
    }
    let response = client
        .post(format!("{}/{}/siteverify", site.base, site.key))
        .json(&serde_json::json!({"secret": site.secret, "response": token}))
        .send()
        .await
        .map_err(|_| ())?;
    match response.status().as_u16() {
        200 => response
            .json::<CapVerification>()
            .await
            .map(|result| result.success)
            .map_err(|_| ()),
        400 | 403 | 404 => Ok(false),
        _ => Err(()),
    }
}

#[derive(Deserialize)]
struct CapVerification {
    success: bool,
}

fn cap_site_matches(token: &str, site_key: &str) -> bool {
    let mut parts = token.split(':');
    parts.next() == Some(site_key)
        && parts.next().is_some_and(|part| !part.is_empty())
        && parts.next().is_some_and(|part| !part.is_empty())
        && parts.next().is_none()
}

#[cfg(test)]
#[path = "captcha_tests.rs"]
mod tests;
