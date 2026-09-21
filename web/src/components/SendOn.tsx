/**
 * "Where should it go?" — the M3 send-on flow, shown once the envelope is open.
 *
 * Four screens, driven by the reducer in ../lib/sweepFlow: choose a destination,
 * review the numbers, watch the four stages, and land on Sent or on an error that
 * says the money never moved.
 *
 * The secret arrives as a prop, is handed to `sweep_envelope`, and goes nowhere
 * else: not into storage, not into a URL, not into a log. Neither does the
 * mnemonic of a wallet generated here — it exists on screen and in one piece of
 * React state, and it is gone when the tab is.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  EXPLORER_NAME,
  FEE_ADDRESS,
  FEE_ENABLED,
  LIGHTWALLETD,
  SWEEP_FEE_ZAT,
  explorerTxUrl,
} from "../config";
import type { FoundNote, LoadedCore, Network, NewWallet } from "../core/types";
import { sweepAmounts } from "../lib/amount";
import {
  classifyDestinationAsync,
  emptyDestination,
  type DestinationState,
} from "../lib/destination";
import { DRY_RUN_COPY, isDryRun, rawTxBytes } from "../lib/dryRun";
import { formatCount, formatZecAmount, truncateMiddle } from "../lib/format";
import { solanaExit as swapCopy } from "../copy/en";
import { effectiveCost, formatAssetAmount, formatUsd } from "../lib/oneclick";
import {
  FUNDS_SAFE_COPY,
  SWEEP_FAILED_COPY,
  elapsedLabel,
  initialSendState,
  needsUnloadWarning,
  sendReducer,
  stageChecklist,
} from "../lib/sweepFlow";
import { CopyField } from "./CopyField";
import { SolanaExit, type SwapPlan } from "./SolanaExit";
import { SwapTracker } from "./SwapTracker";

/** Desktop measurement: the proving key is about 29 s on one thread, about 15 s on four. */
const WARM_ESTIMATE = "~30 s";

export const SEND_TIMING_COPY =
  "This takes about 1 to 2 minutes on a laptop and longer on a phone. Keep this tab open.";

export const RESTORE_COPY = "Restore in Zodl or Zingo with these words and this birthday height";

type Choice = "address" | "wallet" | "solana" | null;

interface Props {
  core: LoadedCore;
  /** Lives here only for the length of the sweep call. */
  secret: string;
  network: Network;
  /** The note being sent on. */
  note: FoundNote;
  /** How many notes the scan found, so a multi-note envelope can say so. */
  noteCount: number;
  /** Chain tip at the end of the scan: the birthday a new wallet restores from. */
  tipHeight: number;
  /**
   * The envelope's own address, derived from the link. The Solana exit uses it
   * as the default refund destination, because a refund to it lands back in
   * this envelope and this same link opens it again (DECISIONS D14).
   */
  envelopeAddress: string;
}

export function SendOn({
  core,
  secret,
  network,
  note,
  noteCount,
  tipHeight,
  envelopeAddress,
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
  const [warm, setWarm] = useState<"warming" | "ready" | "failed">("warming");
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

  /**
   * The proving key starts building the moment the envelope is found, before the
   * recipient has chosen anything, so most of the wait happens while they read.
   */
  useEffect(() => {
    let alive = true;
    core
      .warm_proving_key()
      .then(() => {
        if (alive) setWarm("ready");
      })
      .catch(() => {
        // A failed warm-up is not fatal: the sweep builds the key itself.
        if (alive) setWarm("failed");
      });
    return () => {
      alive = false;
    };
  }, [core]);

  const inEnvelopeZat = useMemo(() => BigInt(note.amount_zat), [note.amount_zat]);

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

  const active =
    choice === "wallet" ? walletDest : choice === "address" || choice === "solana" ? dest : null;
  const destination = active?.input.trim() ?? "";
  const amounts = sweepAmounts(inEnvelopeZat, active?.kind ?? "unified_orchard");

  /**
   * What the rail would actually be paid: the envelope less the Zcash fees for a
   * transparent destination, because the deposit address is always a `t1`. The
   * swap is quoted on this number, never on the envelope amount.
   */
  const swapInputZat = sweepAmounts(inEnvelopeZat, "transparent").receiveZat;

  /**
   * The rail's deposit address becomes the destination, classified by our own
   * core like any pasted address: the `t1` the rail sent is not trusted because
   * the rail sent it.
   */
  const onSwapPlan = useCallback(
    async (plan: SwapPlan) => {
      setSwap(plan);
      const classified = await classifyDestinationAsync(
        plan.reservation.address,
        core.classify_address,
        network,
      );
      setDest(classified);
      if (classified.canContinue) dispatch({ type: "review" });
    },
    [core, network],
  );

  const ready =
    active !== null &&
    active.canContinue &&
    amounts.ok &&
    (choice !== "wallet" || wroteDown);

  /* ------------------------------------------------------------- the sweep */

  const send = useCallback(async () => {
    const id = ++runId.current;
    dispatch({ type: "send", at: Date.now() });
    try {
      const result = await core.sweep_envelope(
        secret,
        network,
        LIGHTWALLETD[network],
        { txid: note.txid, height: note.height, action_index: note.action_index },
        destination,
        FEE_ADDRESS,
        SWEEP_FEE_ZAT.toString(),
        null,
        // A dry run proves the transaction and never hands it to lightwalletd.
        !dryRun,
        (stage, detail) => {
          if (id === runId.current) dispatch({ type: "stage", stage, detail });
        },
      );
      if (id === runId.current) dispatch({ type: "result", result });
    } catch (err) {
      const message = (err as Error)?.message?.trim();
      if (id === runId.current) {
        dispatch({ type: "failed", message: message ? message : SWEEP_FAILED_COPY });
      }
    }
  }, [core, secret, network, note, destination, dryRun]);

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

  /* ------------------------------------------------------------- the screens */

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
          {state.detail ?? "Starting…"}
        </p>
        <p className="fine">{SEND_TIMING_COPY}</p>
      </div>
    );
  }

  if (state.phase === "sent" && state.result) {
    const received = BigInt(state.result.amount_to_destination_zat);
    // The core is the authority on what happened, not the flag that asked for it.
    const dry = state.result.broadcast === false;
    return (
      <>
        <div className="card stack">
          <h2 data-testid="sent-heading">{dry ? "Dry run complete." : "Sent."}</h2>
          <p className="sent-amount" data-testid="sent-amount">
            {formatZecAmount(received)}
          </p>
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
                {swap ? swapCopy.dryRunLine : DRY_RUN_COPY}
              </p>
              {swap ? (
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
        </div>
        {/* Only a real broadcast has anything for the rail to watch for. */}
        {swap && !dry ? <SwapTracker plan={swap} /> : null}
      </>
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
          onClick={() => dispatch({ type: "choose" })}
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
        <h2>Check this over</h2>
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
        {swap ? <SwapReview plan={swap} /> : null}
        {active.status === "warn" ? (
          <p className="warn" data-testid="review-warning">
            {active.message}
          </p>
        ) : null}
        <button type="button" className="primary" onClick={() => void send()} data-testid="send-it-on">
          Send it on
        </button>
        <p className="fine" data-testid="send-timing">
          {SEND_TIMING_COPY}
        </p>
        <button
          type="button"
          className="ghost"
          onClick={() => dispatch({ type: "choose" })}
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
        onPlan={(plan) => void onSwapPlan(plan)}
        onBack={() => setChoice(null)}
      />
    );
  }

  const onPickAddress = () => {
    setChoice("address");
    setWallet(null);
    setWroteDown(false);
  };

  const onPickWallet = async () => {
    setChoice("wallet");
    setDest(emptyDestination);
    setWroteDown(false);
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

  return (
    <div className="card stack">
      <h2>Where should it go?</h2>
      <p className="hint" data-testid="warm-status">
        {warm === "warming"
          ? `Preparing keys… ${WARM_ESTIMATE}`
          : warm === "ready"
            ? "Keys ready"
            : "The keys will be built when you send."}
      </p>
      {noteCount > 1 ? (
        <p className="hint" data-testid="multi-note">
          This sends on the payment shown above. Any others stay in the envelope.
        </p>
      ) : null}

      <ul className="next-steps">
        <li>
          <button
            type="button"
            onClick={onPickAddress}
            aria-pressed={choice === "address"}
            data-testid="dest-address"
          >
            <span className="next-title">A Zcash address</span>
            <span className="hint">
              Paste any Zcash address and the money moves there, still shielded.
            </span>
          </button>
          {choice === "address" ? (
            <div className="stack dest-panel">
              <label className="field">
                <span className="label">Zcash address</span>
                <input
                  type="text"
                  inputMode="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={dest.input}
                  placeholder="u1…"
                  onChange={(e) => {
                    const input = e.target.value;
                    const id = ++destId.current;
                    // The typed text has to show at once; the verdict lands when the
                    // worker answers, and only if nothing newer has been typed since.
                    setDest({ ...emptyDestination, input });
                    void classifyDestinationAsync(
                      input,
                      core.classify_address,
                      network,
                    ).then((d) => {
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
            </div>
          ) : null}
        </li>

        <li>
          <button
            type="button"
            onClick={() => void onPickWallet()}
            aria-pressed={choice === "wallet"}
            data-testid="dest-wallet"
          >
            <span className="next-title">A new wallet in this browser</span>
            <span className="hint">
              We generate a fresh Zcash wallet here and hand you the seed words to keep.
            </span>
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
                  <p className="hint">
                    These 24 words are the wallet. Write them down now: they are shown here once
                    and are saved nowhere.
                  </p>
                  <ol className="words" data-testid="wallet-words">
                    {wallet.mnemonic.split(" ").map((word, i) => (
                      <li key={`${i}-${word}`} data-testid="wallet-word">
                        <span className="word-n">{i + 1}</span>
                        <span className="word">{word}</span>
                      </li>
                    ))}
                  </ol>
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
                    <span>I wrote these down</span>
                  </label>
                </>
              ) : null}
            </div>
          ) : null}
        </li>

        {/*
          Third of three, and never the headline. Tapping it does not start a swap:
          it opens the trust-boundary screen, whose tick is the only way further.
        */}
        <li>
          <button
            type="button"
            onClick={() => {
              setChoice("solana");
              setWallet(null);
              setWroteDown(false);
              setDest(emptyDestination);
            }}
            aria-pressed={choice === "solana"}
            data-testid="dest-solana"
          >
            <span className="next-title">{swapCopy.cardTitle}</span>
            <span className="hint">{swapCopy.cardBody}</span>
          </button>
        </li>
      </ul>

      {active && !amounts.ok ? (
        <p className="error" data-testid="too-small">
          There is not enough in this envelope to cover the network fee of{" "}
          {formatZecAmount(amounts.networkFeeZat)}.
        </p>
      ) : null}

      <button
        type="button"
        className="primary"
        disabled={!ready}
        onClick={() => dispatch({ type: "review" })}
        data-testid="to-review"
      >
        Continue
      </button>
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
  const cost = effectiveCost(plan.reservation.quote);
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
        {swapCopy.feeLine}
      </p>
      <p className="fine" data-testid="review-swap-not-provider">
        {swapCopy.notProvider}
      </p>
    </>
  );
}
