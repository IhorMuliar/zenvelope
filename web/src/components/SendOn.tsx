/**
 * "Where should it go?" — the M3 send-on flow, shown once the envelope is open.
 *
 * Four screens, driven by the reducer in ../lib/sweepFlow: choose a destination,
 * review the numbers, watch the four stages, and land on Sent or on an error that
 * says the money never moved.
 *
 * The secret arrives as a **getter**, not as a string: it is read out of the open
 * page's ref at the moment of the sweep, handed to `sweep_envelope`, and goes
 * nowhere else — not into storage, not into a URL, not into a log, and not into
 * a prop the React DevTools inspector would print (I12). Neither does the
 * mnemonic of a wallet generated here — it exists on screen and in one piece of
 * React state, and it is gone when the tab is.
 */

import { Envelope } from "./Envelope";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  EXPLORER_NAME,
  FEE_ADDRESS,
  FEE_ENABLED,
  LIGHTWALLETD,
  LIGHTWALLETD_FALLBACK,
  SWEEP_FEE_ZAT,
  explorerTxUrl,
} from "../config";
import type { FoundNote, LoadedCore, Network, NewWallet } from "../core/types";
import { sweepAmounts, tooSmallMessage } from "../lib/amount";
import {
  classifyDestinationAsync,
  emptyDestination,
  type DestinationState,
} from "../lib/destination";
import { DRY_RUN_COPY, isDryRun, rawTxBytes } from "../lib/dryRun";
import { gatewayList } from "../lib/openFlow";
import { formatCount, formatZecAmount, truncateMiddle } from "../lib/format";
import {
  doneCopy,
  exchangeBoundary as exchangeCopy,
  receive as copy,
  revealed,
  solanaExit as swapCopy,
  transparentBoundary as transparentCopy,
} from "../copy/en";
import { appFeeBps, effectiveCost, formatAssetAmount, formatUsd } from "../lib/oneclick";
import {
  FUNDS_SAFE_COPY,
  RACE_CHECK_BUTTON,
  RACE_LOST_COPY,
  SWEEP_FAILED_COPY,
  deviceLine,
  elapsedLabel,
  initialSendState,
  needsUnloadWarning,
  sendReducer,
  showSwapUi,
  stageChecklist,
  timingRows,
  timingText,
} from "../lib/sweepFlow";
import { checkSwapPlan } from "../lib/solanaFlow";
import { CopyButton } from "./CopyButton";
import { CopyField } from "./CopyField";
import { SolanaExit, type SwapPlan } from "./SolanaExit";
import { SwapTracker } from "./SwapTracker";
import { TrustBoundary } from "./TrustBoundary";

/** Said when the open page has somehow lost the secret before the sweep ran. */
export const NO_SECRET_COPY =
  "This page no longer has the link. Nothing was sent. Open the original link again to send it on.";

/** Desktop measurement: the proving key is about 29 s on one thread, about 15 s on four. */
const WARM_ESTIMATE = "~30 s";

/**
 * Shown while the sweep is waiting for the background proving key rather than for
 * anything on the chain. The core worker holds one wasm module and builds the key in a
 * single call, so a sweep tapped before "Keys ready" waits for the rest of it before it
 * can start; saying "Starting…" through that was the screen's only untrue line.
 */
export const PREPARING_KEYS_COPY = "Getting the keys ready to send…";

export const SEND_TIMING_COPY =
  "This takes a few seconds to a minute. Keep this tab open.";

export const RESTORE_COPY = "Restore in Zodl or Zingo with these words and this birthday height";

/**
 * Where the money goes, in the order the chooser lists them: an exchange
 * account, USDC on Solana, a Zcash wallet app, and a wallet made in this page.
 * The exchange and the app both end in a pasted Zcash address; they differ in
 * the help around the box and in the words of the transparent gate.
 */
type Choice = "exchange" | "solana" | "app" | "wallet" | null;

interface Props {
  core: LoadedCore;
  /**
   * Reads the secret out of the open page's ref, and is called in one place:
   * inside the sweep, at the moment the core is handed it (I12).
   */
  getSecret: () => string | null;
  network: Network;
  /**
   * Every note the scan found. A sweep spends all of them, in one transaction, so
   * the amount shown and the amount sent are the sum of these.
   */
  notes: FoundNote[];
  /** Chain tip at the end of the scan: the birthday a new wallet restores from. */
  tipHeight: number;
  /**
   * The envelope's own address, derived from the link. The Solana exit uses it
   * as the default refund destination, because a refund to it lands back in
   * this envelope and this same link opens it again (DECISIONS D14).
   */
  envelopeAddress: string;
  /**
   * How long the scan that opened this envelope took, in milliseconds. It is
   * measured by the open page — the only place that knows when the tap on "Open
   * envelope" happened — and shown in the Timing block at the end.
   */
  openMs?: number | null;
  /**
   * Runs the open again. Offered only when the network refused the sweep because
   * another device had already spent the note, so the page can show what the
   * chain now says instead of a retry that cannot succeed.
   */
  onCheckAgain?: () => void;
  /**
   * Whether the recipient has pressed "Receive it". Until then this renders only
   * that button (or the too-small card), while the proving key warms underneath.
   */
  started?: boolean;
  onStart?: () => void;
  /** Back from the destinations to the opened envelope. */
  onBackToEnvelope?: () => void;
}

/** `?debug=1` shows the Timing block on the done screen, for our own measurements. */
function isDebug(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("debug") === "1";
  } catch {
    return false;
  }
}

export function SendOn({
  core,
  getSecret,
  network,
  notes,
  tipHeight,
  envelopeAddress,
  openMs = null,
  onCheckAgain,
  started = true,
  onStart,
  onBackToEnvelope,
}: Props) {
  const [state, dispatch] = useReducer(sendReducer, initialSendState);
  const [choice, setChoice] = useState<Choice>(null);
  const [dest, setDest] = useState<DestinationState>(emptyDestination);
  const [wallet, setWallet] = useState<NewWallet | null>(null);
  const [walletDest, setWalletDest] = useState<DestinationState | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [wroteDown, setWroteDown] = useState(false);
  /**
   * Set once the Solana rail has reserved a deposit address. From that point the
   * destination is an ordinary transparent `t1` and the sweep below is unchanged;
   * this only decides what the review, done and tracking screens say about it.
   */
  const [swap, setSwap] = useState<SwapPlan | null>(null);
  /**
   * Why a reserved swap was thrown away: an untrustworthy deposit address, an
   * echoed request that did not match what we asked for, or a classification
   * the core refused. It used to be nothing at all — the rail's address was
   * silently dropped and the recipient was returned to a screen with no
   * explanation (L9/M6).
   */
  const [swapError, setSwapError] = useState<string | null>(null);
  /**
   * The transparent trust boundary (M7). A pasted `t1` leaves the shielded pool
   * as permanently as the Solana exit does, so it goes through the same
   * component and the same tick before the review screen.
   */
  const [transparentAck, setTransparentAck] = useState(false);
  const [atTransparentGate, setAtTransparentGate] = useState(false);
  const [warm, setWarm] = useState<"warming" | "ready" | "failed">("warming");
  /** Wall clock of the background warm-up, for the Timing block. */
  const [warmMs, setWarmMs] = useState<number | null>(null);
  /** When it finished, so a sweep tapped before then can say what it waited for. */
  const [warmDoneAt, setWarmDoneAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const runId = useRef(0);
  /**
   * Bumped per keystroke. Classification is a round trip to the core worker now, so two
   * answers can come back out of order; only the newest one is allowed to land.
   */
  const destId = useRef(0);

  /**
   * `?dry=1` in the query string: build and prove the sweep, then stop. Read once,
   * at mount, so nothing can flip it under a sweep that is already running.
   */
  const dryRun = useMemo(() => isDryRun(), []);
  const debug = useMemo(isDebug, []);

  // Every note in the envelope, added up: one sweep spends the lot.
  const inEnvelopeZat = useMemo(
    () => notes.reduce((sum, n) => sum + BigInt(n.amount_zat), 0n),
    [notes],
  );

  /**
   * The cheapest sweep there is — a shielded destination — with the service fee.
   * If even that leaves the recipient nothing, no destination can help, so the
   * screen says so at once and nothing is warmed, built or proved.
   */
  const cheapest = sweepAmounts(inEnvelopeZat, "unified_orchard", SWEEP_FEE_ZAT, notes.length);
  const tooSmall = !cheapest.ok;

  /**
   * The proving key starts building the moment the envelope is found, before the
   * recipient has chosen anything, so most of the wait happens while they read.
   */
  useEffect(() => {
    if (tooSmall) return;
    let alive = true;
    const startedAt = Date.now();
    core
      .warm_proving_key()
      .then(() => {
        if (!alive) return;
        // Measured here rather than taken from the core's own answer: this is
        // what the recipient waited, worker round trip and all.
        setWarmMs(Date.now() - startedAt);
        setWarmDoneAt(Date.now());
        setWarm("ready");
      })
      .catch(() => {
        // A failed warm-up is not fatal: the sweep builds the key itself.
        if (alive) setWarm("failed");
      });
    return () => {
      alive = false;
    };
  }, [core, tooSmall]);

  // The generated wallet's own address goes through the same classifier as a pasted
  // one: nothing is trusted just because this page made it.
  useEffect(() => {
    if (!wallet) {
      setWalletDest(null);
      return;
    }
    let alive = true;
    void classifyDestinationAsync(wallet.address, core.classify_address, network).then((d) => {
      if (alive) setWalletDest(d);
    });
    return () => {
      alive = false;
    };
  }, [wallet, core, network]);

  const active = choice === "wallet" ? walletDest : choice === null ? null : dest;
  const destination = active?.input.trim() ?? "";
  const amounts = sweepAmounts(
    inEnvelopeZat,
    active?.kind ?? "unified_orchard",
    SWEEP_FEE_ZAT,
    notes.length,
  );

  /**
   * What the rail would actually be paid: the envelope less the Zcash fees for a
   * transparent destination, because the deposit address is always a `t1`. The
   * swap is quoted on this number, never on the envelope amount.
   */
  const swapInputZat = sweepAmounts(
    inEnvelopeZat,
    "transparent",
    SWEEP_FEE_ZAT,
    notes.length,
  ).receiveZat;
  /** The Zcash side of a Solana exit: network fee plus service fee, before the swap. */
  const swapZcashFeesZat = inEnvelopeZat - swapInputZat;

  /**
   * The rail's deposit address becomes the destination, classified by our own
   * core like any pasted address: the `t1` the rail sent is not trusted because
   * the rail sent it.
   */
  const onSwapPlan = useCallback(
    async (plan: SwapPlan) => {
      const classified = await classifyDestinationAsync(
        plan.reservation.address,
        core.classify_address,
        network,
      );
      // Two checks, and the sweep is only reachable past both: the address is a
      // transparent one of this network by our own core's reckoning, and the
      // rail echoed back the payout address, the asset and the refund address we
      // actually asked for (M6). Either failing throws the reservation away —
      // nothing is swept to an address we cannot vouch for — and says why (L9).
      const problem = checkSwapPlan({
        depositKind: classified.kind,
        quoteRequest: plan.reservation.quoteRequest,
        asset: plan.asset,
        recipient: plan.recipient,
        refundTo: plan.refundTo,
      });
      if (problem !== null) {
        setSwap(null);
        setDest(emptyDestination);
        setChoice(null);
        setSwapError(problem);
        return;
      }
      setSwapError(null);
      setSwap(plan);
      setDest(classified);
      dispatch({ type: "review" });
    },
    [core, network],
  );

  const ready =
    active !== null &&
    active.canContinue &&
    amounts.ok &&
    (choice !== "wallet" || wroteDown);

  /**
   * A pasted `t1` has to pass the trust boundary before the review screen (M7).
   * The rail's own deposit address does not come through here — it arrives from
   * the Solana exit, which has its own boundary — and a generated wallet is
   * always unified.
   */
  const pastesAddress = choice === "exchange" || choice === "app";
  const needsTransparentGate = pastesAddress && active?.kind === "transparent" && !transparentAck;

  /* ------------------------------------------------------------- the sweep */

  const send = useCallback(async () => {
    // Belt and braces: the screens never offer a sweep the envelope cannot pay
    // for, and this refuses one anyway, before the secret is even read.
    if (!amounts.ok) return;
    const id = ++runId.current;
    const secret = getSecret();
    if (secret === null || secret === "") {
      dispatch({ type: "send", at: Date.now() });
      dispatch({ type: "failed", message: NO_SECRET_COPY });
      return;
    }
    dispatch({ type: "send", at: Date.now() });
    try {
      const result = await core.sweep_envelope(
        secret,
        network,
        // Both gateways, in preference order: the core races them for the chain
        // tip and runs the sweep on whichever answered first.
        gatewayList([LIGHTWALLETD[network], LIGHTWALLETD_FALLBACK[network]]),
        notes.map((n) => ({
          txid: n.txid,
          height: n.height,
          action_index: n.action_index,
        })),
        destination,
        FEE_ADDRESS,
        SWEEP_FEE_ZAT.toString(),
        null,
        // A dry run proves the transaction and never hands it to lightwalletd.
        !dryRun,
        (stage, detail) => {
          if (id === runId.current) dispatch({ type: "stage", stage, detail, at: Date.now() });
        },
      );
      if (id === runId.current) dispatch({ type: "result", result, at: Date.now() });
    } catch (err) {
      const message = (err as Error)?.message?.trim();
      if (id === runId.current) {
        dispatch({ type: "failed", message: message ? message : SWEEP_FAILED_COPY });
      }
    }
  }, [core, getSecret, network, notes, destination, dryRun, amounts.ok]);

  /* --------------------------------------------- keep the screen and the tab */

  // A phone that sleeps mid-proof throws the proof away. The lock is best
  // effort: a browser without the API, or one that refuses, changes nothing.
  useEffect(() => {
    if (state.phase !== "sending") return;
    const nav = navigator as Navigator & {
      wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> };
    };
    let sentinel: { release(): Promise<void> } | null = null;
    let released = false;
    nav.wakeLock
      ?.request("screen")
      .then((s) => {
        if (released) void s.release().catch(() => {});
        else sentinel = s;
      })
      .catch(() => {});
    return () => {
      released = true;
      void sentinel?.release().catch(() => {});
    };
  }, [state.phase]);

  // Only the proof and the broadcast are worth warning about: everything before
  // them is cheap to redo, and nothing is ever persisted to come back to.
  useEffect(() => {
    if (!needsUnloadWarning(state)) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [state]);

  useEffect(() => {
    if (state.phase !== "sending" || state.startedAt === null) return;
    const started = state.startedAt;
    setElapsed(Date.now() - started);
    const timer = window.setInterval(() => setElapsed(Date.now() - started), 250);
    return () => window.clearInterval(timer);
  }, [state.phase, state.startedAt]);

  /**
   * "Choose somewhere else", from the review screen and from a failed sweep.
   *
   * It resets the destination as well as the phase. A swap plan that survived
   * this used to keep the review screen promising USDC on Solana, and the Sent
   * screen polling a deposit address nobody had paid, after the recipient had
   * backed out and chosen a Zcash address instead (M3).
   */
  const chooseAgain = useCallback(() => {
    dispatch({ type: "choose" });
    setSwap(null);
    setSwapError(null);
    setChoice(null);
    setDest(emptyDestination);
    setWroteDown(false);
    setTransparentAck(false);
    setAtTransparentGate(false);
  }, []);

  /* ------------------------------------------------------------- the screens */

  // Too small for any destination: one card, the reason, and nothing to press.
  if (tooSmall && state.phase === "choose") {
    return (
      <div className="card stack">
        <h2>Where should it go?</h2>
        <p className="error" data-testid="too-small">
          {tooSmallMessage(cheapest)}
        </p>
        <p className="row">
          <span className="label">In the envelope</span>
          <span data-testid="too-small-in-envelope">{formatZecAmount(inEnvelopeZat)}</span>
        </p>
      </div>
    );
  }

  if (state.phase === "sending") {
    const rows = stageChecklist(state);
    return (
      <div className="card stack">
        <h2 data-testid="sending">Sending it on</h2>
        <ul className="stage-list" data-testid="stage-list">
          {rows.map((row) => (
            <li key={row.stage} data-stage={row.stage} data-state={row.state} data-testid="stage-row">
              <span className="stage-mark" aria-hidden="true">
                {row.state === "done" ? "✓" : row.state === "active" ? "•" : "·"}
              </span>
              <span>{row.label}</span>
            </li>
          ))}
        </ul>
        <p className="row">
          <span className="label">Elapsed</span>
          <span data-testid="elapsed">{elapsedLabel(elapsed)}</span>
        </p>
        <p className="hint" aria-live="polite" data-testid="stage-detail">
          {state.detail ?? (warm === "ready" ? "Starting…" : PREPARING_KEYS_COPY)}
        </p>
        <p className="fine">{SEND_TIMING_COPY}</p>
      </div>
    );
  }

  if (state.phase === "sent" && state.result) {
    const received = BigInt(state.result.amount_to_destination_zat);
    // The core is the authority on what happened, not the flag that asked for it.
    const dry = state.result.broadcast === false;
    // Both endings get the same block: a dry run is measured for exactly the
    // reason a real one is, and it is the run we can repeat.
    const rows = timingRows({ state, openMs, warmMs, warmDoneAt });
    const device = deviceLine({
      threads: core.threads,
      hardwareConcurrency: navigator.hardwareConcurrency ?? 0,
      userAgent: navigator.userAgent,
      brave: hasBrave(navigator),
      // The core is the authority on which gateway answered, not the config.
      gateway: state.result.gateway,
    });
    return (
      <>
        <div className="card stack sent-card">
          {dry ? null : <Envelope state="open" size="small" postmark="sent" />}
          <h2 data-testid="sent-heading">{dry ? "Dry run complete." : "Sent."}</h2>
          <p className="sent-amount" data-testid="sent-amount">
            {formatZecAmount(received)}
          </p>
          {dry ? null : (
            <div className="stack tight" aria-live="polite">
              <p className="lede done-where" data-testid="done-where">
                {doneCopy[choice ?? "app"].where}
              </p>
              <p data-testid="done-next">{doneCopy[choice ?? "app"].next}</p>
            </div>
          )}
          <CopyField
            label="Transaction"
            value={state.result.txid}
            display={truncateMiddle(state.result.txid, 10)}
            testId="sent-txid"
          />
          {dry ? (
            <>
              {/* A Solana dry run got further: a real deposit address exists. */}
              <p className="warn" data-testid="dry-run-note">
                {showSwapUi(choice, swap) ? swapCopy.dryRunLine : DRY_RUN_COPY}
              </p>
              {showSwapUi(choice, swap) && swap ? (
                <>
                  <CopyField
                    label={swapCopy.depositLabel}
                    value={swap.reservation.address}
                    testId="dry-run-deposit-address"
                  />
                  <p className="fine" data-testid="dry-run-swap-note">
                    {swapCopy.dryRunNote}
                  </p>
                </>
              ) : null}
              <p className="row">
                <span className="label">Raw transaction</span>
                <span data-testid="dry-run-size">
                  {formatCount(rawTxBytes(state.result.raw_tx_hex))} bytes
                </span>
              </p>
            </>
          ) : (
            <p>
              <a
                href={explorerTxUrl(state.result.txid, network)}
                rel="noreferrer noopener"
                target="_blank"
                data-testid="explorer-link"
              >
                See it on {EXPLORER_NAME}
              </a>
            </p>
          )}
          <p className="hint" data-testid="sent-destination">
            To {truncateMiddle(destination, 12)}
          </p>
          {dry ? (
            <p data-testid="envelope-intact">
              Nothing was sent. The money is still in the envelope, and this link still works.
            </p>
          ) : (
            <p data-testid="envelope-empty">The envelope is now empty.</p>
          )}
          {debug ? (
          <div className="timing stack" data-testid="timing">
            <h3 className="timing-heading">Timing</h3>
            {rows.map((row) => (
              <p className="row" key={row.key}>
                <span className="label">{row.label}</span>
                <span data-testid={`timing-${row.key}`}>{row.value}</span>
              </p>
            ))}
            <p className="fine" data-testid="timing-device">
              {device}
            </p>
            <CopyButton
              value={timingText(rows, device)}
              label="Copy the timings"
              face="Copy timing"
              testId="copy-timing"
            />
          </div>
          ) : null}
        </div>
        {/*
          Only a real broadcast has anything for the rail to watch for — and only
          a destination that is still the Solana exit's. Neither the tracker nor
          the dry-run deposit lines may survive a change of destination (M3).
        */}
        {showSwapUi(choice, swap) && !dry ? <SwapTracker plan={swap!} /> : null}
      </>
    );
  }

  if (state.phase === "failed" && state.raced) {
    return (
      <div className="card stack">
        <h2>It did not go through</h2>
        <p className="error" data-testid="send-raced">
          {RACE_LOST_COPY}
        </p>
        {onCheckAgain ? (
          <button
            type="button"
            className="primary"
            onClick={onCheckAgain}
            data-testid="send-check-envelope"
          >
            {RACE_CHECK_BUTTON}
          </button>
        ) : null}
        {state.message ? (
          <p className="fine" data-testid="send-error">
            {state.message}
          </p>
        ) : null}
      </div>
    );
  }

  if (state.phase === "failed") {
    return (
      <div className="card stack">
        <h2>It did not go through</h2>
        <p className="error" data-testid="send-error">
          {state.message ?? SWEEP_FAILED_COPY}
        </p>
        <button type="button" className="primary" onClick={() => void send()} data-testid="send-retry">
          Try again
        </button>
        <button
          type="button"
          className="ghost"
          onClick={chooseAgain}
          data-testid="send-restart"
        >
          Choose somewhere else
        </button>
        <p className="fine" data-testid="funds-safe">
          {FUNDS_SAFE_COPY}
        </p>
      </div>
    );
  }

  if (state.phase === "review" && active) {
    return (
      <div className="card stack">
        <h2>Check before you send</h2>
        <p className="row">
          <span className="label">In the envelope</span>
          <span data-testid="review-in-envelope">{formatZecAmount(amounts.inEnvelopeZat)}</span>
        </p>
        <p className="row">
          <span className="label">Network fee</span>
          <span data-testid="review-network-fee">{formatZecAmount(amounts.networkFeeZat)}</span>
        </p>
        {FEE_ENABLED && amounts.serviceFeeZat > 0n ? (
          <p className="row">
            <span className="label">Zenvelope fee</span>
            <span data-testid="review-service-fee">{formatZecAmount(amounts.serviceFeeZat)}</span>
          </p>
        ) : null}
        <p className="row receive">
          <span className="label">You receive</span>
          <strong data-testid="review-receive">{formatZecAmount(amounts.receiveZat)}</strong>
        </p>
        <p className="row">
          <span className="label">Goes to</span>
          <span className="mono" data-testid="review-destination">
            {truncateMiddle(destination, 12)}
          </span>
        </p>
        {showSwapUi(choice, swap) && swap ? <SwapReview plan={swap} /> : null}
        {active.status === "warn" ? (
          <p className="warn" data-testid="review-warning">
            {active.message}
          </p>
        ) : null}
        {amounts.ok ? (
          <button type="button" className="primary" onClick={() => void send()} data-testid="send-it-on">
            {copy.sendTo[choice ?? "app"]}
          </button>
        ) : (
          <p className="error" data-testid="too-small">
            {tooSmallMessage(amounts)}
          </p>
        )}
        <p className="fine" data-testid="send-timing">
          {SEND_TIMING_COPY}
        </p>
        <button
          type="button"
          className="ghost"
          onClick={chooseAgain}
          data-testid="review-back"
        >
          Choose somewhere else
        </button>
      </div>
    );
  }

  /* ------------------------------------------------------------ choose phase */

  // The Solana exit owns the whole screen while it runs: a trust boundary that
  // shares a page with two shielded destinations is a trust boundary nobody reads.
  if (choice === "solana" && !swap) {
    return (
      <SolanaExit
        amountZat={swapInputZat}
        envelopeAddress={envelopeAddress}
        zcashFeesZat={swapZcashFeesZat}
        classify={core.classify_address}
        network={network}
        onPlan={(plan) => void onSwapPlan(plan)}
        onBack={() => {
          setChoice(null);
          // Backing out of the exit throws the plan away with it (M3).
          setSwap(null);
        }}
      />
    );
  }

  // The same screen, the same tick, for a pasted transparent address (M7).
  if (atTransparentGate) {
    return (
      <TrustBoundary
        content={choice === "exchange" ? exchangeCopy : transparentCopy}
        testId={choice === "exchange" ? "exchange-boundary" : "transparent-boundary"}
        continueLabel={choice === "exchange" ? exchangeCopy.continue : transparentCopy.continue}
        acknowledged={transparentAck}
        onAcknowledgedChange={setTransparentAck}
        onContinue={() => {
          setAtTransparentGate(false);
          dispatch({ type: "review" });
        }}
        onBack={() => setAtTransparentGate(false)}
      />
    );
  }

  /** Exchange and app share the pasted-address box; switching clears it. */
  const onPickPaste = (next: "exchange" | "app") => {
    if (choice !== next) {
      setDest(emptyDestination);
      setTransparentAck(false);
    }
    setChoice(next);
    setWallet(null);
    setWroteDown(false);
    // A destination that is not the Solana exit's has no swap attached to it.
    setSwap(null);
    setSwapError(null);
  };

  const onPickWallet = async () => {
    setChoice("wallet");
    setDest(emptyDestination);
    setWroteDown(false);
    setSwap(null);
    setSwapError(null);
    if (wallet) return;
    try {
      // The mnemonic is generated in the core worker, lands in React state and on the
      // screen, and goes nowhere else.
      setWallet(await core.new_wallet(network, tipHeight));
      setWalletError(null);
    } catch (err) {
      setWalletError((err as Error).message);
    }
  };

  // Before "Receive it": one button, and the keys warming underneath it.
  if (!started) {
    return (
      <button type="button" className="primary" onClick={onStart} data-testid="receive-it">
        {revealed.receive}
      </button>
    );
  }

  /** The address box, for the two destinations that end in a pasted Zcash address. */
  const addressPanel = (label: string, placeholder: string) => (
    <>
      <label className="field">
        <span className="label strong">{label}</span>
        <input
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          value={dest.input}
          placeholder={placeholder}
          onChange={(e) => {
            const input = e.target.value;
            const id = ++destId.current;
            // The transparent acknowledgement belongs to the address that
            // was on screen when it was ticked, so typing takes it back.
            setTransparentAck(false);
            // The typed text has to show at once; the verdict lands when the
            // worker answers, and only if nothing newer has been typed since.
            setDest({ ...emptyDestination, input });
            void classifyDestinationAsync(input, core.classify_address, network).then((d) => {
              if (id === destId.current) setDest(d);
            });
          }}
          data-testid="dest-input"
        />
      </label>
      {dest.message ? (
        <p
          className={dest.status === "error" ? "error" : dest.status === "warn" ? "warn" : "hint"}
          data-status={dest.status}
          aria-live="polite"
          data-testid="dest-feedback"
        >
          {dest.message}
        </p>
      ) : null}
      {/* The core's own words, when it had any: the reason a wrong-network
          address is refused is the reason, not a guess at the prefix (L10). */}
      {dest.reason ? (
        <p className="fine" data-testid="dest-reason">
          {dest.reason}
        </p>
      ) : null}
    </>
  );

  const swapNumbers =
    swapInputZat > 0n
      ? swapCopy.cardNumbers(formatZecAmount(swapInputZat), formatZecAmount(swapZcashFeesZat))
      : null;

  return (
    <div className="stack chooser">
      <h2 className="screen-title">{copy.title}</h2>
      {/* A swap reservation we refused to sweep to, said out loud, with a way to
          try the exit again (L9/M6). */}
      {swapError ? (
        <div className="stack" data-testid="swap-plan-error">
          <p className="error" data-testid="swap-plan-error-message">
            {swapError}
          </p>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setSwapError(null);
              setChoice("solana");
            }}
            data-testid="swap-plan-retry"
          >
            {swapCopy.depositRetry}
          </button>
        </div>
      ) : null}
      {notes.length > 1 ? (
        <p className="hint" data-testid="multi-note">
          All {notes.length} payments go in one transaction, added up above.
        </p>
      ) : null}

      <ul className="next-steps">
        <li>
          <button
            type="button"
            onClick={() => onPickPaste("exchange")}
            aria-pressed={choice === "exchange"}
            aria-expanded={choice === "exchange"}
            data-testid="dest-exchange"
          >
            <span className="next-title">{copy.exchangeTitle}</span>
            <span className="hint">{copy.exchangeHint}</span>
          </button>
          {choice === "exchange" ? (
            <div className="stack dest-panel">
              <p className="hint">{copy.exchangeHow}</p>
              {addressPanel(copy.exchangeLabel, "t1… or u1…")}
            </div>
          ) : null}
        </li>

        {/*
          Never the headline. Tapping it does not start a swap: it opens the
          trust-boundary screen, whose tick is the only way further. The card
          carries the numbers it can know already; the quote carries the rest.
        */}
        <li>
          <button
            type="button"
            onClick={() => {
              setChoice("solana");
              setWallet(null);
              setWroteDown(false);
              setDest(emptyDestination);
              setSwap(null);
              setSwapError(null);
            }}
            aria-pressed={choice === "solana"}
            data-testid="dest-solana"
          >
            <span className="next-title">{swapCopy.cardTitle}</span>
            <span className="hint">{swapCopy.cardHint}</span>
            <span className="hint">{swapCopy.cardBody}</span>
            {swapNumbers ? (
              <span className="hint numbers" data-testid="dest-solana-numbers">
                {swapNumbers}
              </span>
            ) : null}
          </button>
        </li>

        <li>
          <button
            type="button"
            onClick={() => onPickPaste("app")}
            aria-pressed={choice === "app"}
            aria-expanded={choice === "app"}
            data-testid="dest-address"
          >
            <span className="next-title">{copy.appTitle}</span>
            <span className="hint">{copy.appHint}</span>
          </button>
          {choice === "app" ? (
            <div className="stack dest-panel">
              <ol className="numbered small" data-testid="app-steps">
                {copy.appSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              {addressPanel(copy.appLabel, "u1…")}
            </div>
          ) : null}
        </li>

        <li>
          <button
            type="button"
            onClick={() => void onPickWallet()}
            aria-pressed={choice === "wallet"}
            aria-expanded={choice === "wallet"}
            data-testid="dest-wallet"
          >
            <span className="next-title">{copy.pageWalletTitle}</span>
            <span className="hint">{copy.pageWalletHint}</span>
          </button>
          {choice === "wallet" ? (
            <div className="stack dest-panel">
              {walletError ? (
                <p className="error" data-testid="wallet-error">
                  {walletError}
                </p>
              ) : null}
              {wallet ? (
                <>
                  <p className="hint">{copy.pageWalletWords}</p>
                  <p className="warn" data-testid="wallet-warn">
                    {copy.pageWalletWarn}
                  </p>
                  <ol className="words" data-testid="wallet-words">
                    {wallet.mnemonic.split(" ").map((word, i) => (
                      <li key={`${i}-${word}`} data-testid="wallet-word">
                        <span className="word-n">{i + 1}</span>
                        <span className="word">{word}</span>
                      </li>
                    ))}
                  </ol>
                  <p className="hint" data-testid="wallet-later">
                    {copy.pageWalletLater}
                  </p>
                  <CopyField
                    label="Address"
                    value={wallet.address}
                    display={truncateMiddle(wallet.address, 12)}
                    testId="wallet-address"
                  />
                  <p className="row">
                    <span className="label">Birthday height</span>
                    <span data-testid="wallet-birthday">{formatCount(wallet.birthday)}</span>
                  </p>
                  <p className="hint" data-testid="wallet-restore">
                    {RESTORE_COPY}.
                  </p>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={wroteDown}
                      onChange={(e) => setWroteDown(e.target.checked)}
                      data-testid="wallet-confirm"
                    />
                    <span>{copy.pageWalletCheckbox}</span>
                  </label>
                </>
              ) : null}
            </div>
          ) : null}
        </li>
      </ul>

      {active && !amounts.ok ? (
        <p className="error" data-testid="too-small">
          {tooSmallMessage(amounts)}
        </p>
      ) : null}

      <button
        type="button"
        className="primary"
        disabled={!ready}
        onClick={() => {
          // A pasted transparent address goes through the trust boundary first,
          // exactly as the Solana exit does (M7). A destination that came back
          // from the exit has already been through it.
          if (needsTransparentGate) setAtTransparentGate(true);
          else dispatch({ type: "review" });
        }}
        data-testid="to-review"
      >
        {copy.continue}
      </button>
      <p className="fine" data-testid="warm-status">
        {warm === "warming"
          ? `Preparing keys… ${WARM_ESTIMATE}`
          : warm === "ready"
            ? "Keys ready"
            : "The keys will be built when you send."}
      </p>
      {onBackToEnvelope ? (
        <button type="button" className="ghost wide" onClick={onBackToEnvelope} data-testid="receive-back">
          {copy.back}
        </button>
      ) : null}
    </div>
  );
}

/**
 * The swap's own numbers on the review screen, under the Zcash ones.
 *
 * The recipient is about to pay a transparent address they have never seen, so
 * the screen restates what that address is for, what comes back, what it costs
 * and who is on the other side — the quote they already agreed to, repeated at
 * the last moment where backing out is still free.
 */
function SwapReview({ plan }: { plan: SwapPlan }) {
  const cost = effectiveCost(plan.reservation.quote, appFeeBps(plan.reservation));
  return (
    <>
      <p className="row receive">
        <span className="label">{swapCopy.amountOutLabel}</span>
        <strong data-testid="review-swap-out">
          {formatAssetAmount(plan.reservation.quote, plan.asset)}
        </strong>
      </p>
      <p className="row">
        <span className="label">{swapCopy.spreadLabel}</span>
        <span data-testid="review-swap-spread">
          {cost.spreadPct} · {formatUsd(cost.costUsd)}
        </span>
      </p>
      <p className="row">
        <span className="label">Pays out to</span>
        <span className="mono" data-testid="review-swap-recipient">
          {truncateMiddle(plan.recipient, 10)}
        </span>
      </p>
      <p className="fine" data-testid="review-swap-fee">
        {cost.disclosure}
      </p>
      <p className="fine" data-testid="review-swap-not-provider">
        {swapCopy.notProvider}
      </p>
    </>
  );
}

/**
 * Brave reports itself as Chrome in every user agent it sends, on purpose. The
 * one thing that tells them apart is `navigator.brave`, which is a promise-based
 * API; this reads only the marker's presence, which is synchronous and enough
 * for a line of timing prose.
 */
function hasBrave(nav: Navigator): boolean {
  return typeof (nav as Navigator & { brave?: unknown }).brave === "object";
}
