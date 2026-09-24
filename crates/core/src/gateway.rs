//! Choosing a gRPC-web gateway, and surviving a slow one.
//!
//! # Why this exists
//!
//! Every call the browser makes goes to a public lightwalletd gRPC-web gateway, and the
//! measurement in `web/docs/PERF-2026-09-21.md` says two things about them:
//!
//! 1. A healthy gateway answers a unary call in about 110 ms, and both of the ones this
//!    app knows about are healthy most of the time.
//! 2. When one is *not* healthy it does not fail: it stalls. The old code discovered that
//!    only after a whole scan had hung, because the failover was a JS-level retry that
//!    fired once the first attempt had already thrown.
//!
//! So the job here is not "make the fast path faster" — the fast path is already 110 ms —
//! it is "never spend a session on the slow gateway". Two things do that:
//!
//! - [`choose`] asks every gateway for the chain tip at once and keeps the one that
//!   answers first, inside a 1.5 s budget. It costs one round trip the caller was going to
//!   pay anyway, because the answer *is* the chain tip.
//! - [`Failover`] is the transport underneath every call after that. It puts a deadline on
//!   the response headers of each call and, when the chosen gateway misses it, re-sends
//!   the same request to the next one.
//!
//! # What `Failover` does and does not cover
//!
//! The deadline is on the *response headers*, which is where a stalled gateway shows up
//! and is the only point at which a retry is free: nothing has been handed to the caller
//! yet, so a second attempt is indistinguishable from a first. A server that answers
//! headers promptly and then stalls mid-stream is not covered here, because by then the
//! caller has already seen blocks and a retry would replay them.
//!
//! `SendTransaction` is never retried. It is the one call with a side effect, and a sweep
//! that lands twice on two gateways is not a failure mode this code will create.

use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};

use futures_util::future::{select, select_ok, Either};
use http_body_util::{BodyExt, Full};
use js_sys::Function;
use tonic::body::Body;
use tonic::codegen::http::{Request, Response};
use tonic::codegen::{Bytes, Service};
use tonic_web_wasm_client::{Client, Error, ResponseBody};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

use zcash_client_backend::proto::service::{
    compact_tx_streamer_client::CompactTxStreamerClient, ChainSpec,
};

use crate::scan::gateway_label;

/// How long [`choose`] waits for one of the gateways to answer before giving up on the
/// race and settling for the preferred one.
///
/// A healthy gateway answers `GetLatestBlock` in about 110 ms from a datacenter and well
/// under a second from a home connection. 1.5 s is far outside that and still short
/// enough that a recipient does not notice having paid for it.
pub const RACE_BUDGET_MS: f64 = 1_500.0;

/// How long any one call may take to produce *response headers* before the next gateway
/// is tried. See the module docs for why headers and not the whole response.
pub const CALL_HEADER_TIMEOUT_MS: f64 = 6_000.0;

/// The gRPC method that must never be retried, because sending it twice is offering the
/// same spend to two nodes.
const SEND_TRANSACTION: &str = "SendTransaction";

/// The gateway a session settled on.
pub struct Chosen {
    /// A short, human name for the timing line: the endpoint's host.
    pub label: String,
    /// The chain tip that won the race. The race *is* a `GetLatestBlock`, so this is not
    /// an extra round trip — it is the one the caller needed anyway.
    pub tip_height: u32,
    /// The transport to run the rest of the session on: the winner first, then the others
    /// as per-call failovers.
    pub transport: Failover,
}

/// Asks every gateway for the chain tip at once and keeps the first one that answers.
///
/// `endpoints` is in preference order. Three outcomes:
///
/// - Someone answers inside the budget: that gateway leads the session.
/// - Everyone refuses: a real failure, returned as one, because there is no chain to read.
/// - Nobody answers in time: not a failure. Both gateways are merely slow and the session
///   still has to run, so the preferred one leads and [`Failover`] deals with it per call.
pub async fn choose(endpoints: &[String]) -> Result<Chosen, String> {
    let preferred = endpoints
        .first()
        .ok_or("no lightwalletd gateway was given")?
        .clone();
    let attempts: Vec<_> = endpoints
        .iter()
        .cloned()
        .map(|endpoint| {
            Box::pin(async move {
                let mut client = CompactTxStreamerClient::new(Client::new(endpoint.clone()));
                let response = client
                    .get_latest_block(ChainSpec {})
                    .await
                    .map_err(|e| format!("{endpoint}: {}", e.message()))?;
                let height = response.into_inner().height;
                let height = u32::try_from(height)
                    .map_err(|_| format!("{endpoint}: chain tip height {height} is absurd"))?;
                Ok::<_, String>((endpoint, height))
            })
        })
        .collect();

    let ordered = |winner: &str| -> Vec<String> {
        let mut rest: Vec<String> = endpoints.iter().filter(|e| *e != winner).cloned().collect();
        let mut all = vec![winner.to_string()];
        all.append(&mut rest);
        all
    };

    match select(
        Box::pin(select_ok(attempts)),
        Box::pin(sleep(RACE_BUDGET_MS)),
    )
    .await
    {
        Either::Left((Ok(((endpoint, tip_height), _rest)), _)) => Ok(Chosen {
            label: gateway_label(&endpoint),
            tip_height,
            transport: Failover::new(ordered(&endpoint)),
        }),
        Either::Left((Err(e), _)) => Err(format!("no gateway answered: {e}")),
        Either::Right(((), _)) => {
            // Both are slow rather than broken. Ask the preferred one again through the
            // failover transport, which will move to the other if this one keeps stalling.
            let transport = Failover::new(endpoints.to_vec());
            let mut client = CompactTxStreamerClient::new(transport.clone());
            let height = client
                .get_latest_block(ChainSpec {})
                .await
                .map_err(|e| format!("GetLatestBlock failed: {}", e.message()))?
                .into_inner()
                .height;
            let tip_height = u32::try_from(height)
                .map_err(|_| format!("chain tip height {height} is absurd"))?;
            Ok(Chosen {
                label: gateway_label(&preferred),
                tip_height,
                transport,
            })
        }
    }
}

/// A gRPC-web transport over an ordered list of gateways.
///
/// Every call goes to the first gateway. If it does not produce response headers inside
/// [`CALL_HEADER_TIMEOUT_MS`], or refuses outright, the same request goes to the next one.
/// See the module docs for the two things this deliberately does not do.
#[derive(Clone)]
pub struct Failover {
    clients: Vec<Client>,
    timeout_ms: f64,
}

impl Failover {
    /// Builds a transport over these endpoints, in preference order.
    pub fn new(endpoints: Vec<String>) -> Self {
        Self::with_timeout(endpoints, CALL_HEADER_TIMEOUT_MS)
    }

    /// The same, with a different header deadline.
    pub fn with_timeout(endpoints: Vec<String>, timeout_ms: f64) -> Self {
        Self {
            clients: endpoints.into_iter().map(Client::new).collect(),
            timeout_ms,
        }
    }
}

impl Service<Request<Body>> for Failover {
    type Response = Response<ResponseBody>;
    type Error = Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>>>>;

    fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, request: Request<Body>) -> Self::Future {
        let mut clients = self.clients.clone();
        let timeout_ms = self.timeout_ms;

        Box::pin(async move {
            let (parts, body) = request.into_parts();
            // The body has to be held to be re-sent. Every request this crate makes is one
            // small protobuf message — a block range, a txid, an empty `ChainSpec` — so
            // buffering it costs a few dozen bytes. The transport underneath buffers it
            // too, on its way into a `Uint8Array`.
            let bytes: Bytes = body
                .collect()
                .await
                .map_err(|e| Error::TonicStatusError(tonic::Status::internal(e.to_string())))?
                .to_bytes();

            let retryable = !parts.uri.path().ends_with(SEND_TRANSACTION);
            let attempts = if retryable { clients.len() } else { 1 };

            let mut last: Option<Error> = None;
            for client in clients.iter_mut().take(attempts) {
                let request =
                    Request::from_parts(parts.clone(), Body::new(Full::new(bytes.clone())));
                match select(Box::pin(client.call(request)), Box::pin(sleep(timeout_ms))).await {
                    Either::Left((Ok(response), _)) => return Ok(response),
                    Either::Left((Err(e), _)) => last = Some(e),
                    Either::Right(((), _)) => {
                        last = Some(Error::TonicStatusError(tonic::Status::deadline_exceeded(
                            format!("no response headers in {timeout_ms:.0} ms"),
                        )));
                    }
                }
            }
            Err(last.unwrap_or_else(|| {
                Error::TonicStatusError(tonic::Status::unavailable("no gateway was configured"))
            }))
        })
    }
}

/// Resolves after `ms` milliseconds.
///
/// `setTimeout` is reached off the global object rather than through `web_sys::window`,
/// because the core runs in a Web Worker where there is no `window`. A global with no
/// `setTimeout` at all is not a real browser; the future then resolves at once, so a
/// missing timer can only make this code give up earlier, never hang.
async fn sleep(ms: f64) {
    let promise = js_sys::Promise::new(&mut |resolve, _reject| {
        let global = js_sys::global();
        match js_sys::Reflect::get(&global, &JsValue::from_str("setTimeout"))
            .ok()
            .and_then(|f| f.dyn_into::<Function>().ok())
        {
            Some(set_timeout) => {
                let _ = set_timeout.call2(&global, &resolve, &JsValue::from_f64(ms));
            }
            None => {
                let _ = resolve.call0(&JsValue::NULL);
            }
        }
    });
    let _ = JsFuture::from(promise).await;
}
