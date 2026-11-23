//! The public `/api/v1/config` answer for each CAPTCHA mode.
use super::*;
use crate::captcha_config::{CapConfig, CapSite};

const RUNTIME: &str = "https://proxy.example.net";
const SITE_SECRET: &str = "cap-site-secret";

fn entry(origin: &str, site: &str) -> Integration {
    Integration {
        origin: origin.into(),
        site: site.into(),
    }
}

/// Cap preferred, with one key for an exact origin and one for a wildcard origin.
fn cap_settings(accept_both: bool) -> CaptchaSettings {
    let site = |origin: &str, key: &str| CapSite {
        origin: origin.into(),
        site_key: key.into(),
        secret: SITE_SECRET.into(),
    };
    CaptchaSettings {
        site_key: if accept_both {
            "recaptcha-key".into()
        } else {
            String::new()
        },
        secret: "recaptcha-secret".into(),
        cap_preferred: true,
        accept_both,
        cap: Some(CapConfig {
            verify_url: "http://capd:3000".into(),
            public_url: "https://cap.example.com".into(),
            sites: vec![
                site("https://example.com", "main"),
                site("https://*.example.org", "previews"),
            ],
        }),
        ..Default::default()
    }
}

fn assert_cap(body: &Value, key: &str) {
    assert_eq!(body["captchaProvider"], "cap");
    assert_eq!(body["captchaSiteKey"], key);
    assert_eq!(
        body["capEndpoint"],
        format!("https://cap.example.com/{key}/")
    );
    assert_eq!(body["capAssets"], "https://cap.example.com/assets/");
    assert_private_values_stay_out(body);
}

fn assert_recaptcha(body: &Value, key: &str) {
    assert_eq!(body["captchaProvider"], "recaptcha");
    assert_eq!(body["captchaSiteKey"], key);
    assert!(body.get("capEndpoint").is_none() && body.get("capAssets").is_none());
    assert_private_values_stay_out(body);
}

fn assert_private_values_stay_out(body: &Value) {
    let text = body.to_string();
    for private in [SITE_SECRET, "recaptcha-secret", "capd"] {
        assert!(!text.contains(private), "{private} leaked: {text}");
    }
}

#[test]
fn dual_mode_only_advertises_cap_to_clients_that_support_refresh() {
    assert!(!advertise_cap(false, true, Some("cap")));
    assert!(!advertise_cap(true, true, None));
    assert!(!advertise_cap(true, true, Some("unexpected")));
    assert!(advertise_cap(true, true, Some("cap")));
    assert!(advertise_cap(true, false, None));
}

#[test]
fn cap_mode_advertises_the_key_of_the_requesting_integration() {
    let captcha = cap_settings(false);
    let site = entry("https://example.com", "shifter");
    let body = config_body(&site, RUNTIME, &captcha, None);
    assert_eq!(body["site"], "shifter");
    assert_eq!(body["runtimeOrigin"], RUNTIME);
    assert_eq!(body["protocolVersion"], 1);
    assert_eq!(
        body["countries"].as_array().map(Vec::len),
        Some(countries().len())
    );
    assert_cap(&body, "main");
    // A wildcard integration gets the key listed for its pattern.
    let wild = entry("https://*.example.org", "previews");
    assert_cap(&config_body(&wild, RUNTIME, &captcha, None), "previews");
}

#[test]
fn dual_mode_keeps_recaptcha_for_sdks_without_cap_support() {
    let captcha = cap_settings(true);
    let site = entry("https://example.com", "shifter");
    for capability in [None, Some("recaptcha"), Some("unexpected")] {
        let body = config_body(&site, RUNTIME, &captcha, capability);
        assert_recaptcha(&body, "recaptcha-key");
    }
    assert_cap(&config_body(&site, RUNTIME, &captcha, Some("cap")), "main");
    let wild = entry("https://*.example.org", "previews");
    assert_cap(
        &config_body(&wild, RUNTIME, &captcha, Some("cap")),
        "previews",
    );
}

#[test]
fn recaptcha_and_pilot_modes_send_only_their_configured_key() {
    let site = entry("https://example.com", "shifter");
    let recaptcha = CaptchaSettings {
        site_key: "recaptcha-key".into(),
        secret: "recaptcha-secret".into(),
        ..Default::default()
    };
    for capability in [None, Some("cap")] {
        let body = config_body(&site, RUNTIME, &recaptcha, capability);
        assert_recaptcha(&body, "recaptcha-key");
    }
    // The pilot page reads its Cap key from captchaSiteKey; SDK clients cannot use this mode.
    let pilot = CaptchaSettings {
        site_key: "pilot_key".into(),
        cap_staging: true,
        ..recaptcha
    };
    assert_recaptcha(
        &config_body(&site, RUNTIME, &pilot, Some("cap")),
        "pilot_key",
    );
}
