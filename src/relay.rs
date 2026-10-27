use crate::{
    State,
    api::ApiError,
    config::{is_id, now_ms, random_id},
    store::Session,
};
use anyhow::{Result, bail};
use axum::{
    extract::{
        Query, State as AxumState,
        ws::{WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode},
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::{
    pin::Pin,
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::{Mutex, Notify, OwnedSemaphorePermit, Semaphore},
    task::JoinSet,
    time::timeout,
};
use tokio_util::{compat::FuturesAsyncReadCompatExt, sync::CancellationToken};
use wisp_mux::{
    ServerMux, WispError,
    packet::{CloseReason, ConnectPacket, StreamType},
    stream::MuxStream,
};

mod policy;
mod socks;
mod transport;

use transport::{AxumTransport, WsSink};

// Transport flood protection is deliberately separate from upstream admission:
// a normal page may burst well beyond its sustained connection rate.
const CONNECT_FLOOD_LIMIT: u32 = 256;
const CONNECT_BACKLOG_LIMIT: usize = 256;
const ADMISSION_WAIT: Duration = Duration::from_secs(20);

async fn admit_stream<F, Fut>(
    permits: Arc<Semaphore>,
    rate_gate: &Mutex<()>,
    rate: u64,
    mut token: F,
) -> Result<OwnedSemaphorePermit>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<bool>>,
{
    let permit = permits.acquire_owned().await?;
    // Serialize token waits instead of polling Redis once per queued stream.
    let _rate_guard = rate_gate.lock().await;
    while !token().await? {
        tokio::time::sleep(Duration::from_millis(1000u64.div_ceil(rate))).await;
    }
    Ok(permit)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ticket {
    ticket: String,
}
pub async fn upgrade_path(
    state: AxumState<State>,
    headers: HeaderMap,
    axum::extract::Path(ticket): axum::extract::Path<String>,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    upgrade(state, headers, Query(Ticket { ticket }), ws).await
}
pub async fn upgrade(
    AxumState(state): AxumState<State>,
    headers: HeaderMap,
    Query(q): Query<Ticket>,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    if headers.get("origin").and_then(|x| x.to_str().ok())
        != Some(state.cfg.runtime_origin.as_str())
        || !is_id(&q.ticket)
    {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Invalid transport authorization",
        ));
    }
    let owner = random_id();
    let session = state.store.claim(&q.ticket, &owner).await.map_err(|_| {
        ApiError(
            StatusCode::UNAUTHORIZED,
            "Ticket expired, used, or session already connected",
        )
    })?;
    if session.region != state.cfg.region {
        state.store.release(&session, &owner).await;
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Session belongs to another region",
        ));
    }
    state.metrics.accepted.fetch_add(1, Ordering::Relaxed);
    Ok(ws
        .max_frame_size(65541)
        .max_message_size(65541)
        .on_upgrade(move |socket| run(socket, state, session, owner)))
}

async fn run(socket: WebSocket, state: State, session: Session, owner: String) {
    state.metrics.connections.fetch_add(1, Ordering::Relaxed);
    let (write, read) = AxumTransport::new(socket, Duration::from_secs(3)).split();
    // Bound malformed/CONNECT floods before the library's unbounded stream admission queue.
    let mut frame_window = Instant::now();
    let mut connects = 0u32;
    let backlog = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let incoming_backlog = backlog.clone();
    let read = Box::pin(read.filter_map(move |item| {
        let out = match item {
            Ok(b) => {
                if frame_window.elapsed() >= Duration::from_secs(1) {
                    frame_window = Instant::now();
                    connects = 0;
                }
                if b.first() == Some(&1) {
                    connects += 1;
                    incoming_backlog.fetch_add(1, Ordering::Relaxed);
                }
                if connects > CONNECT_FLOOD_LIMIT
                    || incoming_backlog.load(Ordering::Relaxed) > CONNECT_BACKLOG_LIMIT
                {
                    Some(Err(WispError::MaxStreamCountReached))
                } else {
                    Some(Ok(b))
                }
            }
            Err(e) => Some(Err(e)),
        };
        futures_util::future::ready(out)
    }));
    let result = ServerMux::new(read, write, 4, None).await;
    if let Ok(result) = result {
        let (mux, driver) = result.with_no_required_extensions();
        let mut driver = tokio::spawn(driver);
        let cancel = CancellationToken::new();
        let flush = Arc::new(Notify::new());
        let permits = Arc::new(Semaphore::new(state.cfg.max_streams));
        let pending = Arc::new(Semaphore::new(state.cfg.max_streams * 2));
        let rate_gate = Arc::new(Mutex::new(()));
        let mut streams = JoinSet::new();
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        loop {
            tokio::select! {
                _=&mut driver=>break,
                _=tick.tick()=>{
                    if !state.store.heartbeat(&session,&owner).await.unwrap_or(false) { break; }
                },
                _=cancel.cancelled()=>break,
                _=flush.notified()=>{
                    // The pinned Wisp reader queues CONTINUE with start_send
                    // without flushing. SplitSink retains it until another
                    // write, deadlocking uploads that await renewed credits.
                    let sent=timeout(Duration::from_secs(5),async {
                        let mut writer=mux.lock_ws().await?;
                        writer.flush().await
                    }).await;
                    if !matches!(sent,Ok(Ok(()))) { break; }
                },
                Some(_)=streams.join_next(),if !streams.is_empty()=>{},
                incoming=mux.wait_for_stream()=>{
                    let Some((packet,stream))=incoming else {break};
                    backlog.fetch_sub(1,Ordering::Relaxed);
                    let queued=pending.clone().try_acquire_owned();
                    if packet.stream_type!=StreamType::Tcp || queued.is_err() {
                        state.metrics.rejected.fetch_add(1,Ordering::Relaxed);
                        let _=timeout(Duration::from_secs(1),stream.close(CloseReason::ServerStreamThrottled)).await;
                        continue;
                    }
                    let queued=queued.unwrap(); let s=state.clone(); let context=session.clone();
                    let permits=permits.clone(); let rate_gate=rate_gate.clone();
                    let connection_owner=owner.clone(); let stopped=cancel.clone(); let flush=flush.clone();
                    streams.spawn(async move {
                        let admission=tokio::select! {
                            _=stopped.cancelled()=>return,
                            result=timeout(ADMISSION_WAIT,admit_stream(permits,&rate_gate,s.cfg.stream_rate,
                                || s.store.stream_token(&context,&connection_owner,s.cfg.stream_rate,s.cfg.stream_burst)))=>result,
                        };
                        let _slot = queued;
                        let _permit=match admission {
                            Ok(Ok(permit))=>permit,
                            failure=>{
                                if matches!(failure,Ok(Err(_))) { stopped.cancel(); }
                                s.metrics.rejected.fetch_add(1,Ordering::Relaxed);
                                let _=timeout(Duration::from_secs(1),stream.close(CloseReason::ServerStreamThrottled)).await;
                                return;
                            }
                        };
                        if stream.get_close_reason().is_some() { return; }
                        s.metrics.streams.fetch_add(1,Ordering::Relaxed);
                        tokio::select! {
                            _=stopped.cancelled()=>{},
                            _=forward(packet,stream,s.clone(),context,connection_owner,stopped.clone(),flush)=>{},
                        }
                        s.metrics.streams.fetch_sub(1,Ordering::Relaxed);
                    });
                }
            }
        }
        cancel.cancel();
        let _ = timeout(
            Duration::from_secs(1),
            mux.close_with_reason(CloseReason::Voluntary),
        )
        .await;
        while streams.join_next().await.is_some() {}
        driver.abort();
    }
    state.store.release(&session, &owner).await;
    state.metrics.connections.fetch_sub(1, Ordering::Relaxed);
}

async fn forward(
    packet: ConnectPacket,
    stream: MuxStream<WsSink>,
    state: State,
    s: Session,
    owner: String,
    cancel: CancellationToken,
    flush: Arc<Notify>,
) {
    let closer = stream.get_close_handle();
    // DNS/policy failures are destination failures, never grounds for SID rotation.
    let ip = match timeout(
        Duration::from_secs(state.cfg.connect_timeout),
        policy::resolve(&packet, &state),
    )
    .await
    {
        Ok(Ok(ip)) => ip,
        failure => {
            tracing::debug!(?failure, "Destination lookup or policy rejected stream");
            state.metrics.rejected.fetch_add(1, Ordering::Relaxed);
            let _ = timeout(
                Duration::from_secs(1),
                closer.close(CloseReason::ServerStreamUnreachable),
            )
            .await;
            return;
        }
    };
    let connection = timeout(
        Duration::from_secs(state.cfg.connect_timeout),
        socks::connect(&packet, ip, &state, &s),
    )
    .await;
    let tcp = match connection {
        Ok(Ok(tcp)) => tcp,
        failure => {
            tracing::debug!(?failure, "Upstream connection failed before forwarding");
            if socks::transient(&failure)
                && state
                    .store
                    .upstream_failed(&s, &owner, &packet.host)
                    .await
                    .is_err()
            {
                // Storage failures stop this transport; no unaccounted fallback.
                cancel.cancel();
            }
            state.metrics.rejected.fetch_add(1, Ordering::Relaxed);
            let _ = timeout(
                Duration::from_secs(1),
                closer.close(CloseReason::ServerStreamUnreachable),
            )
            .await;
            return;
        }
    };
    let (mut input, mut output) = tokio::io::split(stream.into_async_rw().compat());
    let (mut from_site, mut to_site) = tcp.into_split();
    let last = Arc::new(std::sync::atomic::AtomicU64::new(now_ms()));
    let up: Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + '_>> =
        Box::pin(copy_charged(
            &mut input,
            &mut to_site,
            &state,
            &s,
            &owner,
            true,
            Some(&flush),
            last.clone(),
            cancel.clone(),
        ));
    let down: Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + '_>> =
        Box::pin(copy_charged(
            &mut from_site,
            &mut output,
            &state,
            &s,
            &owner,
            false,
            None,
            last.clone(),
            cancel.clone(),
        ));
    let idle = async {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            if now_ms().saturating_sub(last.load(Ordering::Relaxed))
                >= state.cfg.idle_timeout * 1000
            {
                break;
            }
        }
    };
    tokio::select! {
        result=up=>{tracing::debug!(direction="upload", error=?result.err(), "Destination forwarding ended");},
        result=down=>{tracing::debug!(direction="download", error=?result.err(), "Destination forwarding ended");},
        _=idle=>{tracing::debug!("Destination stream idle timeout");}
    }
    let _ = timeout(Duration::from_secs(1), closer.close(CloseReason::Voluntary)).await;
}
#[allow(clippy::too_many_arguments)]
async fn copy_charged<R: AsyncRead + Unpin + Send, W: AsyncWrite + Unpin + Send>(
    reader: &mut R,
    writer: &mut W,
    state: &State,
    s: &Session,
    owner: &str,
    up: bool,
    flush: Option<&Notify>,
    last: Arc<std::sync::atomic::AtomicU64>,
    cancel: CancellationToken,
) -> Result<()> {
    let mut buf = [0u8; 16 * 1024];
    loop {
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            return Ok(());
        }
        if let Some(flush) = flush {
            flush.notify_one();
        }
        let allowed = match state.store.charge(s, owner, n).await {
            Ok(n) => n,
            Err(e) => {
                cancel.cancel();
                return Err(e);
            }
        };
        if allowed == 0 {
            cancel.cancel();
            bail!("allowance ended");
        }
        writer.write_all(&buf[..allowed]).await?;
        writer.flush().await?;
        last.store(now_ms(), Ordering::Relaxed);
        let metric = if up {
            &state.metrics.bytes_up
        } else {
            &state.metrics.bytes_down
        };
        metric.fetch_add(allowed as u64, Ordering::Relaxed);
        if allowed < n {
            cancel.cancel();
            bail!("allowance ended");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn admission_waits_for_capacity_and_rate_without_exceeding_cap() {
        let permits = Arc::new(Semaphore::new(1));
        let held = permits.clone().acquire_owned().await.unwrap();
        let gate = Mutex::new(());
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let admission = admit_stream(permits.clone(), &gate, 1000, || {
            futures_util::future::ready(Ok(calls.fetch_add(1, Ordering::Relaxed) > 0))
        });
        tokio::pin!(admission);
        assert!(
            timeout(Duration::from_millis(10), &mut admission)
                .await
                .is_err()
        );
        assert_eq!(calls.load(Ordering::Relaxed), 0);
        drop(held);
        let admitted = timeout(Duration::from_secs(1), admission)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(calls.load(Ordering::Relaxed), 2);
        assert_eq!(permits.available_permits(), 0);
        drop(admitted);
        assert_eq!(permits.available_permits(), 1);
    }

    #[tokio::test]
    async fn admission_storage_failure_and_timeout_release_capacity() {
        let permits = Arc::new(Semaphore::new(1));
        let gate = Mutex::new(());
        assert!(
            admit_stream(permits.clone(), &gate, 32, || async {
                anyhow::bail!("storage unavailable")
            })
            .await
            .is_err()
        );
        assert_eq!(permits.available_permits(), 1);
        assert!(
            timeout(
                Duration::from_millis(10),
                admit_stream(permits.clone(), &gate, 32, || async { Ok(false) })
            )
            .await
            .is_err()
        );
        assert_eq!(permits.available_permits(), 1);
    }
}
