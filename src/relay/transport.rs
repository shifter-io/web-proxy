//! WebSocket transport for the Wisp mux: binary frames only, periodic pings, explicit flushes.
use axum::extract::ws::{Message, WebSocket};
use bytes::Bytes;
use futures_util::{Sink, Stream};
use std::{pin::Pin, time::Duration};
use wisp_mux::WispError;

pub(super) struct AxumTransport {
    socket: WebSocket,
    ping: tokio::time::Interval,
    flushing: bool,
}
impl AxumTransport {
    /// Wraps an upgraded socket that pings the visitor every `ping_every`.
    pub(super) fn new(socket: WebSocket, ping_every: Duration) -> Self {
        Self {
            socket,
            ping: tokio::time::interval(ping_every),
            flushing: false,
        }
    }
}
impl Stream for AxumTransport {
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
pub(super) type WsSink = futures_util::stream::SplitSink<AxumTransport, Bytes>;
