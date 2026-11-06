/**
 * The Solana exit: the third destination card, and the only place in Zenvelope
 * that leaves the shielded pool.
 *
 * Five screens, driven by the reducer in ../lib/solanaFlow:
 *
 *   trust -> asset -> destination -> quote -> deposit
 *
 * The quote screen can also offer an opt-in "Private route" (off by default): the swap
 * then pays a router wallet this page controls instead of the recipient, and
 * MultiHopper carries the money on (see MultihopTracker). It adds a gate of its own
 * (privateRouteBoundary) before any deposit address is asked for.
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

import { useCallback, useEffect, useMemo, useState } from "react";
import { privateRoute as routeCopy, privateRouteBoundary, solanaExit as copy } from "../copy/en";
import { SOLANA_CLUSTER, oneClickAvailable } from "../lib/cluster";
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
  type OneClickQuote,
  type OneClickQuoteResponse,
  type SolanaAsset,
} from "../lib/oneclick";
import { createMhClient, type MhEstimate } from "../lib/multihop";
import {
  MAX_ROUTE_USD,
  MIN_OFFER_USD,
  extraLamportsNeeded,
  guessExtraZat,
  pricePrivateRoute,
  routeSolFloor,
  sizeExtraZat,
  solUsdFromQuote,
  type RoutePricing,
} from "../lib/privateRoute";
import { SOL_DECIMALS, USDC_DECIMALS, mintFor } from "../lib/routeRun";
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
import { DestinationChoices } from "./DestinationChoices";
import { TrustBoundary } from "./TrustBoundary";

/** The private route's part of a plan: the swap pays the router, MultiHopper pays `finalRecipient`. */
export interface PrivateRoutePlan {
  routerAddress: string;
  /** The wallet the money ends in. */
  finalRecipient: string;
  /**
   * The second deposit (a USDC gift also buys SOL for the route's costs). null for a SOL
   * gift, whose single swap covers both.
   */
  extra: { reservation: DepositReservation; extraZat: bigint } | null;
}

/** What the caller needs to know once the rail has reserved an address. */
export interface SwapPlan {
  reservation: DepositReservation;
  asset: SolanaAsset;
  /**
   * The Solana address the rail will pay out to. With a private route this is the
   * router wallet, and the real destination is in {@link route}.
   */
  recipient: string;
  /** Where a refund goes, as it was actually sent (DECISIONS D14). */
  refundTo: string;
  route?: PrivateRoutePlan;
}

/** A devnet test: no swap, no sweep; the tester funds the router wallet directly. */
export interface DevnetPlan {
  asset: SolanaAsset;
  recipient: string;
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
   * The Zcash side of the cost: the network fee and the service fee the sweep
   * takes before the rail sees anything. Shown as its own row on the quote, so
   * every cost is a number on one screen.
   */
  zcashFeesZat?: bigint;
  /**
   * The core's address classifier, for the refund override and for nothing else
   * (M4). The exit still never sees the secret and never builds a transaction.
   */
  classify: ClassifyAsync;
  network: Network;
  /**
   * The router wallet's address, derived from the link, or null while it is being worked
   * out. Without it the private route is not offered.
   */
  routerAddress?: string | null;
  /**
   * What the main swap would be left with if the sweep also paid `extraZat` to a second
   * deposit address (the ZIP-317 fee rises by one output). From the same arithmetic the
   * sweep itself uses.
   */
  splitFor?: (extraZat: bigint) => { ok: boolean; receiveZat: bigint };
  onPlan(plan: SwapPlan): void;
  /** Devnet only: skip the swap and go straight to funding the router wallet. */
  onDevnet?(plan: DevnetPlan): void;
  onBack(): void;
}

/** What the quote screen knows about the private route. */
type RouteOffer =
  | { status: "off" }
  | { status: "loading" }
  | { status: "ready"; pricing: RoutePricing; estimate: MhEstimate; probe: OneClickQuote | null };

function toReservation(r: OneClickQuoteResponse): DepositReservation {
  return {
    address: r.quote.depositAddress ?? "",
    deadline: r.quote.deadline ?? r.quote.timeWhenInactive ?? null,
    quote: r.quote,
    quoteRequest: r.quoteRequest,
    appFees: r.appFees,
  };
}

/** ISO to something a person reads, in their own time zone. */
function formatDeadline(iso: string | null): string {
  if (!iso) return "not given";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function SolanaExit({
  amountZat,
  envelopeAddress,
  zcashFeesZat,
  classify,
  network,
  routerAddress = null,
  splitFor,
  onPlan,
  onDevnet,
  onBack,
}: Props) {
  const [state, setState] = useState<SolanaExitState>(initialSolanaExitState);
  const devnet = !oneClickAvailable(SOLANA_CLUSTER);
  const mh = useMemo(() => createMhClient(), []);
  // The private route: off by default, behind its own tick.
  const [offer, setOffer] = useState<RouteOffer>({ status: "off" });
  const [privateOn, setPrivateOn] = useState(false);
  const [routeAck, setRouteAck] = useState(false);
  const [atRouteGate, setAtRouteGate] = useState(false);
  const [extra, setExtra] = useState<PrivateRoutePlan["extra"]>(null);
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

  // Leaving the quote screen backwards takes the route choice with it.
  useEffect(() => {
    if (state.phase === "trust" || state.phase === "asset" || state.phase === "destination") {
      setPrivateOn(false);
      setRouteAck(false);
      setAtRouteGate(false);
      setExtra(null);
    }
  }, [state.phase]);

  /**
   * Is the private route worth offering for this quote? Needs the gift's USD value (the
   * quote), SOL's USD price (a dry SOL quote, or the quote itself for a SOL gift) and
   * MultiHopper's estimate for this amount. Any failure just hides the switch: the
   * ordinary swap is unaffected.
   */
  const quoted = state.quote;
  const quotedAsset = state.asset;
  useEffect(() => {
    // The deposit screen is the offer's consequence, not a reason to ask again.
    if (state.phase === "deposit") return;
    setOffer({ status: "off" });
    if (state.phase !== "quote" || !quoted || !quotedAsset) return;
    if (devnet || !routerAddress) return;
    let alive = true;
    setOffer({ status: "loading" });
    void (async () => {
      try {
        const q = quoted.quote;
        const cost = effectiveCost(q);
        if (!cost.ok || cost.amountOutUsd < MIN_OFFER_USD) throw new Error("not worth asking");
        let probe: OneClickQuote | null = null;
        let solUsd: number;
        if (quotedAsset === "sol") solUsd = solUsdFromQuote(q);
        else {
          const sq = await oneClickQuote({
            dry: true,
            asset: "sol",
            amountZat,
            refundTo: envelopeAddress,
            recipient: routerAddress,
          });
          probe = sq.quote;
          solUsd = solUsdFromQuote(sq.quote);
        }
        const estimate = await mh.estimate({
          tokenMint: mintFor(quotedAsset),
          tokenDecimals: quotedAsset === "sol" ? SOL_DECIMALS : USDC_DECIMALS,
          tokenSymbol: quotedAsset === "sol" ? "SOL" : "USDC",
          amountRaw: q.amountOut,
          hops: 3,
          arrivalSeconds: 120,
        });
        const pricing = pricePrivateRoute({
          estimate,
          giftUsd: cost.amountOutUsd,
          solUsd,
          isSolRoute: quotedAsset === "sol",
          oneClickSeconds: q.timeEstimate,
        });
        if (alive) setOffer({ status: "ready", pricing, estimate, probe });
      } catch {
        if (alive) setOffer({ status: "off" });
      }
    })();
    return () => {
      alive = false;
    };
  }, [state.phase, quoted, quotedAsset, devnet, routerAddress, amountZat, envelopeAddress, mh]);

  /**
   * Real quotes for a private route. The swap pays the router wallet. A USDC gift also
   * buys SOL for the route's costs, as a second deposit the sweep pays in the same
   * transaction; a SOL gift needs nothing more, because the route amount is the balance
   * less the overhead.
   */
  const askPrivate = useCallback(
    async (current: SolanaExitState) => {
      if (current.asset === null || offer.status !== "ready" || !routerAddress) return;
      dispatch({ type: "busy" });
      try {
        const refundTo = refundAddress(current, envelopeAddress);
        let mainZat = amountZat;
        let second: PrivateRoutePlan["extra"] = null;
        if (current.asset === "usdc") {
          if (!offer.probe || !splitFor) throw new Error(routeCopy.checking);
          const need = extraLamportsNeeded(offer.estimate);
          const dryMin = async (zat: bigint) =>
            BigInt(
              (
                await oneClickQuote({ dry: true, asset: "sol", amountZat: zat, refundTo, recipient: routerAddress })
              ).quote.minAmountOut,
            );
          const zat = await sizeExtraZat(
            need,
            guessExtraZat(need, amountZat, BigInt(offer.probe.minAmountOut)),
            dryMin,
          );
          const split = splitFor(zat);
          if (!split.ok) throw new Error(routeCopy.routeTooSmall);
          mainZat = split.receiveZat;
          const real = await oneClickQuote({
            dry: false,
            asset: "sol",
            amountZat: zat,
            refundTo,
            recipient: routerAddress,
          });
          // The route's SOL is not a gift, so no spread cap; it must simply be enough.
          if (BigInt(real.quote.minAmountOut) < BigInt(routeSolFloor(offer.estimate))) {
            throw new Error(copy.quoteShortfall);
          }
          second = { reservation: toReservation(real), extraZat: zat };
        }
        const main = await oneClickQuote({
          dry: false,
          asset: current.asset,
          amountZat: mainZat,
          refundTo,
          recipient: routerAddress,
        });
        const verdict = quoteAcceptable(main.quote);
        if (!verdict.ok) throw new Error(verdict.reason ?? copy.quoteUnreadable);
        setExtra(second);
        dispatch({ type: "deposit", reservation: toReservation(main) });
      } catch (err) {
        failQuote(err);
      }
    },
    [amountZat, dispatch, envelopeAddress, failQuote, offer, routerAddress, splitFor],
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

  const back = () => (state.phase === "trust" ? onBack() : dispatch({ type: "back" }));

  /* ----------------------------------------------------- the private-route gate */

  if (atRouteGate) {
    return (
      <TrustBoundary
        content={privateRouteBoundary}
        testId="private-route-boundary"
        acknowledged={routeAck}
        onAcknowledgedChange={setRouteAck}
        onContinue={() => {
          setAtRouteGate(false);
          void askPrivate(state);
        }}
        onBack={() => setAtRouteGate(false)}
      />
    );
  }

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
    return (
      <div className="card stack" data-testid="swap-destination">
        <h2>{copy.destinationTitle}</h2>

        <DestinationChoices state={state} dispatch={dispatch} />

        {/* The refund address. Default: this envelope's own (DECISIONS D14). */}
        {devnet ? null : (
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
        )}

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
          onClick={() => {
            // Devnet has no swap rail: the tester funds the router wallet directly.
            if (devnet && state.asset && onDevnet) {
              onDevnet({ asset: state.asset, recipient: recipientAddress(state) });
              return;
            }
            void askQuote(true, state);
          }}
          data-testid="swap-get-quote"
        >
          {devnet ? copy.continueButton : state.busy ? copy.quoteBusy : copy.quoteButton}
        </button>
        {!destinationReady(state) || !refundReady(state) ? (
          <p className="fine" data-testid="swap-destination-blocked">
            {!refundReady(state)
              ? copy.refundInvalid
              : state.mode === "generate"
                ? copy.keyConfirmBlocked
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

        {zcashFeesZat !== undefined && zcashFeesZat > 0n ? (
          <p className="row">
            <span className="label">{copy.zcashFeesLabel}</span>
            <span data-testid="swap-zcash-fees">{formatZecAmount(zcashFeesZat)}</span>
          </p>
        ) : null}
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

        {/*
          The private route: off by default, and only when its fixed SOL cost is a small
          share of the gift. Below that, one line says where it starts.
        */}
        {offer.status === "loading" ? (
          <p className="fine" data-testid="route-checking">
            {routeCopy.checking}
          </p>
        ) : null}
        {offer.status === "ready" && offer.pricing.available ? (
          <div className="stack route-offer" data-testid="route-offer">
            <label className="check">
              <input
                type="checkbox"
                role="switch"
                checked={privateOn}
                onChange={(e) => setPrivateOn(e.target.checked)}
                data-testid="route-toggle"
              />
              <span>
                <strong>{routeCopy.toggleLabel}</strong>
                <br />
                <span className="hint">{routeCopy.toggleBody}</span>
              </span>
            </label>
            {privateOn ? (
              <p className="fine" data-testid="route-numbers">
                {routeCopy.numbers(
                  formatUsd(offer.pricing.receiveUsd),
                  offer.pricing.minutes,
                  formatUsd(offer.pricing.networkUsd),
                )}
              </p>
            ) : null}
          </div>
        ) : null}
        {offer.status === "ready" && !offer.pricing.available && offer.pricing.reason ? (
          <p className="fine" data-testid="route-unavailable">
            {offer.pricing.reason === "large"
              ? routeCopy.availableUpTo(`$${MAX_ROUTE_USD}`)
              : routeCopy.availableOver(`$${offer.pricing.thresholdUsd}`)}
          </p>
        ) : null}

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
          onClick={() => {
            if (privateOn && offer.status === "ready" && offer.pricing.available) {
              // Its own gate first: MultiHopper, its screening and its audit status.
              if (routeAck) void askPrivate(state);
              else setAtRouteGate(true);
              return;
            }
            void askQuote(false, state);
          }}
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
    const viaRoute = privateOn && routerAddress !== null && offer.status === "ready";
    const plan: SwapPlan = {
      reservation: state.deposit,
      asset: state.asset,
      recipient: viaRoute ? routerAddress! : recipientAddress(state),
      refundTo: refundAddress(state, envelopeAddress),
      route: viaRoute
        ? { routerAddress: routerAddress!, finalRecipient: recipientAddress(state), extra }
        : undefined,
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
        {plan.route ? (
          <>
            <p className="row">
              <span className="label">{routeCopy.routerRow}</span>
              <span className="mono" data-testid="swap-recipient">
                {plan.recipient}
              </span>
            </p>
            <p className="row">
              <span className="label">{routeCopy.finalRow}</span>
              <span className="mono" data-testid="swap-final-recipient">
                {plan.route.finalRecipient}
              </span>
            </p>
            {plan.route.extra ? (
              <>
                <p className="row">
                  <span className="label">{routeCopy.extraRow}</span>
                  <span data-testid="swap-extra-out">
                    {formatAssetAmount(plan.route.extra.reservation.quote, "sol")}
                  </span>
                </p>
                <p className="fine">{routeCopy.extraNote}</p>
              </>
            ) : null}
          </>
        ) : (
          <p className="row">
            <span className="label">Pays out to</span>
            <span className="mono" data-testid="swap-recipient">
              {plan.recipient}
            </span>
          </p>
        )}

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
