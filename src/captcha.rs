//! Production keeps server-side Google verification. Cap is a staging-only pilot.
use crate::{State, config::now_ms};
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
    if state.cfg.captcha_secret.is_empty() {
        return Err(());
    }
    if state.cfg.cap_staging {
        let site_key = &state.cfg.captcha_site_key;
        if !cap_site_matches(token, site_key) {
            return Ok(false);
        }
        // The pilot's isolated Compose network is the only Cap verifier target.
        let response = state
            .captcha_client
            .post(format!("http://capd:3000/{site_key}/siteverify"))
            .json(&serde_json::json!({
                "secret": state.cfg.captcha_secret,
                "response": token,
            }))
            .send()
            .await
            .map_err(|_| ())?;
        return match response.status().as_u16() {
            200 => response
                .json::<CapVerification>()
                .await
                .map(|result| result.success)
                .map_err(|_| ()),
            400 | 403 | 404 => Ok(false),
            _ => Err(()),
        };
    }
    let response = state
        .captcha_client
        .post("https://www.google.com/recaptcha/api/siteverify")
        .form(&[
            ("secret", state.cfg.captcha_secret.as_str()),
            ("response", token),
        ])
        .send()
        .await
        .map_err(|_| ())?;
    if !response.status().is_success() {
        return Err(());
    }
    let result: Verification = response.json().await.map_err(|_| ())?;
    Ok(valid(&result, hostname, now_ms()))
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
mod tests {
    use super::*;

    #[test]
    fn cap_requires_the_expected_site_key_and_token_shape() {
        assert!(cap_site_matches("pilot:challenge:answer", "pilot"));
        for token in [
            "other:challenge:answer",
            "pilot::answer",
            "pilot:answer",
            "pilot:x:y:z",
        ] {
            assert!(!cap_site_matches(token, "pilot"));
        }
    }
    #[test]
    fn verifier_rejects_expiry_hostname_failure_and_quota_errors() {
        let now = 1_700_000_000_000;
        let mut v = Verification {
            success: true,
            hostname: Some("example.com".into()),
            challenge_ts: Some("2023-11-14T22:13:00Z".into()),
            errors: vec![],
        };
        assert!(valid(&v, "example.com", now));
        assert!(!valid(&v, "second.example.com", now));
        // challenge_ts is widget load time, not response issuance. Google enforces
        // the response's two-minute lifetime; slow human challenges remain valid.
        assert!(valid(&v, "example.com", now + 121_000));
        v.errors.push("timeout-or-duplicate".into());
        assert!(!valid(&v, "example.com", now));
        v.errors.clear();
        v.errors.push("Over free quota.".into());
        assert!(!valid(&v, "example.com", now));
        v.errors.clear();
        v.success = false;
        assert!(!valid(&v, "example.com", now));
        v.success = true;
        v.challenge_ts = None;
        assert!(!valid(&v, "example.com", now));
    }
}
