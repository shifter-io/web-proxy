use anyhow::{Context, Result, bail};
use serde::Deserialize;
use std::{env, net::IpAddr};

pub const COUNTRIES: &[(&str, &str)] = &[
    ("us", "United States"),
    ("gb", "United Kingdom"),
    ("de", "Germany"),
    ("fr", "France"),
    ("ca", "Canada"),
    ("au", "Australia"),
    ("sg", "Singapore"),
    ("in", "India"),
];
pub fn valid_country(country: &str) -> bool {
    COUNTRIES.iter().any(|(code, _)| *code == country)
}
pub fn random_id() -> String {
    hex::encode(rand::random::<[u8; 16]>())
}
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
pub fn is_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|c| c.is_ascii_hexdigit())
}

#[derive(Clone)]
pub struct Config {
    pub role: String,
    pub replica: String,
    pub listen: String,
    pub redis: String,
    pub control_origin: String,
    pub runtime_origin: String,
    pub region: String,
    pub upstream_host: String,
    pub upstream_port: u16,
    pub upstream_ips: Vec<IpAddr>,
    pub account: String,
    pub password: String,
    pub duration_ms: u64,
    pub byte_limit: u64,
    pub max_streams: usize,
    pub stream_rate: u64,
    pub stream_burst: u64,
    pub connect_timeout: u64,
    pub idle_timeout: u64,
    pub test_mode: bool,
    pub web_dir: String,
}
#[derive(Deserialize)]
struct Secrets {
    shifter: Account,
}
#[derive(Deserialize)]
struct Account {
    account: String,
    password: String,
}

fn val(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.into())
}
fn number(key: &str, default: u64) -> Result<u64> {
    let n = val(key, &default.to_string())
        .parse::<u64>()
        .with_context(|| format!("invalid {key}"))?;
    if n == 0 {
        bail!("{key} must be positive");
    }
    Ok(n)
}
impl Config {
    pub async fn load() -> Result<Self> {
        let environment = val("APP_ENV", "development");
        // There is deliberately no production authentication provider in this milestone.
        if environment != "development" && environment != "test" {
            bail!(
                "production disabled: verified identity provider and TLS deployment are not implemented"
            );
        }
        let test_mode = environment == "test";
        let role = val("ROLE", "api");
        if !["api", "gateway"].contains(&role.as_str()) {
            bail!("invalid ROLE");
        }
        let region = val("SHIFTER_REGION", "blr");
        if !["fra", "ams", "lon", "nyc", "tor", "sgp", "blr", "syd"].contains(&region.as_str()) {
            bail!("invalid region");
        }
        let upstream_host = if test_mode {
            "mock-upstream".into()
        } else {
            format!("{region}.p.shifter.io")
        };
        let upstream_port = if test_mode { 1080 } else { 443 };
        let (account, password) = if test_mode {
            ("fixture".into(), "fixture-password".into())
        } else if role == "gateway" {
            let path = val("CREDENTIALS_FILE", "/run/secrets/shifter_credentials");
            let contents =
                std::fs::read_to_string(path).context("cannot read credential secret")?;
            // Do not expose TOML parse errors: they may include the secret's source line.
            let secrets: Secrets = toml::from_str(&contents)
                .map_err(|_| anyhow::anyhow!("invalid credential secret"))?;
            (
                secrets
                    .shifter
                    .account
                    .trim_start_matches("customer-")
                    .to_string(),
                secrets.shifter.password,
            )
        } else {
            (String::new(), String::new())
        };
        if role == "gateway" {
            if account.is_empty()
                || !account
                    .bytes()
                    .all(|x| x.is_ascii_alphanumeric() || b"._".contains(&x))
            {
                bail!("invalid account syntax");
            }
            if password.is_empty() || !password.is_ascii() || password.len() > 255 {
                bail!("invalid SOCKS password length/encoding");
            }
        }
        let upstream_ips = if role == "gateway" {
            tokio::net::lookup_host((upstream_host.as_str(), upstream_port))
                .await
                .context("upstream DNS unavailable")?
                .map(|x| x.ip())
                .collect()
        } else {
            vec![]
        };
        let cfg = Self {
            role,
            replica: val("REPLICA", "api"),
            listen: val("LISTEN", "0.0.0.0:3000"),
            redis: val("REDIS_URL", "redis://redis:6379/"),
            control_origin: val("CONTROL_ORIGIN", "http://localhost:8080"),
            runtime_origin: val("RUNTIME_ORIGIN", "http://localhost:8081"),
            region,
            upstream_host,
            upstream_port,
            upstream_ips,
            account,
            password,
            duration_ms: number("SESSION_SECONDS", 600)? * 1000,
            byte_limit: number("BYTE_LIMIT", 100 * 1024 * 1024)?,
            max_streams: number("MAX_STREAMS", 32)? as usize,
            stream_rate: number("STREAM_RATE", 8)?,
            stream_burst: number("STREAM_BURST", 16)?,
            connect_timeout: number("CONNECT_TIMEOUT_SECONDS", 15)?,
            idle_timeout: number("IDLE_TIMEOUT_SECONDS", 60)?,
            test_mode,
            web_dir: val("WEB_DIR", "web"),
        };
        if cfg.duration_ms > 600_000 {
            bail!("SESSION_SECONDS must be at most 600 for the configured sticky TTL");
        }
        if cfg.max_streams > 128 {
            bail!("MAX_STREAMS too large");
        }
        if cfg.role == "gateway" {
            cfg.username("us", &random_id())?;
        }
        Ok(cfg)
    }
    pub fn username(&self, country: &str, sid: &str) -> Result<String> {
        if !valid_country(country) || !is_id(sid) {
            bail!("invalid session routing");
        }
        let user = format!(
            "customer-{}-country-{country}-strict-true-sid-{sid}-ttl-600",
            self.account
        );
        if user.len() > 255 {
            bail!("SOCKS username too long");
        }
        Ok(user)
    }
}
