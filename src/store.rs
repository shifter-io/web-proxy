use crate::config::{Config, now_ms, random_id};
use anyhow::{Result, bail};
use redis::{AsyncCommands, Script, aio::ConnectionManager};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone)]
pub struct Store {
    pub db: ConnectionManager,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Session {
    pub key: String,
    pub country: String,
    pub sid: String,
    pub region: String,
    pub expires_at: u64,
    pub revision: u64,
    pub used: u64,
    pub limit: u64,
    pub stopped: bool,
    pub connected: bool,
}
impl Session {
    pub fn active(&self) -> bool {
        !self.stopped && self.expires_at > now_ms() && self.used < self.limit
    }
    pub fn public(&self) -> serde_json::Value {
        let status = if self.expires_at <= now_ms() {
            "expired"
        } else if self.used >= self.limit {
            "exhausted"
        } else if self.stopped {
            "stopped"
        } else {
            "active"
        };
        serde_json::json!({"country":self.country,"status":status,"serverTime":now_ms(),
            "expiresAt":self.expires_at,"remainingBytes":self.limit.saturating_sub(self.used),
            "byteLimit":self.limit,"connected":self.connected,"developmentIdentity":true})
    }
}
impl Store {
    pub async fn new(url: &str, ca_file: Option<&str>) -> Result<Self> {
        let client = if let Some(path) = ca_file {
            let root_cert =
                std::fs::read(path).map_err(|_| anyhow::anyhow!("cannot read REDIS_CA_FILE"))?;
            redis::Client::build_with_tls(
                url,
                redis::TlsCertificates {
                    client_tls: None,
                    root_cert: Some(root_cert),
                },
            )
        } else {
            redis::Client::open(url)
        }
        .map_err(|_| anyhow::anyhow!("invalid Redis connection/TLS configuration"))?;
        let options = redis::aio::ConnectionManagerConfig::new()
            .set_connection_timeout(std::time::Duration::from_secs(2))
            .set_response_timeout(std::time::Duration::from_secs(2))
            .set_number_of_retries(1);
        Ok(Self {
            db: client.get_connection_manager_with_config(options).await
                .map_err(|_| anyhow::anyhow!("Redis connection failed; check private reachability, ACL credentials and TLS trust"))?,
        })
    }
    pub fn key(visitor: &str) -> String {
        format!("daily:{visitor}:{}", now_ms() / 86_400_000)
    }
    pub async fn get(&self, key: &str) -> Result<Option<Session>> {
        let h: HashMap<String, String> = self.db.clone().hgetall(key).await?;
        if h.is_empty() {
            return Ok(None);
        }
        let s = Session {
            key: key.into(),
            country: h["country"].clone(),
            sid: h["sid"].clone(),
            region: h["region"].clone(),
            expires_at: h["exp"].parse()?,
            revision: h["rev"].parse()?,
            used: h["used"].parse()?,
            limit: h["limit"].parse()?,
            stopped: h["stopped"] == "1",
            connected: h
                .get("lease_until")
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(0)
                > now_ms(),
        };
        Ok(Some(s))
    }
    pub async fn start(&self, visitor: &str, country: &str, cfg: &Config) -> Result<Session> {
        let key = Self::key(visitor);
        let now = now_ms();
        let exp = (now + cfg.duration_ms).min((now / 86_400_000 + 1) * 86_400_000);
        let sid = random_id();
        let _: i64 = Script::new(
            r#"
            if redis.call('EXISTS',KEYS[1])==0 then
              redis.call('HSET',KEYS[1],'country',ARGV[1],'sid',ARGV[2],'region',ARGV[3],
                'exp',ARGV[4],'rev',1,'used',0,'limit',ARGV[5],'stopped',0)
              redis.call('PEXPIREAT',KEYS[1],ARGV[6])
            elseif redis.call('HGET',KEYS[1],'stopped')=='1' then
              redis.call('HSET',KEYS[1],'stopped',0,'sid',ARGV[2],'country',ARGV[1])
              redis.call('HINCRBY',KEYS[1],'rev',1)
            end
            return 1
        "#,
        )
        .key(&key)
        .arg(country)
        .arg(sid)
        .arg(&cfg.region)
        .arg(exp)
        .arg(cfg.byte_limit)
        .arg((now / 86_400_000 + 2) * 86_400_000)
        .invoke_async(&mut self.db.clone())
        .await?;
        self.get(&key)
            .await?
            .ok_or_else(|| anyhow::anyhow!("session unavailable"))
    }
    pub async fn change(&self, session: &Session, country: Option<&str>) -> Result<()> {
        let _: i64 = Script::new(
            r#"
            if redis.call('EXISTS',KEYS[1])==0 then return 0 end
            redis.call('HINCRBY',KEYS[1],'rev',1)
            if ARGV[1]=='' then redis.call('HSET',KEYS[1],'stopped',1)
            else redis.call('HSET',KEYS[1],'country',ARGV[1],'sid',ARGV[2]) end
            return 1
        "#,
        )
        .key(&session.key)
        .arg(country.unwrap_or(""))
        .arg(random_id())
        .invoke_async(&mut self.db.clone())
        .await?;
        Ok(())
    }
    pub async fn ticket(&self, session: &Session) -> Result<String> {
        if !session.active() {
            bail!("session inactive");
        }
        let ticket = random_id();
        let _: () = self
            .db
            .clone()
            .set_ex(
                format!("ticket:{ticket}"),
                serde_json::to_string(session)?,
                30,
            )
            .await?;
        Ok(ticket)
    }
    pub async fn reconnect(&self, session: &Session) -> Result<()> {
        let _: i64 = self.db.clone().hincr(&session.key, "rev", 1).await?;
        Ok(())
    }
    /// Only the current gateway owner can attest to a failed upstream connection.
    pub async fn upstream_failed(&self, s: &Session, owner: &str, host: &str) -> Result<()> {
        let _: i64 = Script::new(
            r#"
            if redis.call('HGET',KEYS[1],'rev')~=ARGV[1]
              or redis.call('HGET',KEYS[1],'owner')~=ARGV[2] then return 0 end
            redis.call('SET',KEYS[2],ARGV[1],'EX',30)
            return 1
        "#,
        )
        .key(&s.key)
        .key(format!(
            "{}:failure:{}",
            s.key,
            host.trim_end_matches('.').to_ascii_lowercase()
        ))
        .arg(s.revision)
        .arg(owner)
        .invoke_async(&mut self.db.clone())
        .await?;
        Ok(())
    }
    /// Compare-and-swap prevents duplicate/stale recovery from rotating a new session.
    /// Never clear the lease: the old gateway must stop before another can claim it.
    pub async fn recover(
        &self,
        s: &Session,
        revision: u64,
        host: &str,
        upstream: bool,
    ) -> Result<bool> {
        let ok: i64 = Script::new(r#"
            if redis.call('HGET',KEYS[1],'rev')~=ARGV[1]
              or redis.call('HGET',KEYS[1],'stopped')~='0' then return 0 end
            if tonumber(redis.call('HGET',KEYS[1],'exp'))<=tonumber(ARGV[2])
              or tonumber(redis.call('HGET',KEYS[1],'used'))>=tonumber(redis.call('HGET',KEYS[1],'limit')) then return 0 end
            if ARGV[3]=='1' and redis.call('GET',KEYS[2])~=ARGV[1] then return 0 end
            local start=tonumber(redis.call('HGET',KEYS[1],'recovery_start') or '0')
            local count=tonumber(redis.call('HGET',KEYS[1],'recovery_count') or '0')
            if tonumber(ARGV[2])-start>=30000 then start=tonumber(ARGV[2]); count=0 end
            if count>=2 then return 0 end
            redis.call('HSET',KEYS[1],'recovery_start',start,'recovery_count',count+1)
            if ARGV[3]=='1' then redis.call('HSET',KEYS[1],'sid',ARGV[4]) end
            redis.call('HINCRBY',KEYS[1],'rev',1)
            redis.call('GETDEL',KEYS[2])
            return 1
        "#).key(&s.key).key(format!("{}:failure:{}", s.key, host.trim_end_matches('.').to_ascii_lowercase()))
            .arg(revision).arg(now_ms()).arg(if upstream {1} else {0}).arg(random_id())
            .invoke_async(&mut self.db.clone()).await?;
        Ok(ok == 1)
    }
    pub async fn claim(&self, ticket: &str, owner: &str) -> Result<Session> {
        let raw: Option<String> = redis::cmd("GETDEL")
            .arg(format!("ticket:{ticket}"))
            .query_async(&mut self.db.clone())
            .await?;
        let session: Session =
            serde_json::from_str(&raw.ok_or_else(|| anyhow::anyhow!("invalid ticket"))?)?;
        let ok:i64=Script::new(r#"
            if redis.call('HGET',KEYS[1],'rev')~=ARGV[1] or redis.call('HGET',KEYS[1],'stopped')~='0' then return 0 end
            if tonumber(redis.call('HGET',KEYS[1],'exp'))<=tonumber(ARGV[2]) then return 0 end
            if tonumber(redis.call('HGET',KEYS[1],'used'))>=tonumber(redis.call('HGET',KEYS[1],'limit')) then return 0 end
            local until_ms=tonumber(redis.call('HGET',KEYS[1],'lease_until') or '0')
            if until_ms>tonumber(ARGV[2]) then return 0 end
            redis.call('HSET',KEYS[1],'owner',ARGV[3],'lease_until',ARGV[4])
            return 1
        "#).key(&session.key).arg(session.revision).arg(now_ms()).arg(owner).arg(now_ms()+6000)
            .invoke_async(&mut self.db.clone()).await?;
        if ok != 1 {
            bail!("inactive or connected session");
        }
        Ok(session)
    }
    pub async fn heartbeat(&self, s: &Session, owner: &str) -> Result<bool> {
        let ok:i64=Script::new(r#"
            if redis.call('HGET',KEYS[1],'rev')~=ARGV[1] or redis.call('HGET',KEYS[1],'owner')~=ARGV[2]
              or redis.call('HGET',KEYS[1],'stopped')~='0' then return 0 end
            if tonumber(redis.call('HGET',KEYS[1],'exp'))<=tonumber(ARGV[3])
              or tonumber(redis.call('HGET',KEYS[1],'lease_until') or '0')<=tonumber(ARGV[3]) then return 0 end
            if tonumber(redis.call('HGET',KEYS[1],'used'))>=tonumber(redis.call('HGET',KEYS[1],'limit')) then return 0 end
            redis.call('HSET',KEYS[1],'lease_until',ARGV[4])
            return 1
        "#).key(&s.key).arg(s.revision).arg(owner).arg(now_ms()).arg(now_ms()+6000)
            .invoke_async(&mut self.db.clone()).await?;
        Ok(ok == 1)
    }
    pub async fn release(&self, s: &Session, owner: &str) {
        let _: Result<i64, _> = Script::new(
            r#"
            if redis.call('HGET',KEYS[1],'owner')==ARGV[1] then
              redis.call('HDEL',KEYS[1],'owner','lease_until') return 1 end return 0
        "#,
        )
        .key(&s.key)
        .arg(owner)
        .invoke_async(&mut self.db.clone())
        .await;
    }
    /// Charge before forwarding, using a single atomic operation for all streams/replicas.
    /// A failed write may conservatively consume its reserved bytes; no overrun is possible.
    pub async fn charge(&self, s: &Session, owner: &str, n: usize) -> Result<usize> {
        let allowed:i64=Script::new(r#"
            if redis.call('HGET',KEYS[1],'rev')~=ARGV[1] or redis.call('HGET',KEYS[1],'owner')~=ARGV[2]
              or redis.call('HGET',KEYS[1],'stopped')~='0' then return 0 end
            if tonumber(redis.call('HGET',KEYS[1],'exp'))<=tonumber(ARGV[3])
              or tonumber(redis.call('HGET',KEYS[1],'lease_until') or '0')<=tonumber(ARGV[3]) then return 0 end
            local left=tonumber(redis.call('HGET',KEYS[1],'limit'))-tonumber(redis.call('HGET',KEYS[1],'used'))
            local n=math.min(left,tonumber(ARGV[4]))
            if n>0 then redis.call('HINCRBY',KEYS[1],'used',n) end
            return n
        "#).key(&s.key).arg(s.revision).arg(owner).arg(now_ms()).arg(n)
            .invoke_async(&mut self.db.clone()).await?;
        Ok(allowed.max(0) as usize)
    }
    pub async fn stream_token(
        &self,
        s: &Session,
        owner: &str,
        rate: u64,
        burst: u64,
    ) -> Result<bool> {
        let ok:i64=Script::new(r#"
            if redis.call('HGET',KEYS[1],'owner')~=ARGV[1]
              or redis.call('HGET',KEYS[1],'rev')~=ARGV[5]
              or redis.call('HGET',KEYS[1],'stopped')~='0' then return 0 end
            local now=tonumber(ARGV[2])
            if tonumber(redis.call('HGET',KEYS[1],'exp') or '0')<=now
              or tonumber(redis.call('HGET',KEYS[1],'lease_until') or '0')<=now
              or tonumber(redis.call('HGET',KEYS[1],'used') or '0')>=tonumber(redis.call('HGET',KEYS[1],'limit') or '0') then return 0 end
            local last=tonumber(redis.call('HGET',KEYS[1],'rate_time') or ARGV[2])
            local tokens=math.min(tonumber(ARGV[4]),tonumber(redis.call('HGET',KEYS[1],'rate_tokens') or ARGV[4])+(now-last)*tonumber(ARGV[3])/1000)
            if tokens<1 then return 0 end
            redis.call('HSET',KEYS[1],'rate_time',now,'rate_tokens',tokens-1)
            return 1
        "#).key(&s.key).arg(owner).arg(now_ms()).arg(rate).arg(burst).arg(s.revision).invoke_async(&mut self.db.clone()).await?;
        Ok(ok == 1)
    }
}
