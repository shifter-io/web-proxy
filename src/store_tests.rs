//! Real Redis tests. Run with REDIS_TEST_URL pointing to a disposable private instance
//! and `cargo test -- --include-ignored`; ordinary unit runs do not require Redis.
use super::*;

async fn fixture() -> Result<(Store, Config, String, Session)> {
    let url = std::env::var("REDIS_TEST_URL")?;
    let store = Store::new(&url, None).await?;
    let cfg = Config::load().await?;
    assert_eq!(cfg.duration_ms, 86_400_000);
    assert_eq!(cfg.byte_limit, 10_000_000_000);
    let visitor = random_id();
    let session = store.start(&visitor, "us", &cfg).await?;
    Ok((store, cfg, visitor, session))
}

async fn fields(store: &Store, key: &str, values: &[(&str, u64)]) -> Result<()> {
    let _: () = store.db.clone().hset_multiple(key, values).await?;
    Ok(())
}

async fn connected(store: &Store, session: &Session) -> Result<Session> {
    store.claim(&store.ticket(session).await?, "owner").await
}

#[tokio::test]
#[ignore = "requires isolated REDIS_TEST_URL"]
async fn initial_allowance_and_resume_preserve_budget() -> Result<()> {
    let (store, cfg, visitor, session) = fixture().await?;
    assert!(session.auto_renew);
    assert_eq!(session.limit, 10_000_000_000);
    assert!((86_399_000..=86_400_000).contains(&(session.expires_at - now_ms())));
    assert_eq!(session.public()["autoRenew"], true);
    let live = connected(&store, &session).await?;
    assert_eq!(
        store.charge(&live, "owner", 5_000_000_000).await?,
        5_000_000_000
    );
    store.change(&live, None).await?;
    assert!(!store.heartbeat(&live, "owner").await?);
    let resumed = store.start(&visitor, "de", &cfg).await?;
    assert_eq!(resumed.country, "de");
    assert_eq!(resumed.used, 5_000_000_000);
    assert_eq!(resumed.expires_at, session.expires_at);
    assert_ne!(resumed.sid, session.sid);
    assert_eq!(store.charge(&live, "owner", 1).await?, 0);
    Ok(())
}

#[tokio::test]
#[ignore = "requires isolated REDIS_TEST_URL"]
async fn concurrent_boundary_charges_renew_once_and_keep_transport() -> Result<()> {
    let (store, _, _, session) = fixture().await?;
    let live = connected(&store, &session).await?;
    let boundary = now_ms() - 1;
    fields(
        &store,
        &live.key,
        &[("exp", boundary), ("used", live.limit)],
    )
    .await?;
    let tasks = (0..32).map(|_| store.charge(&live, "owner", 100));
    let results = futures_util::future::join_all(tasks).await;
    for result in results {
        assert_eq!(result?, 100);
    }
    let renewed = store.get(&live.key).await?.unwrap();
    assert_eq!(renewed.used, 3200);
    assert_eq!(renewed.expires_at, boundary + 86_400_000);
    assert_eq!(renewed.sid, live.sid);
    assert_eq!(renewed.revision, live.revision);
    assert!(renewed.connected);
    assert!(store.heartbeat(&live, "owner").await?);
    assert!(store.stream_token(&live, "owner", 32, 64).await?);
    assert!(
        store
            .claim(&store.ticket(&renewed).await?, "other")
            .await
            .is_err()
    );
    Ok(())
}

#[tokio::test]
#[ignore = "requires isolated REDIS_TEST_URL"]
async fn quota_is_exact_above_32_bits_and_renews_after_exhaustion() -> Result<()> {
    let (store, _, _, session) = fixture().await?;
    let live = connected(&store, &session).await?;
    fields(&store, &live.key, &[("used", 9_999_999_999)]).await?;
    let (a, b) = tokio::join!(
        store.charge(&live, "owner", 100),
        store.charge(&live, "owner", 100)
    );
    assert_eq!(a? + b?, 1);
    let exhausted = store.get(&live.key).await?.unwrap();
    assert_eq!(exhausted.used, exhausted.limit);
    assert_eq!(exhausted.public()["status"], "exhausted");
    assert!(store.ticket(&exhausted).await.is_err());
    assert!(!store.heartbeat(&live, "owner").await?);
    assert!(!store.stream_token(&live, "owner", 32, 64).await?);
    fields(&store, &live.key, &[("exp", now_ms() - 1)]).await?;
    assert!(store.heartbeat(&live, "owner").await?);
    assert_eq!(store.get(&live.key).await?.unwrap().used, 0);
    Ok(())
}

#[tokio::test]
#[ignore = "requires isolated REDIS_TEST_URL"]
async fn stopped_and_stale_owners_never_gain_access_on_renewal() -> Result<()> {
    let (store, _, _, session) = fixture().await?;
    let live = connected(&store, &session).await?;
    fields(&store, &live.key, &[("exp", now_ms() - 1)]).await?;
    assert_eq!(store.charge(&live, "other", 1).await?, 0);
    assert!(!store.heartbeat(&live, "other").await?);
    assert!(!store.stream_token(&live, "other", 32, 64).await?);
    store.change(&live, None).await?;
    let stopped = store.get(&live.key).await?.unwrap();
    assert_eq!(stopped.public()["status"], "stopped");
    assert!(!stopped.active());
    assert_eq!(store.charge(&live, "owner", 1).await?, 0);
    assert!(!store.heartbeat(&live, "owner").await?);
    assert!(!store.stream_token(&live, "owner", 32, 64).await?);
    assert!(
        !store
            .recover(&stopped, stopped.revision, "example.com", false)
            .await?
    );
    Ok(())
}

#[tokio::test]
#[ignore = "requires isolated REDIS_TEST_URL"]
async fn reads_skip_elapsed_periods_without_shifting_the_anchor() -> Result<()> {
    let (store, _, _, session) = fixture().await?;
    let boundary = now_ms() - 2 * 86_400_000 - 10;
    fields(&store, &session.key, &[("exp", boundary), ("used", 500)]).await?;
    let renewed = store.get(&session.key).await?.unwrap();
    assert_eq!(renewed.expires_at, boundary + 3 * 86_400_000);
    assert_eq!(renewed.used, 0);
    assert_eq!(renewed.sid, session.sid);
    let ttl: i64 = store.db.clone().pttl(&session.key).await?;
    assert!(ttl > 30 * 86_400_000);
    assert!(store.get(&Store::key(&random_id())).await?.is_none());
    Ok(())
}

#[tokio::test]
#[ignore = "requires isolated REDIS_TEST_URL"]
async fn tickets_stream_admission_and_recovery_cross_the_boundary() -> Result<()> {
    let (store, _, _, session) = fixture().await?;
    let ticket = store.ticket(&session).await?;
    fields(
        &store,
        &session.key,
        &[("exp", now_ms() - 1), ("used", session.limit)],
    )
    .await?;
    let live = store.claim(&ticket, "owner").await?;
    assert!(store.claim(&ticket, "other").await.is_err());
    fields(
        &store,
        &live.key,
        &[("exp", now_ms() - 1), ("used", live.limit)],
    )
    .await?;
    assert!(store.stream_token(&live, "owner", 32, 64).await?);
    fields(
        &store,
        &live.key,
        &[("exp", now_ms() - 1), ("used", live.limit)],
    )
    .await?;
    assert!(
        store
            .recover(&live, live.revision, "example.com", false)
            .await?
    );
    assert_eq!(store.charge(&live, "owner", 1).await?, 0);
    assert!(!store.heartbeat(&live, "owner").await?);
    assert!(!store.stream_token(&live, "owner", 32, 64).await?);
    assert!(
        !store
            .recover(&live, live.revision, "example.com", false)
            .await?
    );
    Ok(())
}

#[tokio::test]
#[ignore = "requires isolated REDIS_TEST_URL"]
async fn stale_lease_and_legacy_expiry_still_deny_forwarding() -> Result<()> {
    let (store, _, _, session) = fixture().await?;
    let live = connected(&store, &session).await?;
    fields(
        &store,
        &live.key,
        &[("lease_until", now_ms() - 1), ("exp", now_ms() - 1)],
    )
    .await?;
    assert_eq!(store.charge(&live, "owner", 1).await?, 0);
    assert!(!store.heartbeat(&live, "owner").await?);
    assert!(!store.stream_token(&live, "owner", 32, 64).await?);
    fields(&store, &live.key, &[("period", 0), ("exp", now_ms() - 1)]).await?;
    let expired = store.get(&live.key).await?.unwrap();
    assert!(!expired.auto_renew);
    assert_eq!(expired.public()["status"], "expired");
    assert!(
        !store
            .recover(&expired, expired.revision, "example.com", false)
            .await?
    );
    Ok(())
}

#[tokio::test]
#[ignore = "requires isolated REDIS_TEST_URL"]
async fn migration_preserves_usage_and_stop_and_revokes_legacy_tickets() -> Result<()> {
    let (store, cfg, _, _) = fixture().await?;
    for stopped in [false, true] {
        let visitor = random_id();
        let legacy_key = format!("daily:{visitor}:{}", now_ms() / 86_400_000);
        let _: () = store
            .db
            .clone()
            .hset_multiple(
                &legacy_key,
                &[
                    ("country", "de"),
                    ("sid", "legacy"),
                    ("region", "blr"),
                    ("used", "500"),
                    ("limit", "104857600"),
                    ("rev", "2"),
                    ("stopped", if stopped { "1" } else { "0" }),
                ],
            )
            .await?;
        fields(&store, &legacy_key, &[("exp", now_ms() + 60_000)]).await?;
        let legacy = store.get(&legacy_key).await?.unwrap();
        let ticket = if stopped {
            None
        } else {
            Some(store.ticket(&legacy).await?)
        };
        let (a, b) = tokio::join!(store.current(&visitor, &cfg), store.current(&visitor, &cfg));
        let upgraded = a?.unwrap();
        assert_eq!(b?.unwrap().expires_at, upgraded.expires_at);
        assert_eq!(upgraded.used, 500);
        assert_eq!(upgraded.limit, 10_000_000_000);
        assert_eq!(upgraded.stopped, stopped);
        assert_eq!(upgraded.country, "de");
        assert_eq!(upgraded.sid, "legacy");
        assert!(!upgraded.connected);
        assert!(upgraded.auto_renew);
        assert!(store.get(&legacy_key).await?.unwrap().stopped);
        if let Some(ticket) = ticket {
            assert!(store.claim(&ticket, "owner").await.is_err());
        }
        fields(&store, &upgraded.key, &[("used", 600)]).await?;
        assert_eq!(store.current(&visitor, &cfg).await?.unwrap().used, 600);
    }
    Ok(())
}

#[tokio::test]
#[ignore = "requires isolated REDIS_TEST_URL"]
async fn identity_activity_extends_management_without_resetting_quota() -> Result<()> {
    let (store, _, _, session) = fixture().await?;
    let identity = format!("identity:{}", random_id());
    let _: () = store.db.clone().set_ex(&identity, "verified", 30).await?;
    assert!(store.bind_identity(&session, &identity).await?);
    let live = connected(&store, &session).await?;
    assert_eq!(store.charge(&live, "owner", 123).await?, 123);
    let _: bool = store.db.clone().pexpire(&identity, 1000).await?;
    assert!(store.heartbeat(&live, "owner").await?);
    let ttl: i64 = store.db.clone().pttl(&identity).await?;
    assert!(ttl > 29 * 86_400_000);
    let _: bool = store.db.clone().pexpire(&identity, 1000).await?;
    let current = store.get(&live.key).await?.unwrap();
    assert_eq!(current.used, 123);
    assert_eq!(current.expires_at, session.expires_at);
    let ttl: i64 = store.db.clone().pttl(&identity).await?;
    assert!(ttl > 29 * 86_400_000);
    assert!(
        store
            .recover(&current, current.revision, "example.com", false)
            .await?
    );
    store.change(&current, None).await?;
    assert!(!store.heartbeat(&current, "owner").await?);
    Ok(())
}

#[tokio::test]
#[ignore = "requires isolated REDIS_TEST_URL"]
async fn lost_identity_revokes_all_gateway_paths_and_is_never_recreated() -> Result<()> {
    for action in 0..5 {
        let (store, _, _, session) = fixture().await?;
        let identity = format!("identity:{}", random_id());
        assert!(!store.bind_identity(&session, &identity).await?);
        let _: () = store.db.clone().set_ex(&identity, "verified", 30).await?;
        assert!(store.bind_identity(&session, &identity).await?);
        let ticket = store.ticket(&session).await?;
        let live = connected(&store, &session).await?;
        let _: bool = store.db.clone().pexpire(&identity, 1).await?;
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        fields(&store, &live.key, &[("exp", now_ms() - 1), ("used", 123)]).await?;
        match action {
            0 => assert_eq!(store.charge(&live, "owner", 1).await?, 0),
            1 => assert!(!store.heartbeat(&live, "owner").await?),
            2 => assert!(!store.stream_token(&live, "owner", 32, 64).await?),
            3 => assert!(store.claim(&ticket, "other").await.is_err()),
            _ => assert!(
                !store
                    .recover(&live, live.revision, "example.com", false)
                    .await?
            ),
        }
        assert!(!store.bind_identity(&live, &identity).await?);
        let stopped = store.get(&live.key).await?.unwrap();
        assert!(stopped.stopped);
        assert_eq!(stopped.used, 123);
        assert!(stopped.revision > live.revision);
        let exists: bool = store.db.clone().exists(&identity).await?;
        assert!(!exists);
    }
    Ok(())
}

#[tokio::test]
#[ignore = "requires isolated REDIS_TEST_URL"]
async fn identity_expiry_revokes_renewed_forwarding() -> Result<()> {
    let (store, _, _, session) = fixture().await?;
    let identity = format!("identity:{}", random_id());
    let _: () = store.db.clone().set_ex(&identity, "verified", 30).await?;
    let _: () = store
        .db
        .clone()
        .hset(&session.key, "identity", &identity)
        .await?;
    let live = connected(&store, &session).await?;
    let _: bool = store.db.clone().pexpire(&identity, 1).await?;
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    fields(&store, &live.key, &[("exp", now_ms() - 1), ("used", 123)]).await?;
    assert_eq!(store.charge(&live, "owner", 1).await?, 0);
    assert!(store.get(&live.key).await?.unwrap().stopped);
    Ok(())
}
