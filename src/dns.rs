use std::{
    collections::HashMap,
    net::IpAddr,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, OnceCell};

const TTL: Duration = Duration::from_secs(30);
const CAPACITY: usize = 512;
type Answer = Arc<OnceCell<Vec<IpAddr>>>;

// Coalesce page bursts for the same hostname. Returned addresses still pass
// the caller's full destination policy and are pinned in the SOCKS request.
#[derive(Default)]
pub struct Resolver {
    entries: Mutex<HashMap<String, (Instant, Answer)>>,
}

impl Resolver {
    pub async fn lookup(&self, host: &str) -> std::io::Result<Vec<IpAddr>> {
        self.lookup_with(host, || async {
            // A transient local resolver failure must not discard a site's
            // critical module immediately. The caller's timeout covers both tries.
            for attempt in 0..2 {
                match tokio::net::lookup_host((host, 0)).await {
                    Ok(addresses) => return Ok(addresses.map(|a| a.ip()).collect()),
                    Err(error) if attempt == 1 => return Err(error),
                    Err(_) => tokio::time::sleep(Duration::from_millis(150)).await,
                }
            }
            unreachable!()
        })
        .await
    }

    async fn lookup_with<F, Fut>(&self, host: &str, lookup: F) -> std::io::Result<Vec<IpAddr>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = std::io::Result<Vec<IpAddr>>>,
    {
        let answer = {
            let mut entries = self.entries.lock().await;
            entries.retain(|_, (created, _)| created.elapsed() < TTL);
            if let Some((_, answer)) = entries.get(host) {
                answer.clone()
            } else {
                let answer = Arc::new(OnceCell::new());
                // At capacity, resolve without retaining another entry. Active
                // stream admission still bounds concurrent outstanding lookups.
                if entries.len() < CAPACITY {
                    entries.insert(host.to_owned(), (Instant::now(), answer.clone()));
                }
                answer
            }
        };
        answer.get_or_try_init(lookup).await.cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn burst_shares_one_lookup_and_expired_answers_are_refreshed() {
        let resolver = Resolver::default();
        let calls = AtomicUsize::new(0);
        let lookups = (0..64).map(|_| {
            resolver.lookup_with("fixture.test", || async {
                calls.fetch_add(1, Ordering::Relaxed);
                tokio::task::yield_now().await;
                Ok(vec!["1.1.1.1".parse().unwrap()])
            })
        });
        for result in futures_util::future::join_all(lookups).await {
            assert_eq!(result.unwrap(), vec!["1.1.1.1".parse::<IpAddr>().unwrap()]);
        }
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        resolver
            .entries
            .lock()
            .await
            .get_mut("fixture.test")
            .unwrap()
            .0 = Instant::now() - TTL;
        let refreshed = resolver
            .lookup_with("fixture.test", || async {
                Ok(vec!["8.8.8.8".parse().unwrap()])
            })
            .await
            .unwrap();
        assert_eq!(refreshed, vec!["8.8.8.8".parse::<IpAddr>().unwrap()]);
    }

    #[tokio::test]
    async fn failed_lookups_do_not_poison_cache_and_capacity_is_bounded() {
        let resolver = Resolver::default();
        assert!(
            resolver
                .lookup_with("fixture.test", || async {
                    Err(std::io::Error::other("temporary lookup failure"))
                })
                .await
                .is_err()
        );
        assert!(
            resolver
                .lookup_with("fixture.test", || async {
                    Ok(vec!["1.1.1.1".parse().unwrap()])
                })
                .await
                .is_ok()
        );
        for i in 0..CAPACITY + 10 {
            assert!(
                resolver
                    .lookup_with(&format!("{i}.test"), || async { Ok(vec![]) })
                    .await
                    .is_ok()
            );
        }
        assert_eq!(resolver.entries.lock().await.len(), CAPACITY);
    }
}
