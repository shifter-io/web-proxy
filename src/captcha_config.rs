//! CAPTCHA provider settings read at startup: Google reCAPTCHA, the self-hosted
//! Cap verifier (CAPTCHA_PROVIDER=cap), its development pilot (cap-staging), and
//! the dual-provider transition (CAPTCHA_ACCEPT_BOTH=true).
use crate::config::Integration;
use anyhow::{Context, Result, bail};
use serde::Deserialize;

/// The CAPTCHA part of `Config`.
#[derive(Clone, Default)]
pub struct CaptchaSettings {
    /// Public key sent to browsers: reCAPTCHA, or the Cap pilot key in cap-staging.
    pub site_key: String,
    /// Private secret for `site_key`; only the API process loads it.
    pub secret: String,
    pub cap_staging: bool,
    pub cap_preferred: bool,
    pub accept_both: bool,
    /// Cap verifier settings, also loaded during a dual-provider transition.
    pub cap: Option<CapConfig>,
}

/// One Cap site key per embedding origin, so a token solved for one website
/// cannot start a session on another (Cap tokens carry no hostname).
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CapSite {
    /// Exactly an INTEGRATIONS origin, wildcard patterns included.
    pub origin: String,
    pub site_key: String,
    pub secret: String,
}

#[derive(Clone)]
pub struct CapConfig {
    /// Private base URL the API calls for /<siteKey>/siteverify. Plain http is
    /// accepted because the verifier runs on the same private Compose network.
    pub verify_url: String,
    /// Public base URL browsers load the widget and challenges from.
    pub public_url: String,
    pub sites: Vec<CapSite>,
}

impl CapConfig {
    pub fn site(&self, integration_origin: &str) -> Option<&CapSite> {
        self.sites.iter().find(|s| s.origin == integration_origin)
    }
}

/// What the CAPTCHA settings depend on from the rest of the configuration.
pub struct Scope<'a> {
    pub environment: &'a str,
    pub role: &'a str,
    pub control_origin: &'a str,
    pub integrations: &'a [Integration],
}

/// Reads one environment variable; `None` when it is unset.
pub type Lookup<'a> = &'a dyn Fn(&str) -> Option<String>;

pub fn load(scope: &Scope, var: Lookup) -> Result<CaptchaSettings> {
    let get = |key: &str, default: &str| var(key).unwrap_or_else(|| default.into());
    let api = scope.role == "api";
    let (cap_staging, cap_preferred) = match get("CAPTCHA_PROVIDER", "recaptcha").as_str() {
        "recaptcha" => (false, false),
        "cap-staging" => (true, false),
        "cap" => (false, true),
        _ => bail!("unknown CAPTCHA_PROVIDER"),
    };
    if cap_staging && (scope.environment != "development" || !api) {
        bail!("Cap pilot is disabled outside a development API");
    }
    let accept_both = match get("CAPTCHA_ACCEPT_BOTH", "false").as_str() {
        "true" => true,
        "false" => false,
        _ => bail!("CAPTCHA_ACCEPT_BOTH must be true or false"),
    };
    if accept_both && (cap_staging || scope.environment == "test") {
        bail!("CAPTCHA_ACCEPT_BOTH requires a real CAPTCHA provider outside test mode");
    }
    let needs_recaptcha = !cap_preferred || accept_both;
    let (site_key, secret) = if needs_recaptcha {
        credentials(cap_staging, api, var)?
    } else {
        (String::new(), String::new())
    };
    let cap = if cap_preferred || accept_both {
        Some(load_cap(scope, var)?)
    } else {
        None
    };
    if cap_staging {
        validate_cap_staging(scope, &site_key, &secret)?;
    } else if api && needs_recaptcha {
        let strict = scope.environment == "production" || accept_both;
        validate_captcha(&site_key, &secret, strict)?;
    }
    Ok(CaptchaSettings {
        site_key,
        secret,
        cap_staging,
        cap_preferred,
        accept_both,
        cap,
    })
}

/// The reCAPTCHA (or Cap pilot) key and secret. Only the API process receives the secret.
fn credentials(cap_staging: bool, api: bool, var: Lookup) -> Result<(String, String)> {
    let (site_key_var, secret_file_var) = if cap_staging {
        ("CAP_STAGING_SITE_KEY", "CAP_STAGING_SECRET_FILE")
    } else {
        ("RECAPTCHA_SITE_KEY", "RECAPTCHA_SECRET_FILE")
    };
    let site_key = var(site_key_var).unwrap_or_default();
    let secret = match var(secret_file_var) {
        Some(path) if api && !path.is_empty() => std::fs::read_to_string(path)
            .map_err(|_| anyhow::anyhow!("cannot read {secret_file_var}"))?
            .trim()
            .to_owned(),
        _ => String::new(),
    };
    Ok((site_key, secret))
}

fn load_cap(scope: &Scope, var: Lookup) -> Result<CapConfig> {
    let api = scope.role == "api";
    // Site secrets come from a private file, only in the API process.
    let sites: Vec<CapSite> = if api {
        let path = var("CAP_SITES_FILE").context("Cap verification requires CAP_SITES_FILE")?;
        let text = std::fs::read_to_string(&path)
            .map_err(|_| anyhow::anyhow!("cannot read CAP_SITES_FILE"))?;
        serde_json::from_str(&text).map_err(|_| anyhow::anyhow!("invalid CAP_SITES_FILE JSON"))?
    } else {
        vec![]
    };
    let base = |key: &str, default: &str| {
        let value = var(key).unwrap_or_else(|| default.into());
        value.trim_end_matches('/').to_owned()
    };
    let cap = CapConfig {
        verify_url: base("CAP_VERIFY_URL", "http://capd:3000"),
        public_url: base("CAP_PUBLIC_URL", ""),
        sites,
    };
    if api {
        validate_cap(&cap, scope.integrations, scope.environment == "production")?;
    }
    Ok(cap)
}

fn valid_cap_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 64
        && key
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_".contains(&c))
}

pub fn validate_cap(cap: &CapConfig, entries: &[Integration], production: bool) -> Result<()> {
    let public = url::Url::parse(&cap.public_url)
        .map_err(|_| anyhow::anyhow!("CAP_PUBLIC_URL must be an absolute URL"))?;
    if !["http", "https"].contains(&public.scheme())
        || public.path() != "/"
        || public.query().is_some()
        || (production && public.scheme() != "https")
    {
        bail!("CAP_PUBLIC_URL must be a bare http(s) origin, HTTPS in production");
    }
    let verify = url::Url::parse(&cap.verify_url)
        .map_err(|_| anyhow::anyhow!("CAP_VERIFY_URL must be an absolute URL"))?;
    if !["http", "https"].contains(&verify.scheme()) {
        bail!("CAP_VERIFY_URL must be http(s)");
    }
    for entry in entries {
        if cap.site(&entry.origin).is_none() {
            bail!("CAP_SITES_FILE has no site key for {}", entry.origin);
        }
    }
    let mut keys = std::collections::HashSet::new();
    for site in &cap.sites {
        if !valid_cap_key(&site.site_key) || site.secret.is_empty() {
            bail!("every CAP_SITES_FILE entry needs a valid siteKey and a secret");
        }
        if !entries.iter().any(|e| e.origin == site.origin) {
            bail!(
                "CAP_SITES_FILE origin {} is not in INTEGRATIONS",
                site.origin
            );
        }
        if !keys.insert(site.site_key.as_str()) {
            bail!("each origin needs its own Cap site key");
        }
    }
    Ok(())
}

pub fn validate_captcha(site_key: &str, secret: &str, production: bool) -> Result<()> {
    const TEST_SITE: &str = "6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI";
    const TEST_SECRET: &str = "6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe";
    if production
        && (site_key.is_empty()
            || secret.is_empty()
            || site_key == TEST_SITE
            || secret == TEST_SECRET)
    {
        bail!("production API requires real reCAPTCHA v2 credentials");
    }
    Ok(())
}

fn validate_cap_staging(scope: &Scope, site_key: &str, secret: &str) -> Result<()> {
    let control = scope.control_origin;
    if scope.environment != "development"
        || scope.role != "api"
        || !control.starts_with("https://")
        || control.contains('*')
        || scope.integrations.len() != 1
        || scope.integrations[0].origin != control
    {
        bail!("Cap pilot requires a development API with one exact HTTPS control origin");
    }
    if !valid_cap_key(site_key) || secret.is_empty() {
        bail!("Cap pilot requires a site key and a private site secret");
    }
    Ok(())
}

#[cfg(test)]
#[path = "captcha_config_tests.rs"]
mod tests;
