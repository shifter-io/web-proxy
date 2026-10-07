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
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode},
    response::Response,
};
use bytes::Bytes;
use futures_util::{Sink, StreamExt};
use serde::Deserialize;
use std::{
    net::IpAddr,
    pin::Pin,
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpStream,
    sync::{Mutex, OwnedSemaphorePermit, Semaphore},
    task::JoinSet,
    time::timeout,
};
use tokio_util::{compat::FuturesAsyncReadCompatExt, sync::CancellationToken};
use wisp_mux::{
    ServerMux, WispError,
    packet::{CloseReason, ConnectPacket, StreamType},
    stream::MuxStream,
};

struct AxumTransport {
    socket: WebSocket,
    ping: tokio::time::Interval,
    flushing: bool,
}
impl futures_util::Stream for AxumTransport {
    type Item = Result<Bytes, WispError>;
    fn poll_next(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        use std::task::Poll;
        if self.flushing {
            match Pin::new(&mut self.socket).poll_flush(cx) {
                Poll::Ready(Ok(())) => self.flushing = false,
                Poll::Ready(Err(e)) => {
                    return Poll::Ready(Some(Err(WispError::WsImplError(Box::new(e)))));
                }
                Poll::Pending => return Poll::Pending,
            }
        }
        if self.ping.poll_tick(cx).is_ready()
            && let Poll::Ready(Ok(())) = Pin::new(&mut self.socket).poll_ready(cx)
        {
            if let Err(e) = Pin::new(&mut self.socket).start_send(Message::Ping(Bytes::new())) {
                return Poll::Ready(Some(Err(WispError::WsImplError(Box::new(e)))));
            }
            self.flushing = true;
            cx.waker().wake_by_ref();
        }
        loop {
            match Pin::new(&mut self.socket).poll_next(cx) {
                Poll::Ready(Some(Ok(Message::Binary(b)))) => return Poll::Ready(Some(Ok(b))),
                Poll::Ready(Some(Ok(Message::Close(_)))) | Poll::Ready(None) => {
                    return Poll::Ready(None);
                }
                Poll::Ready(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => continue,
                Poll::Ready(Some(Ok(_))) => {
                    return Poll::Ready(Some(Err(WispError::PacketTooSmall)));
                }
                Poll::Ready(Some(Err(e))) => {
                    return Poll::Ready(Some(Err(WispError::WsImplError(Box::new(e)))));
                }
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}
impl Sink<Bytes> for AxumTransport {
    type Error = WispError;
    fn poll_ready(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), Self::Error>> {
        Pin::new(&mut self.socket)
            .poll_ready(cx)
            .map_err(|e| WispError::WsImplError(Box::new(e)))
    }
    fn start_send(mut self: Pin<&mut Self>, b: Bytes) -> Result<(), Self::Error> {
        Pin::new(&mut self.socket)
            .start_send(Message::Binary(b))
            .map_err(|e| WispError::WsImplError(Box::new(e)))
    }
    fn poll_flush(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), Self::Error>> {
        Pin::new(&mut self.socket)
            .poll_flush(cx)
            .map_err(|e| WispError::WsImplError(Box::new(e)))
    }
    fn poll_close(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), Self::Error>> {
        Pin::new(&mut self.socket)
            .poll_close(cx)
            .map_err(|e| WispError::WsImplError(Box::new(e)))
    }
}
type WsSink = futures_util::stream::SplitSink<AxumTransport, Bytes>;

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
    let (write, read) = AxumTransport {
        socket,
        ping: tokio::time::interval(Duration::from_secs(3)),
        flushing: false,
    }
    .split();
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
                    let connection_owner=owner.clone(); let stopped=cancel.clone();
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
                            _=forward(packet,stream,s.clone(),context,connection_owner,stopped.clone())=>{},
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

/// Only globally routable destinations, including rejecting mapped IPv4 and translation ranges.
pub fn public_ip(ip: IpAddr) -> bool {
    let blocked: &[&str] = match ip {
        IpAddr::V4(_) => &[
            "0.0.0.0/8",
            "10.0.0.0/8",
            "100.64.0.0/10",
            "127.0.0.0/8",
            "169.254.0.0/16",
            "172.16.0.0/12",
            "192.0.0.0/24",
            "192.0.2.0/24",
            "192.88.99.0/24",
            "192.168.0.0/16",
            "198.18.0.0/15",
            "198.51.100.0/24",
            "203.0.113.0/24",
            "224.0.0.0/4",
            "240.0.0.0/4",
        ],
        IpAddr::V6(_) => &[
            "::/96",
            "::ffff:0:0/96",
            "64:ff9b::/96",
            "64:ff9b:1::/48",
            "100::/64",
            "2001::/23",
            "2001:db8::/32",
            "2002::/16",
            "3fff::/20",
            "fc00::/7",
            "fe80::/10",
            "ff00::/8",
        ],
    };
    if let IpAddr::V6(v) = ip
        && (v.segments()[0] & 0xe000) != 0x2000
    {
        return false;
    }
    !blocked
        .iter()
        .any(|cidr| cidr.parse::<ipnet::IpNet>().unwrap().contains(&ip))
}
async fn resolve(packet: &ConnectPacket, state: &State) -> Result<IpAddr> {
    if ![80, 443].contains(&packet.port) {
        bail!("port blocked");
    }
    let host = packet.host.trim_end_matches('.').to_ascii_lowercase();
    // Reserved fixture destinations never resolve or connect directly. Only the mock proxy sees them.
    if state.cfg.test_mode && (host == "fixture.test" || host == "second.test") {
        return Ok("203.0.113.10".parse()?);
    }
    if state.cfg.test_mode && host == "failed-upstream.test" {
        return Ok("203.0.113.11".parse()?);
    }
    if host.len() > 253
        || host.is_empty()
        || host
            .bytes()
            .any(|c| !c.is_ascii_alphanumeric() && !b".-:".contains(&c))
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host == "shifter.io"
        || host.ends_with(".shifter.io")
    {
        bail!("host blocked");
    }
    let addresses = state.resolver.lookup(&host).await?;
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|x| !public_ip(*x) || state.cfg.upstream_ips.contains(x))
    {
        bail!("address blocked");
    }
    addresses
        .iter()
        .find(|x| x.is_ipv4())
        .or(addresses.first())
        .copied()
        .ok_or_else(|| anyhow::anyhow!("no address"))
}
#[derive(Debug)]
struct UpstreamUnavailable;
impl std::fmt::Display for UpstreamUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("upstream unavailable")
    }
}
impl std::error::Error for UpstreamUnavailable {}

async fn connect(
    packet: &ConnectPacket,
    ip: IpAddr,
    state: &State,
    session: &Session,
) -> Result<TcpStream> {
    let user = state.cfg.username(&session.country, &session.sid)?;
    let mut socket =
        TcpStream::connect((state.cfg.upstream_host.as_str(), state.cfg.upstream_port)).await?;
    socket.set_nodelay(true)?;
    // RFC 1928 + RFC 1929. All destination connections are opened through this authenticated tunnel.
    socket.write_all(&[5, 1, 2]).await?;
    let mut pair = [0; 2];
    socket.read_exact(&mut pair).await?;
    if pair != [5, 2] {
        bail!("upstream authentication method rejected");
    }
    let mut auth = Vec::with_capacity(3 + user.len() + state.cfg.password.len());
    auth.extend_from_slice(&[1, user.len() as u8]);
    auth.extend_from_slice(user.as_bytes());
    auth.push(state.cfg.password.len() as u8);
    auth.extend_from_slice(state.cfg.password.as_bytes());
    socket.write_all(&auth).await?;
    auth.fill(0);
    socket.read_exact(&mut pair).await?;
    if pair != [1, 0] {
        bail!("upstream authentication rejected");
    }
    let mut request = vec![5, 1, 0];
    match ip {
        IpAddr::V4(v) => {
            request.push(1);
            request.extend_from_slice(&v.octets());
        }
        IpAddr::V6(v) => {
            request.push(4);
            request.extend_from_slice(&v.octets());
        }
    }
    request.extend_from_slice(&packet.port.to_be_bytes());
    socket.write_all(&request).await?;
    let mut reply = [0; 4];
    socket.read_exact(&mut reply).await?;
    if reply[0] != 5 || reply[1] != 0 {
        if reply[0] == 5 && matches!(reply[1], 1 | 3 | 4 | 5 | 6) {
            return Err(UpstreamUnavailable.into());
        }
        bail!(
            "upstream destination unavailable (version {}, reply {})",
            reply[0],
            reply[1]
        );
    }
    let count = match reply[3] {
        1 => 4,
        4 => 16,
        3 => socket.read_u8().await? as usize,
        _ => bail!("invalid upstream response"),
    };
    let mut ignored = vec![0; count + 2];
    socket.read_exact(&mut ignored).await?;
    Ok(socket)
}
async fn forward(
    packet: ConnectPacket,
    stream: MuxStream<WsSink>,
    state: State,
    s: Session,
    owner: String,
    cancel: CancellationToken,
) {
    let closer = stream.get_close_handle();
    // DNS/policy failures are destination failures, never grounds for SID rotation.
    let ip = match timeout(
        Duration::from_secs(state.cfg.connect_timeout),
        resolve(&packet, &state),
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
        connect(&packet, ip, &state, &s),
    )
    .await;
    let tcp = match connection {
        Ok(Ok(tcp)) => tcp,
        failure => {
            tracing::debug!(?failure, "Upstream connection failed before forwarding");
            let transient = match failure {
                Err(_) => true,
                Ok(Err(error)) => error.is::<std::io::Error>() || error.is::<UpstreamUnavailable>(),
                _ => false,
            };
            if transient
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
    tokio::select! { _=up=>{},_=down=>{},_=idle=>{} }
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
    last: Arc<std::sync::atomic::AtomicU64>,
    cancel: CancellationToken,
) -> Result<()> {
    let mut buf = [0u8; 16 * 1024];
    loop {
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            return Ok(());
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

    #[test]
    fn destination_policy() {
        for s in [
            "127.0.0.1",
            "10.2.3.4",
            "100.64.0.1",
            "169.254.169.254",
            "192.168.1.1",
            "198.18.0.1",
            "203.0.113.1",
            "224.0.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "64:ff9b::7f00:1",
            "fd00::1",
            "fe80::1",
            "2001:db8::1",
        ] {
            assert!(!public_ip(s.parse().unwrap()), "{s}");
        }
        for s in ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"] {
            assert!(public_ip(s.parse().unwrap()), "{s}");
        }
    }
}
