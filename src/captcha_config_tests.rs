//! Startup rules for the CAPTCHA provider settings.
use super::*;
use std::collections::HashMap;

const ORIGIN: &str = "https://staging.example.com";
const RECAPTCHA_TEST_SITE: &str = "6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI";

fn entries() -> Vec<Integration> {
    vec![Integration {
        origin: ORIGIN.into(),
        site: "pilot".into(),
    }]
}

/// Writes `contents` to a fresh file in the temporary directory and returns its path.
fn secret_file(contents: &str) -> String {
    let path = std::env::temp_dir().join(format!("captcha-config-{}", crate::config::random_id()));
    std::fs::write(&path, contents).unwrap();
    path.to_string_lossy().into_owned()
}

/// Loads the settings for a development API with one integration and the given variables.
fn load_with(environment: &str, role: &str, vars: &[(&str, &str)]) -> Result<CaptchaSettings> {
    let vars: HashMap<String, String> = vars
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    let integrations = entries();
    let scope = Scope {
        environment,
        role,
        control_origin: ORIGIN,
        integrations: &integrations,
    };
    load(&scope, &|key| vars.get(key).cloned())
}

fn error(result: Result<CaptchaSettings>) -> String {
    match result {
        Ok(_) => panic!("expected a startup error"),
        Err(e) => e.to_string(),
    }
}

fn cap_sites() -> String {
    secret_file(&format!(
        r#"[{{"origin":"{ORIGIN}","siteKey":"pilot_key","secret":"cap-secret"}}]"#
    ))
}

#[test]
fn recaptcha_is_the_default_and_production_needs_real_credentials() {
    let settings = load_with("development", "api", &[]).unwrap();
    assert!(!settings.cap_staging && !settings.cap_preferred && !settings.accept_both);
    assert!(settings.cap.is_none());
    assert!(settings.site_key.is_empty() && settings.secret.is_empty());
    assert!(error(load_with("production", "api", &[])).contains("real reCAPTCHA"));
    let secret = secret_file("  real-secret\n");
    let real = [
        ("RECAPTCHA_SITE_KEY", "real-key"),
        ("RECAPTCHA_SECRET_FILE", secret.as_str()),
    ];
    let settings = load_with("production", "api", &real).unwrap();
    assert_eq!(settings.site_key, "real-key");
    assert_eq!(settings.secret, "real-secret");
    // The gateway never reads the secret and does not verify tokens.
    let gateway = load_with("production", "gateway", &real).unwrap();
    assert_eq!(gateway.site_key, "real-key");
    assert!(gateway.secret.is_empty());
    let missing = [("RECAPTCHA_SECRET_FILE", "/nonexistent/captcha-secret")];
    assert!(error(load_with("development", "api", &missing)).contains("RECAPTCHA_SECRET_FILE"));
}

#[test]
fn unknown_provider_and_accept_both_values_are_refused() {
    let provider = [("CAPTCHA_PROVIDER", "hcaptcha")];
    assert!(error(load_with("development", "api", &provider)).contains("CAPTCHA_PROVIDER"));
    let both = [("CAPTCHA_ACCEPT_BOTH", "yes")];
    assert!(error(load_with("development", "api", &both)).contains("true or false"));
}

#[test]
fn accept_both_is_refused_in_test_mode_and_with_the_pilot() {
    let both = [("CAPTCHA_PROVIDER", "cap"), ("CAPTCHA_ACCEPT_BOTH", "true")];
    assert!(error(load_with("test", "api", &both)).contains("outside test mode"));
    let pilot = [
        ("CAPTCHA_PROVIDER", "cap-staging"),
        ("CAPTCHA_ACCEPT_BOTH", "true"),
    ];
    assert!(error(load_with("development", "api", &pilot)).contains("outside test mode"));
}

#[test]
fn the_cap_pilot_runs_only_in_a_development_api() {
    let secret = secret_file("pilot-secret");
    let pilot = [
        ("CAPTCHA_PROVIDER", "cap-staging"),
        ("CAP_STAGING_SITE_KEY", "pilot_key"),
        ("CAP_STAGING_SECRET_FILE", secret.as_str()),
        ("RECAPTCHA_SITE_KEY", "ignored"),
    ];
    for (environment, role) in [
        ("production", "api"),
        ("test", "api"),
        ("development", "gateway"),
    ] {
        let message = error(load_with(environment, role, &pilot));
        assert!(message.contains("outside a development API"), "{message}");
    }
    let settings = load_with("development", "api", &pilot).unwrap();
    assert!(settings.cap_staging && !settings.cap_preferred);
    assert_eq!(settings.site_key, "pilot_key");
    assert_eq!(settings.secret, "pilot-secret");
    assert!(settings.cap.is_none());
    let bad_key = [
        ("CAPTCHA_PROVIDER", "cap-staging"),
        ("CAP_STAGING_SITE_KEY", "../admin"),
        ("CAP_STAGING_SECRET_FILE", secret.as_str()),
    ];
    assert!(error(load_with("development", "api", &bad_key)).contains("site key"));
}

#[test]
fn cap_requires_a_readable_valid_sites_file_in_the_api() {
    let cap = |sites: &str| {
        let vars = [
            ("CAPTCHA_PROVIDER", "cap"),
            ("CAP_PUBLIC_URL", "https://cap.example.com/"),
            ("CAP_SITES_FILE", sites),
        ];
        load_with("production", "api", &vars)
    };
    let sites = cap_sites();
    let settings = cap(&sites).unwrap();
    assert!(settings.cap_preferred && !settings.accept_both);
    // Cap alone loads no reCAPTCHA credentials.
    assert!(settings.site_key.is_empty() && settings.secret.is_empty());
    let config = settings.cap.unwrap();
    assert_eq!(config.public_url, "https://cap.example.com");
    assert_eq!(config.verify_url, "http://capd:3000");
    assert_eq!(config.site(ORIGIN).unwrap().site_key, "pilot_key");
    assert!(error(cap("/nonexistent/cap-sites.json")).contains("cannot read CAP_SITES_FILE"));
    assert!(error(cap(&secret_file("{"))).contains("invalid CAP_SITES_FILE JSON"));
    let missing = [("CAPTCHA_PROVIDER", "cap")];
    assert!(error(load_with("production", "api", &missing)).contains("requires CAP_SITES_FILE"));
    // A gateway never reads site secrets and needs no sites file.
    let gateway = load_with("production", "gateway", &missing).unwrap();
    assert!(gateway.cap.unwrap().sites.is_empty());
}

#[test]
fn dual_mode_needs_real_recaptcha_credentials_and_cap_sites() {
    let sites = cap_sites();
    let secret = secret_file("real-secret");
    let dual = |site_key: &str| {
        let vars = [
            ("CAPTCHA_PROVIDER", "cap"),
            ("CAPTCHA_ACCEPT_BOTH", "true"),
            ("CAP_PUBLIC_URL", "https://cap.example.com"),
            ("CAP_VERIFY_URL", "http://capd:3000/"),
            ("CAP_SITES_FILE", sites.as_str()),
            ("RECAPTCHA_SITE_KEY", site_key),
            ("RECAPTCHA_SECRET_FILE", secret.as_str()),
        ];
        load_with("development", "api", &vars)
    };
    let settings = dual("real-key").unwrap();
    assert!(settings.cap_preferred && settings.accept_both);
    assert_eq!(settings.site_key, "real-key");
    assert_eq!(settings.secret, "real-secret");
    assert_eq!(settings.cap.unwrap().verify_url, "http://capd:3000");
    // Development normally accepts test keys, but not during the transition.
    assert!(error(dual(RECAPTCHA_TEST_SITE)).contains("real reCAPTCHA"));
}

#[test]
fn production_recaptcha_refuses_google_test_credentials() {
    assert!(validate_captcha("", "", true).is_err());
    assert!(validate_captcha(RECAPTCHA_TEST_SITE, "fixture", true).is_err());
    assert!(validate_captcha("fixture", "6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe", true).is_err());
    assert!(validate_captcha("", "", false).is_ok());
}

#[test]
fn cap_is_restricted_to_a_single_https_development_api_origin() {
    let integrations = entries();
    let valid = |environment, role, control_origin, site_key, secret| {
        let scope = Scope {
            environment,
            role,
            control_origin,
            integrations: &integrations,
        };
        validate_cap_staging(&scope, site_key, secret)
    };
    assert!(valid("development", "api", ORIGIN, "cap_key", "secret").is_ok());
    for environment in ["production", "test"] {
        assert!(valid(environment, "api", ORIGIN, "cap_key", "secret").is_err());
    }
    assert!(valid("development", "gateway", ORIGIN, "cap_key", "secret").is_err());
    for control in ["http://staging.example.com", "https://example.com"] {
        assert!(valid("development", "api", control, "cap_key", "secret").is_err());
    }
    assert!(valid("development", "api", ORIGIN, "../admin", "secret").is_err());
    assert!(valid("development", "api", ORIGIN, "", "secret").is_err());
    assert!(valid("development", "api", ORIGIN, "cap_key", "").is_err());
    let none = Scope {
        environment: "development",
        role: "api",
        control_origin: ORIGIN,
        integrations: &[],
    };
    assert!(validate_cap_staging(&none, "cap_key", "secret").is_err());
}

#[test]
fn cap_needs_one_key_per_integration_and_https_in_production() {
    let entries = vec![
        Integration {
            origin: "https://shifter.io".into(),
            site: "shifter".into(),
        },
        Integration {
            origin: "https://*.shifter-bitch.com".into(),
            site: "shifter".into(),
        },
    ];
    let site = |origin: &str, key: &str| CapSite {
        origin: origin.into(),
        site_key: key.into(),
        secret: "secret".into(),
    };
    let cap = |public: &str, sites: Vec<CapSite>| CapConfig {
        verify_url: "http://capd:3000".into(),
        public_url: public.into(),
        sites,
    };
    let check = |public: &str, sites: Vec<CapSite>, production| {
        validate_cap(&cap(public, sites), &entries, production)
    };
    let both = vec![
        site("https://shifter.io", "main"),
        site("https://*.shifter-bitch.com", "previews"),
    ];
    assert!(check("https://cap.example.com", both.clone(), true).is_ok());
    assert!(check("http://cap.example.com", both.clone(), false).is_ok());
    // Production needs HTTPS for the widget origin, and a bare origin.
    assert!(check("http://cap.example.com", both.clone(), true).is_err());
    assert!(check("https://cap.example.com/x", both.clone(), true).is_err());
    assert!(check("", both.clone(), false).is_err());
    let mut bad_verify = cap("https://cap.example.com", both.clone());
    bad_verify.verify_url = "ftp://capd".into();
    assert!(validate_cap(&bad_verify, &entries, false).is_err());
    bad_verify.verify_url = "capd:3000/x".into();
    assert!(validate_cap(&bad_verify, &entries, false).is_err());
    // Every integration needs its own key; unknown origins and shared keys are refused.
    assert!(check("https://cap.example.com", both[..1].to_vec(), true).is_err());
    let shared = vec![
        site("https://shifter.io", "same"),
        site("https://*.shifter-bitch.com", "same"),
    ];
    assert!(check("https://cap.example.com", shared, true).is_err());
    let mut extra = both.clone();
    extra.push(site("https://other.example", "other"));
    assert!(check("https://cap.example.com", extra, true).is_err());
    let mut bad = both.clone();
    bad[0].secret = String::new();
    assert!(check("https://cap.example.com", bad, true).is_err());
    assert_eq!(
        cap("https://cap.example.com", both)
            .site("https://*.shifter-bitch.com")
            .map(|s| s.site_key.as_str()),
        Some("previews")
    );
}
