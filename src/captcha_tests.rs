use super::*;
use crate::captcha_config::CapSite;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[test]
fn dual_verification_routes_each_token_once_even_if_the_cap_key_is_wrong() {
    let cap = CapConfig {
        verify_url: "http://capd:3000".into(),
        public_url: "https://cap.example.com".into(),
        sites: vec![],
    };
    for token in ["key:challenge:answer", "wrong:key:answer", "bad:format"] {
        assert!(matches!(
            verifier(Some(&cap), true, token),
            Verifier::Cap(_)
        ));
    }
    assert!(matches!(
        verifier(Some(&cap), true, "google-token"),
        Verifier::Legacy
    ));
    assert!(matches!(
        verifier(Some(&cap), false, "google-token"),
        Verifier::Cap(_)
    ));
    assert!(matches!(
        verifier(None, false, "key:challenge:answer"),
        Verifier::Legacy
    ));
}

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

const TOKEN: &str = "pilot:challenge:answer";

fn client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}

/// Reads one HTTP request: its head and a body of Content-Length bytes.
async fn read_request(socket: &mut tokio::net::TcpStream) -> String {
    let mut data = Vec::new();
    let mut chunk = [0; 4096];
    loop {
        let n = socket.read(&mut chunk).await.unwrap();
        data.extend_from_slice(&chunk[..n]);
        let text = String::from_utf8_lossy(&data).into_owned();
        let Some((head, body)) = text.split_once("\r\n\r\n") else {
            assert!(n > 0, "connection closed before the request head ended");
            continue;
        };
        let length = head
            .lines()
            .find_map(|line| {
                let line = line.to_ascii_lowercase();
                line.strip_prefix("content-length:")
                    .map(|v| v.trim().parse::<usize>().unwrap())
            })
            .unwrap_or(0);
        if body.len() >= length || n == 0 {
            return text;
        }
    }
}

/// A one-request verifier on 127.0.0.1 answering `status` and `body`. Returns its base
/// URL and a task that yields the raw request it received.
async fn stub(status: u16, body: &'static str) -> (String, tokio::task::JoinHandle<String>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = read_request(&mut socket).await;
        let reply = format!(
            "HTTP/1.1 {status} Stub\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(reply.as_bytes()).await.unwrap();
        socket.shutdown().await.ok();
        request
    });
    (base, task)
}

async fn siteverify(status: u16, body: &'static str) -> (Result<bool, ()>, String) {
    let (base, request) = stub(status, body).await;
    let site = Site {
        base: &base,
        key: "pilot",
        secret: "cap-secret",
    };
    let result = cap_siteverify(&client(), &site, TOKEN).await;
    (result, request.await.unwrap())
}

#[tokio::test]
async fn cap_siteverify_posts_the_secret_and_token_to_the_site_path() {
    let (result, request) = siteverify(200, r#"{"success":true}"#).await;
    assert_eq!(result, Ok(true));
    assert!(
        request.starts_with("POST /pilot/siteverify HTTP/1.1\r\n"),
        "{request}"
    );
    assert!(
        request
            .to_ascii_lowercase()
            .contains("content-type: application/json")
    );
    let body = request.split_once("\r\n\r\n").unwrap().1;
    let body: serde_json::Value = serde_json::from_str(body).unwrap();
    assert_eq!(
        body,
        serde_json::json!({"secret": "cap-secret", "response": TOKEN})
    );
}

#[tokio::test]
async fn cap_siteverify_rejects_failed_and_refused_tokens() {
    assert_eq!(siteverify(200, r#"{"success":false}"#).await.0, Ok(false));
    for status in [400, 403, 404] {
        let (result, _) = siteverify(status, r#"{"success":true}"#).await;
        assert_eq!(result, Ok(false), "{status}");
    }
}

#[tokio::test]
async fn cap_siteverify_reports_other_answers_as_unavailable() {
    for status in [401, 429, 500, 502, 503] {
        let (result, _) = siteverify(status, r#"{"success":true}"#).await;
        assert_eq!(result, Err(()), "{status}");
    }
    assert_eq!(siteverify(200, "not json").await.0, Err(()));
    // Nothing listens on a port that was just released: the connection fails.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let site = Site {
        base: &base,
        key: "pilot",
        secret: "cap-secret",
    };
    assert_eq!(cap_siteverify(&client(), &site, TOKEN).await, Err(()));
}

#[tokio::test]
async fn cap_siteverify_checks_the_secret_and_key_before_calling() {
    // Nothing listens here, so a request would end as unavailable, not rejected.
    let site = Site {
        base: "http://127.0.0.1:9",
        key: "pilot",
        secret: "",
    };
    assert_eq!(cap_siteverify(&client(), &site, TOKEN).await, Err(()));
    let site = Site {
        secret: "cap-secret",
        ..site
    };
    let other = "other:challenge:answer";
    assert_eq!(cap_siteverify(&client(), &site, other).await, Ok(false));
}

#[tokio::test]
async fn verify_cap_uses_the_key_of_the_matched_integration() {
    let (base, request) = stub(200, r#"{"success":true}"#).await;
    let cap = CapConfig {
        verify_url: base,
        public_url: "https://cap.example.com".into(),
        sites: vec![CapSite {
            origin: "https://*.example.com".into(),
            site_key: "wild".into(),
            secret: "wild-secret".into(),
        }],
    };
    let token = "wild:challenge:answer";
    let origin = "https://*.example.com";
    assert_eq!(verify_cap(&client(), &cap, token, origin).await, Ok(true));
    let request = request.await.unwrap();
    assert!(request.starts_with("POST /wild/siteverify "), "{request}");
    assert!(request.contains(r#""secret":"wild-secret""#));
    let unknown = "https://other.example";
    assert_eq!(verify_cap(&client(), &cap, token, unknown).await, Err(()));
}
