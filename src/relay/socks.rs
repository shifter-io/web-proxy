//! Authenticated SOCKS5 (RFC 1928, RFC 1929) connection through the configured Shifter endpoint.
use crate::{State, store::Session};
use anyhow::{Result, anyhow, bail};
use std::net::{IpAddr, SocketAddr};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpStream,
};
use wisp_mux::packet::ConnectPacket;

#[derive(Debug)]
pub(super) struct UpstreamUnavailable;
impl std::fmt::Display for UpstreamUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("upstream unavailable")
    }
}
impl std::error::Error for UpstreamUnavailable {}

/// Opens the authenticated tunnel to `ip` and the packet's port for this session's country and SID.
pub(super) async fn connect(
    packet: &ConnectPacket,
    ip: IpAddr,
    state: &State,
    session: &Session,
) -> Result<TcpStream> {
    let user = state.cfg.username(&session.country, &session.sid)?;
    // This hostname is shared by every destination stream. Resolving it again
    // inside TcpStream::connect would still flood DNS despite destination caching.
    let upstream: Vec<_> = state
        .resolver
        .lookup(&state.cfg.upstream_host)
        .await?
        .into_iter()
        .map(|ip| SocketAddr::new(ip, state.cfg.upstream_port))
        .collect();
    let mut socket = TcpStream::connect(upstream.as_slice()).await?;
    socket.set_nodelay(true)?;
    handshake(
        &mut socket,
        &user,
        &state.cfg.password,
        SocketAddr::new(ip, packet.port),
    )
    .await?;
    Ok(socket)
}

/// Authenticates with username/password and requests `destination`, leaving `socket` positioned
/// right after the reply. Credentials over 255 bytes fail before any byte is written; reply codes
/// 1 and 3 to 6 fail with [`UpstreamUnavailable`].
///
/// Frozen invariant: I/O errors propagate with bare `?`, never `.context()`, because
/// [`transient`] must still see them as `std::io::Error`.
pub(super) async fn handshake<S: AsyncRead + AsyncWrite + Unpin>(
    socket: &mut S,
    user: &str,
    password: &str,
    destination: SocketAddr,
) -> Result<()> {
    let user_len = u8::try_from(user.len()).map_err(|_| anyhow!("SOCKS5 username too long"))?;
    let password_len =
        u8::try_from(password.len()).map_err(|_| anyhow!("SOCKS5 password too long"))?;
    // RFC 1928 + RFC 1929. All destination connections are opened through this authenticated tunnel.
    socket.write_all(&[5, 1, 2]).await?;
    let mut pair = [0; 2];
    socket.read_exact(&mut pair).await?;
    if pair != [5, 2] {
        bail!("upstream authentication method rejected");
    }
    let mut auth = Vec::with_capacity(3 + user.len() + password.len());
    auth.extend_from_slice(&[1, user_len]);
    auth.extend_from_slice(user.as_bytes());
    auth.push(password_len);
    auth.extend_from_slice(password.as_bytes());
    socket.write_all(&auth).await?;
    auth.fill(0);
    socket.read_exact(&mut pair).await?;
    if pair != [1, 0] {
        bail!("upstream authentication rejected");
    }
    let mut request = vec![5, 1, 0];
    match destination.ip() {
        IpAddr::V4(v) => {
            request.push(1);
            request.extend_from_slice(&v.octets());
        }
        IpAddr::V6(v) => {
            request.push(4);
            request.extend_from_slice(&v.octets());
        }
    }
    request.extend_from_slice(&destination.port().to_be_bytes());
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
        3 => usize::from(socket.read_u8().await?),
        _ => bail!("invalid upstream response"),
    };
    let mut ignored = vec![0; count + 2];
    socket.read_exact(&mut ignored).await?;
    Ok(())
}

/// Whether a timed connection attempt failed transiently: a timeout, an I/O error or
/// [`UpstreamUnavailable`]. Transient upstream failures may rotate the SID; destination policy
/// and DNS failures never reach this check.
pub(super) fn transient<T>(attempt: &Result<Result<T>, tokio::time::error::Elapsed>) -> bool {
    match attempt {
        Err(_) => true,
        Ok(Err(error)) => error.is::<std::io::Error>() || error.is::<UpstreamUnavailable>(),
        Ok(Ok(_)) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::DuplexStream;

    const USER: &str = "user-1";
    const PASSWORD: &str = "secret";
    const SENTINEL: u8 = 0xa5;

    fn destination() -> SocketAddr {
        "93.184.216.34:443".parse().unwrap()
    }

    async fn expect(server: &mut DuplexStream, bytes: &[u8]) {
        let mut got = vec![0; bytes.len()];
        server.read_exact(&mut got).await.unwrap();
        assert_eq!(got, bytes);
    }

    /// The RFC 1929 request the client must send for the test credentials.
    fn auth_request() -> Vec<u8> {
        let mut auth = vec![1, u8::try_from(USER.len()).unwrap()];
        auth.extend_from_slice(USER.as_bytes());
        auth.push(u8::try_from(PASSWORD.len()).unwrap());
        auth.extend_from_slice(PASSWORD.as_bytes());
        auth
    }

    /// Plays the greeting and authentication exchange, asserting every client byte.
    async fn authenticate(server: &mut DuplexStream) {
        expect(server, &[5, 1, 2]).await;
        server.write_all(&[5, 2]).await.unwrap();
        expect(server, &auth_request()).await;
        server.write_all(&[1, 0]).await.unwrap();
    }

    /// Runs `handshake` against `script` on the server end. On success returns the client end for
    /// further reads; on failure drops it first, so the script observes end of stream.
    async fn exchange<F, Fut>(destination: SocketAddr, script: F) -> Result<DuplexStream>
    where
        F: FnOnce(DuplexStream) -> Fut,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        let run = async {
            let (mut client, server) = tokio::io::duplex(4096);
            let server = tokio::spawn(script(server));
            let result = handshake(&mut client, USER, PASSWORD, destination).await;
            let client = result.map(|()| client);
            server.await.unwrap();
            client
        };
        tokio::time::timeout(Duration::from_secs(5), run)
            .await
            .unwrap()
    }

    /// Full exchange to the default destination with `reply` as the server's CONNECT reply.
    async fn reply_with(reply: Vec<u8>) -> Result<DuplexStream> {
        exchange(destination(), move |mut server| async move {
            authenticate(&mut server).await;
            expect(&mut server, &[5, 1, 0, 1, 93, 184, 216, 34, 1, 187]).await;
            server.write_all(&reply).await.unwrap();
        })
        .await
    }

    async fn assert_sentinel_next(mut client: DuplexStream) {
        assert_eq!(client.read_u8().await.unwrap(), SENTINEL);
    }

    fn not_transient(error: anyhow::Error) -> bool {
        !transient::<()>(&Ok(Err(error)))
    }

    #[tokio::test]
    async fn ipv4_success_consumes_exactly_the_reply() {
        let client = reply_with(vec![5, 0, 0, 1, 10, 0, 0, 1, 0x12, 0x34, SENTINEL])
            .await
            .unwrap();
        assert_sentinel_next(client).await;
    }

    #[tokio::test]
    async fn ipv6_destination_request() {
        let target: SocketAddr = "[2606:4700::1111]:80".parse().unwrap();
        let client = exchange(target, |mut server| async move {
            authenticate(&mut server).await;
            let mut request = vec![5, 1, 0, 4];
            let ip: std::net::Ipv6Addr = "2606:4700::1111".parse().unwrap();
            request.extend_from_slice(&ip.octets());
            request.extend_from_slice(&[0x00, 0x50]);
            expect(&mut server, &request).await;
            let mut reply = vec![5, 0, 0, 4];
            reply.extend_from_slice(&[0x20; 16]);
            reply.extend_from_slice(&[0, 80, SENTINEL]);
            server.write_all(&reply).await.unwrap();
        })
        .await
        .unwrap();
        assert_sentinel_next(client).await;
    }

    #[tokio::test]
    async fn domain_bound_address_is_consumed() {
        let mut reply = vec![5, 0, 0, 3, 11];
        reply.extend_from_slice(b"example.com");
        reply.extend_from_slice(&[1, 187, SENTINEL]);
        assert_sentinel_next(reply_with(reply).await.unwrap()).await;
    }

    #[tokio::test]
    async fn method_rejection_is_not_transient() {
        let result = exchange(destination(), |mut server| async move {
            expect(&mut server, &[5, 1, 2]).await;
            server.write_all(&[5, 0xff]).await.unwrap();
            // No authentication bytes follow; the client end is dropped instead.
            let mut rest = Vec::new();
            server.read_to_end(&mut rest).await.unwrap();
            assert!(rest.is_empty(), "{rest:?}");
        })
        .await;
        let error = result.unwrap_err();
        assert_eq!(error.to_string(), "upstream authentication method rejected");
        assert!(not_transient(error));
    }

    #[tokio::test]
    async fn credential_rejection_is_not_transient() {
        let result = exchange(destination(), |mut server| async move {
            expect(&mut server, &[5, 1, 2]).await;
            server.write_all(&[5, 2]).await.unwrap();
            expect(&mut server, &auth_request()).await;
            server.write_all(&[1, 1]).await.unwrap();
        })
        .await;
        let error = result.unwrap_err();
        assert_eq!(error.to_string(), "upstream authentication rejected");
        assert!(not_transient(error));
    }

    #[tokio::test]
    async fn unavailable_replies_are_transient() {
        for code in [1, 3, 4, 5, 6] {
            let error = reply_with(vec![5, code, 0, 1]).await.unwrap_err();
            assert!(error.is::<UpstreamUnavailable>(), "{code}: {error}");
            assert!(transient::<()>(&Ok(Err(error))), "{code}");
        }
    }

    #[tokio::test]
    async fn other_reply_failures_are_not_transient() {
        for (version, code) in [(5, 2), (5, 7), (5, 8), (4, 0)] {
            let error = reply_with(vec![version, code, 0, 1]).await.unwrap_err();
            assert!(!error.is::<UpstreamUnavailable>(), "{version}/{code}");
            assert_eq!(
                error.to_string(),
                format!("upstream destination unavailable (version {version}, reply {code})")
            );
            assert!(not_transient(error), "{version}/{code}");
        }
    }

    #[tokio::test]
    async fn invalid_address_type_is_rejected() {
        let error = reply_with(vec![5, 0, 0, 9]).await.unwrap_err();
        assert_eq!(error.to_string(), "invalid upstream response");
        assert!(not_transient(error));
    }

    #[tokio::test]
    async fn truncated_upstream_is_a_transient_io_error() {
        let result = exchange(destination(), |mut server| async move {
            expect(&mut server, &[5, 1, 2]).await;
            server.write_all(&[5]).await.unwrap();
        })
        .await;
        let error = result.unwrap_err();
        assert!(error.is::<std::io::Error>(), "{error}");
        assert!(transient::<()>(&Ok(Err(error))));
    }

    #[tokio::test]
    async fn overlong_credentials_fail_before_any_io() {
        let long = "x".repeat(256);
        for (user, password, message) in [
            (long.as_str(), PASSWORD, "SOCKS5 username too long"),
            (USER, long.as_str(), "SOCKS5 password too long"),
        ] {
            let (mut client, mut server) = tokio::io::duplex(4096);
            let error = handshake(&mut client, user, password, destination())
                .await
                .unwrap_err();
            assert_eq!(error.to_string(), message);
            drop(client);
            let mut sent = Vec::new();
            server.read_to_end(&mut sent).await.unwrap();
            assert!(sent.is_empty(), "{sent:?}");
        }
    }

    #[tokio::test]
    async fn timeout_and_success_classification() {
        let elapsed = tokio::time::timeout(Duration::ZERO, std::future::pending::<()>())
            .await
            .unwrap_err();
        assert!(transient::<()>(&Err(elapsed)));
        assert!(!transient(&Ok(Ok(()))));
    }
}
