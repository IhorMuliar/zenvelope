/**
 * The Solana exit: the third destination card, and the only place in Zenvelope
 * that leaves the shielded pool.
 *
 * Five screens, driven by the reducer in ../lib/solanaFlow:
 *
 *   trust -> asset -> destination -> quote -> deposit
 *
 * and then it stops. The last thing it does is hand its caller a transparent
 * `t1` deposit address; the money moves with the ordinary sweep, unchanged, to
 * that address. Nothing here sees the envelope secret, builds a transaction or
 * touches the core except to double-check the rail's own deposit address.
 *
 * Every screen offers the way back to a shielded destination, and the exit is
 * never the headline: it is behind a required tick on a screen of its own
 * (TrustBoundary), and the first thing it shows after that is what it costs.
 */

import { useCallback, useEffect, useState } from "react";
import { solanaExit as copy } from "../copy/en";
import type { Network } from "../core/types";
import { classifyDestinationAsync, type ClassifyAsync } from "../lib/destination";
import { formatZec, formatZecAmount } from "../lib/format";
import {
  OneClickError,
  appFeeBps,
  effectiveCost,
  formatAssetAmount,
  formatTimeEstimate,
  formatUsd,
  oneClickQuote,
  type OneClickQuoteResponse,
  type SolanaAsset,
} from "../lib/oneclick";
import { ED25519_UNAVAILABLE, checkSolanaAddress, generateSolanaKeypair } from "../lib/solana";
import {
  belowMinimum,
  canGetDeposit,
  canQuote,
  destinationReady,
  initialSolanaExitState,
  quoteAcceptable,
  recipientAddress,
  refundAddress,
  refundReady,
  solanaExitReducer,
  type DepositReservation,
  type SolanaExitState,
} from "../lib/solanaFlow";
import { CopyField } from "./CopyField";
import { TrustBoundary } from "./TrustBoundary";

/** What the caller needs to know once the rail has reserved an address. */
export interface SwapPlan {
  reservation: DepositReservation;
  asset: SolanaAsset;
  /** The Solana address the rail will pay out to. */
  recipient: string;
  /** Where a refund goes, as it was actually sent (DECISIONS D14). */
  refundTo: string;
}

interface Props {
  /**
   * What the sweep would actually pay the rail: the envelope less the Zcash
   * fees for a transparent destination. The rail prices this, not the envelope.
   */
  amountZat: bigint;
  /**
   * The envelope's own unified address. It is the default refund destination,
   * because a refund to it lands back in this envelope and this link opens it
   * again (DECISIONS D14).
   */
  envelopeAddress: string;
  /**
   * The core's address classifier, for the refund override and for nothing else
   * (M4). The exit still never sees the secret and never builds a transaction.
   */
  classify: ClassifyAsync;
  network: Network;
  onPlan(plan: SwapPlan): void;
  onBack(): void;
}

/** ISO to something a person reads, in their own time zone. */
function formatDeadline(iso: string | null): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function SolanaExit({
  amountZat,
  envelopeAddress,
  classify,
  network,
  onPlan,
  onBack,
}: Props) {
  const [state, setState] = useState<SolanaExitState>(initialSolanaExitState);
  const dispatch = useCallback(
    (event: Parameters<typeof solanaExitReducer>[1]) =>
      setState((s) => solanaExitReducer(s, event)),
    [],
  );

  /**
   * The refund override, through the core (M4).
   *
   * It is free text that decides who can recover the money when a swap fails, so
   * it goes through exactly the classifier every other Zcash address in the
   * product goes through — unified with an Orchard receiver, or transparent, on
   * this network — and the quote button stays off until it passes. The empty box
   * is the normal case and needs no check: it means the envelope's own address
   * (DECISIONS D14).
   *
   * The verdict is tagged with the text it was asked about, so an answer the
   * recipient has already typed past cannot land on newer text.
   */
  useEffect(() => {
    const input = state.refundOverride.trim();
    if (input === "") return;
    let alive = true;
    void classifyDestinationAsync(input, classify, network).then((verdict) => {
      if (!alive) return;
      dispatch({
        type: "refundVerdict",
        input,
        ok: verdict.canContinue,
        message: verdict.canContinue
          ? null
          : [copy.refundInvalid, verdict.reason ?? verdict.message].filter(Boolean).join(" "),
      });
    });
    return () => {
      alive = false;
    };
  }, [state.refundOverride, classify, network, dispatch]);

  /** One place turns a thrown {@link OneClickError} into what the screen says. */
  const failQuote = useCallback(
    (err: unknown) => {
      const e = err as OneClickError;
      dispatch({
        type: "quoteError",
        message: e?.message ?? "The swap service did not answer.",
        minAmountZat: e instanceof OneClickError ? e.minAmountZat : null,
      });
    },
    [dispatch],
  );

  const askQuote = useCallback(
    async (dry: boolean, current: SolanaExitState) => {
      if (current.asset === null) return;
      dispatch({ type: "busy" });
      try {
        const response: OneClickQuoteResponse = await oneClickQuote({
          dry,
          asset: current.asset,
          amountZat,
          refundTo: refundAddress(current, envelopeAddress),
          recipient: recipientAddress(current),
        });
        if (dry) {
          dispatch({ type: "quote", quote: response });
          return;
        }
        dispatch({
          type: "deposit",
          reservation: {
            address: response.quote.depositAddress ?? "",
            deadline: response.quote.deadline ?? response.quote.timeWhenInactive ?? null,
            quote: response.quote,
            // Kept so the caller can compare it with what we asked for before it
            // sweeps anything to that address (M6).
            quoteRequest: response.quoteRequest,
            appFees: response.appFees,
          },
        });
      } catch (err) {
        failQuote(err);
      }
    },
    [amountZat, dispatch, envelopeAddress, failQuote],
  );

  const makeKeypair = useCallback(async () => {
    try {
      dispatch({ type: "keypair", keypair: await generateSolanaKeypair() });
    } catch (err) {
      dispatch({ type: "keypairError", message: (err as Error).message || ED25519_UNAVAILABLE });
    }
  }, [dispatch]);

  const back = () => (state.phase === "trust" ? onBack() : dispatch({ type: "back" }));

  /* ----------------------------------------------------------------- trust */

  if (state.phase === "trust") {
    return (
      <TrustBoundary
        acknowledged={state.acknowledged}
        onAcknowledgedChange={(value) => dispatch({ type: "ack", value })}
        onContinue={() => dispatch({ type: "toAsset" })}
        onBack={onBack}
      />
    );
  }

  /* ----------------------------------------------------------------- asset */

  if (state.phase === "asset") {
    return (
      <div className="card stack" data-testid="swap-asset">
        <h2>{copy.assetTitle}</h2>
        <p className="hint">{copy.assetLede}</p>
        <ul className="next-steps">
          <li>
            <button
              type="button"
              onClick={() => dispatch({ type: "asset", asset: "usdc" })}
              data-testid="swap-asset-usdc"
            >
              <span className="next-title">{copy.usdcTitle}</span>
              <span className="hint">{copy.usdcBody}</span>
            </button>
          </li>
          <li>
            <button
              type="button"
              onClick={() => dispatch({ type: "asset", asset: "sol" })}
              data-testid="swap-asset-sol"
            >
              <span className="next-title">{copy.solTitle}</span>
              <span className="hint">{copy.solBody}</span>
            </button>
          </li>
        </ul>
        <p className="fine" data-testid="swap-not-provider">
          {copy.notProvider}
        </p>
        <button type="button" className="ghost wide" onClick={back} data-testid="swap-back">
          {copy.back}
        </button>
      </div>
    );
  }

  /* ----------------------------------------------------------- destination */

  if (state.phase === "destination") {
    const problem = state.mode === "paste" ? checkSolanaAddress(state.pasted) : null;
    const feedback =
      problem === "charset"
        ? copy.invalidCharset
        : problem === "length"
          ? copy.invalidLength
          : problem === null && state.pasted.trim() !== ""
            ? copy.valid
            : null;

    return (
      <div className="card stack" data-testid="swap-destination">
        <h2>{copy.destinationTitle}</h2>

        <ul className="next-steps">
          <li>
            <button
              type="button"
              onClick={() => dispatch({ type: "mode", mode: "paste" })}
              aria-pressed={state.mode === "paste"}
              data-testid="swap-mode-paste"
            >
              <span className="next-title">{copy.pasteTitle}</span>
              <span className="hint">{copy.pasteBody}</span>
            </button>
            {state.mode === "paste" ? (
              <div className="stack dest-panel">
                <label className="field">
                  <span className="label">{copy.pasteLabel}</span>
                  <input
                    type="text"
                    inputMode="text"
                    autoComplete="off"
                    spellCheck={false}
                    value={state.pasted}
                    placeholder="Solana address"
                    onChange={(e) => dispatch({ type: "pasted", value: e.target.value })}
                    data-testid="swap-address-input"
                  />
                </label>
                {feedback ? (
                  <p
                    className={problem === null ? "hint" : "error"}
                    data-status={problem === null ? "ok" : "error"}
                    aria-live="polite"
                    data-testid="swap-address-feedback"
                  >
                    {feedback}
                  </p>
                ) : null}
              </div>
            ) : null}
          </li>

          <li>
            <button
              type="button"
              onClick={() => {
                dispatch({ type: "mode", mode: "generate" });
                if (!state.keypair) void makeKeypair();
              }}
              aria-pressed={state.mode === "generate"}
              data-testid="swap-mode-generate"
            >
              <span className="next-title">{copy.generateTitle}</span>
              <span className="hint">{copy.generateBody}</span>
            </button>
            {state.mode === "generate" ? (
              <div className="stack dest-panel">
                {state.keypairError ? (
                  <p className="error" data-testid="swap-keypair-error">
                    {state.keypairError}
                  </p>
                ) : null}
                {state.keypair ? (
                  <>
                    <p className="warn" data-testid="swap-secret-once">
                      {copy.secretOnce}
                    </p>
                    <CopyField
                      label={copy.secretLabel}
                      value={state.keypair.secretKeyBase58}
                      testId="swap-secret-key"
                    />
                    <CopyField
                      label={copy.addressLabel}
                      value={state.keypair.address}
                      testId="swap-keypair-address"
                    />
                    <p className="hint" data-testid="swap-import-hint">
                      {copy.importHint}
                    </p>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={state.savedKey}
                        onChange={(e) => dispatch({ type: "savedKey", value: e.target.checked })}
                        data-testid="swap-saved-key"
                      />
                      <span>{copy.savedCheckbox}</span>
                    </label>
                    {!state.savedKey ? (
                      <p className="hint" data-testid="swap-saved-blocked">
                        {copy.savedBlockedHint}
                      </p>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}
          </li>
        </ul>

        {/* The refund address. Default: this envelope's own (DECISIONS D14). */}
        <details className="stack" data-testid="swap-refund">
          <summary>{copy.refundTitle}</summary>
          <p className="hint" data-testid="swap-refund-default">
            {copy.refundDefault}
          </p>
          <label className="field">
            <span className="label">{copy.refundOverrideLabel}</span>
            <input
              type="text"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              value={state.refundOverride}
              placeholder="u1…"
              onChange={(e) => dispatch({ type: "refund", value: e.target.value })}
              data-testid="swap-refund-input"
            />
          </label>
          {state.refundStatus !== "default" ? (
            <p
              className={state.refundStatus === "bad" ? "error" : "hint"}
              data-status={state.refundStatus}
              aria-live="polite"
              data-testid="swap-refund-feedback"
            >
              {state.refundStatus === "checking"
                ? copy.refundChecking
                : state.refundStatus === "ok"
                  ? copy.refundOk
                  : state.refundMessage}
            </p>
          ) : null}
          <p className="fine">{copy.refundOverrideHint}</p>
        </details>

        {/*
          The floor is the common failure, and it deserves the product's own
          sentence rather than the rail's. The rail's wording is kept underneath,
          because a number nobody can check against the source is worth less.
        */}
        {belowMinimum(state, amountZat) && state.minAmountZat !== null ? (
          <>
            <p className="error" data-testid="swap-minimum">
              {copy.minimum(formatZec(state.minAmountZat))}
            </p>
            <p className="fine" data-testid="swap-error">
              {state.error}
            </p>
          </>
        ) : state.error ? (
          <p className="error" data-testid="swap-error">
            {state.error}
          </p>
        ) : null}

        <button
          type="button"
          className="primary"
          disabled={!canQuote(state)}
          onClick={() => void askQuote(true, state)}
          data-testid="swap-get-quote"
        >
          {state.busy ? copy.quoteBusy : copy.quoteButton}
        </button>
        {!destinationReady(state) || !refundReady(state) ? (
          <p className="fine" data-testid="swap-destination-blocked">
            {!refundReady(state)
              ? copy.refundInvalid
              : state.mode === "generate"
                ? copy.savedBlockedHint
                : copy.pasteBody}
          </p>
        ) : null}
        <button type="button" className="ghost wide" onClick={back} data-testid="swap-back">
          {copy.back}
        </button>
      </div>
    );
  }

  /* ----------------------------------------------------------------- quote */

  if (state.phase === "quote" && state.quote && state.asset) {
    const quote = state.quote.quote;
    const cost = effectiveCost(quote, appFeeBps(state.quote));
    const low = belowMinimum(state, amountZat);
    // The cap on the cost of leaving, and the rail's own minAmountOut (M5). A
    // quote that fails either is shown in full and cannot be acted on.
    const verdict = quoteAcceptable(quote);
    return (
      <div className="card stack" data-testid="swap-quote">
        <h2>{copy.quoteTitle}</h2>

        <p className="row">
          <span className="label">You send</span>
          <span data-testid="swap-amount-in">
            {formatZecAmount(amountZat)} · {formatUsd(cost.amountInUsd)}
          </span>
        </p>
        <p className="row receive">
          <span className="label">{copy.amountOutLabel}</span>
          <strong data-testid="swap-amount-out">{formatAssetAmount(quote, state.asset)}</strong>
        </p>
        <p className="row">
          <span className="label">Worth</span>
          <span data-testid="swap-amount-out-usd">{formatUsd(cost.amountOutUsd)}</span>
        </p>
        <p className="row">
          <span className="label">{copy.spreadLabel}</span>
          <span data-testid="swap-spread">
            {cost.spreadPct} · {formatUsd(cost.costUsd)}
          </span>
        </p>
        <p className="row">
          <span className="label">{copy.timeLabel}</span>
          <span data-testid="swap-time">{formatTimeEstimate(quote.timeEstimate)}</span>
        </p>

        <p className="fine" data-testid="swap-fee-line">
          {cost.disclosure}
        </p>
        <p className="fine" data-testid="swap-spread-note">
          {copy.spreadNote}
        </p>

        <details data-testid="swap-provider-sees">
          <summary>{copy.providerSeesTitle}</summary>
          <p className="hint">{copy.providerSees}</p>
          <p className="hint" data-testid="swap-refund-note">
            {copy.refundDefault} {copy.refundFeeNote(formatZecAmount(BigInt(quote.refundFee)))}
          </p>
        </details>

        {low && state.minAmountZat !== null ? (
          <p className="error" data-testid="swap-minimum">
            {copy.minimum(formatZec(state.minAmountZat))}
          </p>
        ) : null}
        {!verdict.ok ? (
          <p className="error" data-testid="swap-quote-refused">
            {verdict.reason}
          </p>
        ) : null}
        {state.error && !low ? (
          <p className="error" data-testid="swap-error">
            {state.error}
          </p>
        ) : null}

        <p className="fine" data-testid="swap-not-provider">
          {copy.notProvider}
        </p>

        <button
          type="button"
          className="primary"
          disabled={!canGetDeposit(state, amountZat)}
          onClick={() => void askQuote(false, state)}
          data-testid="swap-get-deposit"
        >
          {state.busy ? copy.quoteBusy : "Get deposit address"}
        </button>
        <button type="button" className="ghost wide" onClick={back} data-testid="swap-back">
          {copy.back}
        </button>
      </div>
    );
  }

  /* --------------------------------------------------------------- deposit */

  if (state.phase === "deposit" && state.deposit && state.asset) {
    const plan: SwapPlan = {
      reservation: state.deposit,
      asset: state.asset,
      recipient: recipientAddress(state),
      refundTo: refundAddress(state, envelopeAddress),
    };
    return (
      <div className="card stack" data-testid="swap-deposit">
        <h2>{copy.depositTitle}</h2>
        <p className="hint">{copy.depositLede}</p>

        <CopyField
          label={copy.depositLabel}
          value={state.deposit.address}
          testId="swap-deposit-address"
        />
        <p className="fine">{copy.depositNoMemo}</p>

        <p className="row">
          <span className="label">{copy.deadlineLabel}</span>
          <span data-testid="swap-deadline">{formatDeadline(state.deposit.deadline)}</span>
        </p>
        <p className="fine">{copy.deadlineNote}</p>

        <p className="row">
          <span className="label">{copy.amountOutLabel}</span>
          <strong data-testid="swap-deposit-amount-out">
            {formatAssetAmount(state.deposit.quote, state.asset)}
          </strong>
        </p>
        <p className="row">
          <span className="label">Pays out to</span>
          <span className="mono" data-testid="swap-recipient">
            {plan.recipient}
          </span>
        </p>

        <p className="fine" data-testid="swap-not-provider">
          {copy.notProvider}
        </p>

        <button
          type="button"
          className="primary"
          onClick={() => onPlan(plan)}
          data-testid="swap-continue"
        >
          {copy.depositContinue}
        </button>
        <button type="button" className="ghost wide" onClick={back} data-testid="swap-back">
          {copy.back}
        </button>
      </div>
    );
  }

  // Only reachable if a phase and its data ever disagree; a way back beats a blank.
  return (
    <div className="card stack">
      <button type="button" className="ghost wide" onClick={onBack} data-testid="swap-back">
        {copy.back}
      </button>
    </div>
  );
}
