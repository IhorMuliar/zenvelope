import { useEffect, useMemo, useRef, useState } from "react";
import {
  FLAT_FEE_ZAT,
  LIGHTWALLETD,
  LIGHTWALLETD_FALLBACK,
  MAX_MEMO_BYTES,
  NETWORK_FEE_ZAT,
  SENDER_WALLETS,
} from "../config";
import type { LoadedCore, Network } from "../core/types";
import { loadCore } from "../core";
import { feeBreakdown, validateAmount, type Breakdown } from "../lib/amount";
import { formatZec, memoByteLength, truncateMiddle } from "../lib/format";
import { MAX_FROM_CHARS, composeMemo } from "../lib/memo";
import { fetchChainHeight } from "../lib/grpcweb";
import {
  MAX_ENVELOPES,
  buildCsv,
  csvFilename,
  generateGroup,
  groupTotal,
  validateCount,
  zecMultiple,
  type GroupEnvelope,
} from "../lib/group";
import { CopyField } from "../components/CopyField";
import { CopyButton } from "../components/CopyButton";
import { Envelope } from "../components/Envelope";
import { EnvelopePreview } from "../components/EnvelopePreview";
import { Qr } from "../components/Qr";
import { ShareButton, canShare } from "../components/ShareButton";
import { group as groupCopy, landing, single as singleCopy, watch as watchCopy } from "../copy/en";
import { gatewayList } from "../lib/openFlow";
import { zatToZecString } from "../core/mock";
import { randomSeed, seedForAddress } from "../lib/guilloche";
import { prefersReducedMotion } from "../lib/motion";
import {
  createPaymentWatch,
  finalLink,
  linkParts,
  toCheckResult,
  type PaymentWatch,
  type WatchSnapshot,
  type WatchTarget,
} from "../lib/paymentWatch";

/**
 * What one submission produced.
 *
 * One envelope or fifty, the shape is the same: the difference is only which
 * screen renders it. Every secret in `rows` lives in this React state and in
 * nothing else: not localStorage, not a query string, not a log, not a
 * request. Leaving the page loses them, and that is the design.
 */
interface Created {
  rows: GroupEnvelope[];
  /** Per envelope: amount + flat fee = what one sender payment must be. */
  breakdown: Breakdown;
  birthday: number | null;
  heightSource: string | null;
  network: Network;
  /** The message as typed, trimmed, without the From line. */
  message: string;
  /** The sender's name as typed, or "". */
  from: string;
  /** The core that made them, which the payment watch asks to look for the payment. */
  core: LoadedCore;
}

interface CreateProps {
  /** In-app navigation, for the "how it works" link under the form. */
  navigate?: (to: string) => void;
}

export function Create({ navigate }: CreateProps = {}) {
  const [core, setCore] = useState<LoadedCore | null>(null);
  const [amount, setAmount] = useState("");
  const [count, setCount] = useState("1");
  const [groupOpen, setGroupOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [from, setFrom] = useState("");
  const [busy, setBusy] = useState(false);
  /**
   * How far a group is: `[made, total]`, or null when nothing is being made.
   *
   * From M4 every derivation is a round trip to the core worker, so fifty
   * envelopes are fifty awaited round trips. The button counts them off rather
   * than sitting on "Creating…" for the whole run.
   */
  const [madeSoFar, setMadeSoFar] = useState<[number, number] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  /** The seal animation on the landing object, played while the envelope is made. */
  const [sealing, setSealing] = useState(false);
  /** No envelope exists yet, so the landing note is printed from a random seed. */
  const [landingSeed] = useState(randomSeed);

  const testnetUnlocked = useMemo(
    () => new URLSearchParams(window.location.search).get("net") === "test",
    [],
  );
  const [network, setNetwork] = useState<Network>(testnetUnlocked ? "test" : "main");

  useEffect(() => {
    let alive = true;
    loadCore().then((c) => {
      if (alive) setCore(c);
    });
    return () => {
      alive = false;
    };
  }, []);

  const validation = amount.trim() === "" ? null : validateAmount(amount);
  const countCheck = groupOpen ? validateCount(count) : ({ ok: true, count: 1 } as const);
  // The memo limit is a byte limit over everything the memo will carry: the
  // message and the From line together.
  const memo = composeMemo(message, from);
  const memoBytes = memoByteLength(memo);
  const memoTooLong = memoBytes > MAX_MEMO_BYTES;
  const preview =
    validation && validation.ok ? feeBreakdown(validation.zat, FLAT_FEE_ZAT) : null;
  const n = countCheck.ok ? countCheck.count : 1;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const v = validateAmount(amount);
    if (!v.ok) {
      setError(v.error);
      return;
    }
    const c = groupOpen ? validateCount(count) : ({ ok: true, count: 1 } as const);
    if (!c.ok) {
      setError(c.error);
      return;
    }
    if (memoTooLong) {
      setError(landing.memoTooLong(memoBytes, MAX_MEMO_BYTES));
      return;
    }
    setBusy(true);
    setMadeSoFar(c.count > 1 ? [0, c.count] : null);
    // The note slides in, the flap closes, the seal stamps: about a second,
    // played while the core works, and skipped when motion is reduced.
    setSealing(true);
    const sealed = prefersReducedMotion()
      ? Promise.resolve()
      : new Promise<void>((resolve) => window.setTimeout(resolve, SEAL_MS));
    try {
      const loaded = core ?? (await loadCore());
      if (!core) setCore(loaded);

      // One height fetch for the whole group: N links cost N derivations and no
      // extra network.
      const chain = await fetchChainHeight(LIGHTWALLETD[network], LIGHTWALLETD_FALLBACK[network]);

      // Every secret, address, fragment and URI below is a round trip to the core
      // worker: the wasm lives there and only there, so the secrets are made there
      // and kept on neither side once the call is answered.
      const rows = await generateGroup(
        loaded,
        {
          count: c.count,
          envelopeZat: v.zat,
          feeZat: FLAT_FEE_ZAT,
          message: memo,
          network,
          birthday: chain?.height,
          origin: window.location.origin,
        },
        c.count > 1 ? (made, total) => setMadeSoFar([made, total]) : undefined,
      );

      await sealed;
      setCreated({
        rows,
        breakdown: feeBreakdown(v.zat, FLAT_FEE_ZAT),
        birthday: chain?.height ?? null,
        heightSource: chain?.source ?? null,
        network,
        message: message.trim(),
        from: from.trim(),
        core: loaded,
      });
      window.scrollTo?.(0, 0);
    } catch (err) {
      setSealing(false);
      setError((err as Error).message || "Could not create the envelope.");
    } finally {
      setBusy(false);
      setMadeSoFar(null);
    }
  }

  const reset = () => {
    setCreated(null);
    setSealing(false);
    setAmount("");
    setCount("1");
    setGroupOpen(false);
    setMessage("");
    setFrom("");
  };

  if (created) {
    const isMock = core?.isMock ?? true;
    return created.rows.length === 1 ? (
      <SingleResult created={created} isMock={isMock} onReset={reset} />
    ) : (
      <GroupResult created={created} isMock={isMock} onReset={reset} />
    );
  }

  /** "Creating…", or "Creating 7 of 20…" once a group is under way. */
  const submitLabel = busy
    ? madeSoFar
      ? `Creating ${madeSoFar[0]} of ${madeSoFar[1]}…`
      : landing.submitBusy
    : n === 1
      ? landing.submit
      : landing.submitMany;

  const typed = amount.trim();
  const noteAmount = /^\d{1,9}(\.\d{0,8})?$/.test(typed) ? typed : "";

  return (
    <section className="landing">
      <div className="landing-hero">
      <div className="landing-object">
        <Envelope
          state={sealing ? "sealed" : "open"}
          rise
          size="hero"
          note={{
            amount: noteAmount || landing.presets[0],
            memo: message,
            from,
            seed: landingSeed,
            tilt: true,
            className: noteAmount ? "" : "is-placeholder",
          }}
        />
      </div>
      <div className="stack landing-copy">
      <div className="stack tight">
        <h1>{landing.headline}</h1>
        <p className="lede" data-testid="landing-subline">
          {landing.subline}
        </p>
      </div>
      {core?.isMock ? <MockBadge /> : null}

      <form className="card form-card stack" onSubmit={onSubmit} aria-label="Make an envelope">
        <div className="field">
          <label className="label strong" htmlFor="zv-amount">
            {landing.amountLabel}
          </label>
          <div className="amount-box">
            <input
              id="zv-amount"
              className="amount-input"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.01"
              value={amount}
              data-testid="amount"
              aria-invalid={validation ? !validation.ok : undefined}
              aria-describedby="zv-amount-help"
              onChange={(e) => setAmount(e.target.value)}
            />
            <span className="amount-unit" aria-hidden="true">
              {landing.amountUnit}
            </span>
          </div>
          {validation && !validation.ok ? (
            <span className="error" id="zv-amount-help" data-testid="amount-error">
              {validation.error}
            </span>
          ) : (
            <span className="hint" id="zv-amount-help">
              {landing.amountHint}
            </span>
          )}
          <div className="chips" role="group" aria-label="Quick amounts">
            {landing.presets.map((p) => (
              <button
                key={p}
                type="button"
                className="chip"
                aria-pressed={amount.trim() === p}
                data-testid={`preset-${p}`}
                onClick={() => setAmount(p)}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        <label className="field">
          <span className="label strong">{landing.messageLabel}</span>
          <input
            autoComplete="off"
            placeholder={landing.messagePlaceholder}
            value={message}
            data-testid="message"
            aria-invalid={memoTooLong}
            onChange={(e) => setMessage(e.target.value)}
          />
        </label>

        <label className="field">
          <span className="label strong">{landing.fromLabel}</span>
          <input
            autoComplete="off"
            placeholder={landing.fromPlaceholder}
            value={from}
            maxLength={MAX_FROM_CHARS}
            data-testid="from"
            aria-invalid={memoTooLong}
            onChange={(e) => setFrom(e.target.value)}
          />
          {memoTooLong ? (
            <span className="error" data-testid="message-error">
              {landing.memoTooLong(memoBytes, MAX_MEMO_BYTES)}
            </span>
          ) : (
            <span className="hint" data-testid="message-count">
              {landing.memoHint(memoBytes, MAX_MEMO_BYTES)}
              {n > 1 ? " Every envelope in the group carries the same message." : ""}
            </span>
          )}
        </label>

        {groupOpen ? (
          <label className="field count-field">
            <span className="label strong">{landing.countLabel}</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_ENVELOPES}
              step={1}
              autoComplete="off"
              value={count}
              data-testid="count"
              aria-invalid={!countCheck.ok}
              onChange={(e) => setCount(e.target.value)}
            />
            {countCheck.ok ? (
              <span className="hint">{landing.countHint}</span>
            ) : (
              <span className="error" data-testid="count-error">
                {countCheck.error}
              </span>
            )}
          </label>
        ) : null}

        {testnetUnlocked ? (
          <fieldset className="field net">
            <legend className="label">Network</legend>
            <label>
              <input
                type="radio"
                name="network"
                checked={network === "main"}
                onChange={() => setNetwork("main")}
              />
              Mainnet
            </label>
            <label>
              <input
                type="radio"
                name="network"
                checked={network === "test"}
                onChange={() => setNetwork("test")}
              />
              Testnet
            </label>
          </fieldset>
        ) : null}

        {preview ? (
          <p className="hint" data-testid="preview-total">
            {n === 1
              ? `You will send ${preview.total} ZEC: ${preview.envelope} ZEC in the envelope plus a ${preview.fee} ZEC service fee.`
              : `You will send ${zecMultiple(preview.totalZat, n)} ZEC in total: ${n} payments of ${preview.total} ZEC, each ${preview.envelope} ZEC in the envelope plus a ${preview.fee} ZEC service fee.`}
          </p>
        ) : null}

        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}

        <button type="submit" className="primary" disabled={busy} data-testid="create">
          {submitLabel}
        </button>

        {/* The core is one worker thread holding one wasm module, so a group of
            fifty is fifty round trips and takes a visible moment. Say so. */}
        {madeSoFar ? (
          <p className="hint" data-testid="group-progress" aria-live="polite">
            {`Making ${madeSoFar[1]} envelopes in your browser: ${madeSoFar[0]} done.`}
          </p>
        ) : null}

        <p className="hint group-ask">
          {groupOpen ? null : <>{landing.groupAsk} </>}
          <button
            type="button"
            className="text-button"
            aria-expanded={groupOpen}
            data-testid="group-toggle"
            onClick={() => {
              setGroupOpen(!groupOpen);
              setCount("1");
            }}
          >
            {groupOpen ? landing.groupHide : landing.groupLink}
          </button>
        </p>
      </form>
      </div>
      </div>

      <div className="landing-more">
      <section className="stack tight" data-testid="how-steps" aria-labelledby="zv-how">
        <h2 id="zv-how">{landing.howTitle}</h2>
        <ol className="numbered">
          {landing.howSteps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p className="hint">
          <a
            href="/how"
            onClick={(e) => {
              if (!navigate || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              navigate("/how");
            }}
          >
            {landing.howMore}
          </a>
        </p>
      </section>

      <section className="stack tight" data-testid="safe-by-design" aria-labelledby="zv-safe">
        <h2 id="zv-safe">{landing.safeTitle}</h2>
        <p className="hint">{landing.safeLine}</p>
        <p className="hint" data-testid="never-ask">
          {landing.neverAsk}
        </p>
      </section>
      </div>
    </section>
  );
}

/** How long the landing seal plays before step 1, in milliseconds. */
const SEAL_MS = 1050;

function MockBadge() {
  return (
    <p className="badge" data-testid="mock-badge">
      MOCK CORE: no WASM build found. Addresses on this page are placeholders and are not
      spendable. Do not send real ZEC.
    </p>
  );
}

function Birthday({ created }: { created: Created }) {
  return (
    <p className="hint">
      {created.birthday !== null
        ? `Birthday height ${created.birthday}, from ${created.heightSource}.`
        : "Chain height unavailable, so these links carry no birthday. Opening one will scan from further back."}
      {created.network === "test" ? " Testnet." : ""}
    </p>
  );
}

/* ------------------------------------------------------------ payment watch */

/**
 * Watches the chain for the payment(s) of what was just created, while this tab
 * is open. See src/lib/paymentWatch.ts for the schedule. The secrets it looks
 * with are the ones already in `created`; nothing new is kept anywhere.
 *
 * Without a birthday there is nothing cheap to watch from — the first look
 * would scan ten thousand blocks — so no watch is started and the page says so.
 */
function usePaymentWatch(created: Created): {
  snap: WatchSnapshot | null;
  restart: () => void;
} {
  const [snap, setSnap] = useState<WatchSnapshot | null>(null);
  const ref = useRef<PaymentWatch | null>(null);

  useEffect(() => {
    const birthday = created.birthday;
    if (birthday === null) return;
    const targets: WatchTarget[] = [];
    for (const r of created.rows) {
      const parts = linkParts(r.link);
      if (parts) targets.push({ id: r.index, secret: parts.secret, birthday });
    }
    const hosts = gatewayList([
      LIGHTWALLETD[created.network],
      LIGHTWALLETD_FALLBACK[created.network],
    ]);
    const w = createPaymentWatch({
      targets,
      check: async (target, fromHeight) =>
        toCheckResult(
          await created.core.open_envelope(target.secret, fromHeight, created.network, hosts),
        ),
      onChange: setSnap,
    });
    ref.current = w;
    const onVisibility = () => w.setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    w.setHidden(document.hidden);
    w.start();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      w.dispose();
      ref.current = null;
    };
  }, [created]);

  return { snap, restart: () => ref.current?.restart() };
}

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** The status line under "Waiting for your payment", for either screen. */
function WatchStatus({
  snap,
  total,
  onRestart,
}: {
  snap: WatchSnapshot | null;
  total: number;
  onRestart: () => void;
}) {
  if (!snap || snap.phase === "done") return null;
  let line: string;
  switch (snap.phase) {
    case "checking":
      line =
        total > 1 && snap.current !== null
          ? watchCopy.checkingOne(snap.current, total)
          : watchCopy.checking;
      break;
    case "paused":
      line = watchCopy.paused;
      break;
    case "stopped":
      line = watchCopy.stopped;
      break;
    default:
      line =
        snap.lastCheckedAt === null
          ? watchCopy.firstLook
          : watchCopy.nothingYet(clockTime(snap.lastCheckedAt));
  }
  return (
    <>
      <p
        className="hint"
        aria-live="polite"
        data-testid="watch-status"
        data-phase={snap.phase}
        data-rounds={snap.rounds}
      >
        {line}
      </p>
      {snap.errors > 0 ? (
        <p className="hint" data-testid="watch-errors">
          {watchCopy.errors(snap.errors)}
        </p>
      ) : null}
      {snap.phase === "stopped" ? (
        <button type="button" className="ghost" onClick={onRestart} data-testid="watch-again">
          {watchCopy.checkAgain}
        </button>
      ) : null}
    </>
  );
}

/* ------------------------------------------------- one envelope: the wizard */

/** A phone or tablet, where a zcash: link opens the wallet app on this device. */
function isTouchDevice(): boolean {
  try {
    if (window.matchMedia?.("(pointer: coarse)").matches) return true;
    // Some browsers and emulators report a fine pointer on a touch screen.
    return (navigator.maxTouchPoints ?? 0) > 0 && "ontouchstart" in window;
  } catch {
    return false;
  }
}

/** The step heading takes focus on each step, so a screen reader hears the new step. */
function useStepFocus(step: number) {
  const ref = useRef<HTMLHeadingElement | null>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    ref.current?.focus();
    window.scrollTo?.(0, 0);
  }, [step]);
  return ref;
}

/**
 * One envelope, in three steps: save the link, pay, send it.
 *
 * The link is shown once and saved before anything else, because after the
 * payment it is the money. The preview of what the recipient will see stays on
 * every step. The payment watch runs for the whole wizard, so a payment that
 * lands while the sender is still on step 1 is not missed.
 */
function SingleResult({
  created,
  isMock,
  onReset,
}: {
  created: Created;
  isMock: boolean;
  onReset: () => void;
}) {
  const envelope = created.rows[0];
  const { snap, restart } = usePaymentWatch(created);
  const paid = snap?.paid.get(envelope.index) ?? null;
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [saved, setSaved] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [takeBackOpen, setTakeBackOpen] = useState(false);
  const touch = useMemo(isTouchDevice, []);
  const share = useMemo(canShare, []);
  const heading = useStepFocus(step);

  // The payment landing moves the sender on from the pay step by itself.
  useEffect(() => {
    if (paid && step === 2) setStep(3);
  }, [paid, step]);

  const b = created.breakdown;
  const preview = (
    <EnvelopePreview
      amount={b.envelope}
      message={created.message}
      from={created.from}
      seed={seedForAddress(envelope.address)}
    />
  );
  /** Each step: the step itself, and beside it (below it on a phone) the note. */
  const layout = (n: 1 | 2 | 3, main: React.ReactNode) => (
    <section className="wizard" data-testid="wizard" data-step={n}>
      <div className="stack wizard-main">{main}</div>
      {preview}
    </section>
  );
  const badge = isMock ? <MockBadge /> : null;
  const stepOf = (
    <p className="step-of" data-testid="step-of">
      {singleCopy.stepOf(step)}
    </p>
  );

  if (step === 1) {
    return layout(
      1,
      <>
        {stepOf}
        <h1 ref={heading} tabIndex={-1}>
          {singleCopy.saveTitle}
        </h1>
        {badge}
        <p className="lede">{singleCopy.saveLede}</p>
        <div className="stack tight">
          <span className="label">{singleCopy.linkLabel}</span>
          <code className="value mono link-full" data-testid="envelope-link">
            {envelope.link}
          </code>
          <div className="button-row">
            <CopyButton
              value={envelope.link}
              label={singleCopy.copy}
              face={singleCopy.copy}
              className="secondary"
              testId="copy-link"
            />
            <ShareButton
              url={envelope.link}
              face={singleCopy.share}
              className="secondary"
              testId="share-link-button"
            />
          </div>
        </div>
        <p className="warn" data-testid="keep-warn">
          {singleCopy.keepWarn}
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={saved}
            onChange={(e) => setSaved(e.target.checked)}
            data-testid="saved-link"
          />
          <span>{singleCopy.savedCheckbox}</span>
        </label>
        <button
          type="button"
          className="primary"
          disabled={!saved}
          onClick={() => {
            if (!saved) return;
            setStep(paid ? 3 : 2);
          }}
          data-testid="to-pay"
        >
          {singleCopy.saveContinue}
        </button>
        {!saved ? (
          <p className="hint" data-testid="saved-blocked">
            {singleCopy.savedBlocked}
          </p>
        ) : null}
      </>,
    );
  }

  if (step === 2) {
    const openWallet = (primary: boolean) => (
      <a
        className={primary ? "button primary" : "button secondary"}
        href={envelope.uri}
        data-testid="open-wallet"
      >
        {singleCopy.openWallet}
      </a>
    );
    return layout(
      2,
      <>
        {stepOf}
        <h1 ref={heading} tabIndex={-1}>
          {singleCopy.payTitle(b.total)}
        </h1>
        {badge}
        {touch ? openWallet(true) : null}
        <div className="stack tight pay-qr">
          <Qr value={envelope.uri} />
          {touch ? <p className="hint center-text">{singleCopy.scanHint}</p> : null}
        </div>
        {touch ? null : openWallet(false)}

        <div className="receipt" data-testid="breakdown">
          <p className="row">
            <span>{singleCopy.inEnvelope}</span>
            <span data-testid="breakdown-envelope">{b.envelope} ZEC</span>
          </p>
          <p className="row">
            <span>{singleCopy.serviceFee}</span>
            <span data-testid="breakdown-fee">{b.fee} ZEC</span>
          </p>
          <p className="row total">
            <span>{singleCopy.total}</span>
            <strong data-testid="breakdown-total">{b.total} ZEC</strong>
          </p>
        </div>
        <p className="hint">{singleCopy.walletFee}</p>
        <p className="hint">{singleCopy.recipientFee(formatZec(NETWORK_FEE_ZAT))}</p>
        <p className="hint">
          {singleCopy.wallets(SENDER_WALLETS)} <strong>{singleCopy.fundWarn}</strong>
        </p>

        <div className="status-card" data-testid="watch-card" data-paid={paid ? "yes" : "no"}>
          <p className="status-line" data-testid="watch-waiting" aria-live="polite">
            <span className="dot" aria-hidden="true" />
            {watchCopy.waitingLine}
          </p>
          {created.birthday === null ? (
            <p className="hint" data-testid="watch-off">
              {watchCopy.noHeight}
            </p>
          ) : (
            <WatchStatus snap={snap} total={1} onRestart={restart} />
          )}
        </div>
        <p className="hint" data-testid="can-close">
          {singleCopy.canClose}
        </p>

        <details className="extras">
          <summary>{singleCopy.payExtras}</summary>
          <div className="stack tight">
            <CopyField
              label={singleCopy.paymentUriLabel}
              value={envelope.uri}
              testId="payment-uri"
            />
            <CopyField
              label={singleCopy.addressLabel}
              value={envelope.address}
              testId="envelope-address"
            />
            <details data-testid="advanced-ufvk">
              <summary>{singleCopy.viewingKeyLabel}</summary>
              <p className="hint">{singleCopy.viewingKeyHint}</p>
              <code className="value mono" data-testid="envelope-ufvk">
                {envelope.ufvk}
              </code>
            </details>
            <Birthday created={created} />
          </div>
        </details>

        <div className="button-row">
          <button type="button" className="ghost" onClick={() => setStep(1)} data-testid="pay-back">
            {singleCopy.back}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => setStep(3)}
            data-testid="skip-to-share"
          >
            {singleCopy.paidSkip}
          </button>
        </div>
      </>,
    );
  }

  return layout(
    3,
    <>
      {stepOf}
      <Envelope state="sealed" size="small" postmark="today" />
      <h1 ref={heading} tabIndex={-1} className="center-text" data-testid="send-title">
        {paid ? singleCopy.sendTitlePaid : singleCopy.sendTitle}
      </h1>
      {badge}
      <div aria-live="polite" className="stack tight center-text">
        {paid ? (
          <>
            <p className="lede">{singleCopy.sendLede(b.envelope)}</p>
            <p className="hint" data-testid="watch-paid">
              {watchCopy.paidDetail(zatToZecString(paid.zat), paid.height)}
            </p>
          </>
        ) : (
          <p className="lede" data-testid="send-unpaid">
            {singleCopy.sendLedeUnpaid}
          </p>
        )}
      </div>

      {share ? (
        <ShareButton
          url={envelope.link}
          face={singleCopy.shareLink}
          className="primary"
          testId="share-primary"
        />
      ) : (
        <CopyButton
          value={envelope.link}
          label={singleCopy.copyLink}
          face={singleCopy.copyLink}
          className="primary"
          testId="copy-primary"
        />
      )}
      <div className="button-row">
        {share ? (
          <CopyButton
            value={envelope.link}
            label={singleCopy.copyLink}
            face={singleCopy.copyLink}
            className="secondary"
            testId="copy-link"
          />
        ) : null}
        <button
          type="button"
          className="secondary"
          aria-expanded={showQr}
          onClick={() => setShowQr(!showQr)}
          data-testid="show-qr"
        >
          {showQr ? singleCopy.hideQr : singleCopy.showQr}
        </button>
      </div>
      {showQr ? (
        <div className="stack tight" data-testid="link-qr">
          <Qr value={envelope.link} label="Envelope link QR code" />
          <p className="hint center-text">{singleCopy.qrHint}</p>
        </div>
      ) : null}
      <code className="value mono link-full" data-testid="share-link">
        {envelope.link}
      </code>

      <div className="stack tight take-back">
        <button
          type="button"
          className="text-button"
          aria-expanded={takeBackOpen}
          onClick={() => setTakeBackOpen(!takeBackOpen)}
          data-testid="take-back"
        >
          {singleCopy.takeBack}
        </button>
        {takeBackOpen ? (
          <div className="stack tight" data-testid="take-back-panel">
            <p className="hint">{singleCopy.takeBackBody}</p>
            <button
              type="button"
              className="secondary"
              onClick={() => window.location.assign(envelope.link)}
              data-testid="take-back-go"
            >
              {singleCopy.takeBackGo}
            </button>
          </div>
        ) : null}
      </div>

      <button type="button" className="ghost wide" onClick={onReset} data-testid="again">
        {singleCopy.again}
      </button>
    </>,
  );
}

/* ------------------------------------------------- many envelopes (M6 preview) */

/**
 * Hands the CSV to the browser as a Blob download.
 *
 * The file never leaves the machine: a Blob URL is same-origin and is revoked
 * the moment the click is over, so there is no second copy hanging around in
 * the tab's object-URL table.
 */
function downloadCsv(rows: readonly GroupEnvelope[]): void {
  const blob = new Blob([buildCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = csvFilename(rows.length);
  a.rel = "noreferrer noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function GroupResult({
  created,
  isMock,
  onReset,
}: {
  created: Created;
  isMock: boolean;
  onReset: () => void;
}) {
  const { snap, restart } = usePaymentWatch(created);
  // The rows as the table and the CSV see them: the originals, plus the block and
  // the final link of every payment this tab has seen arrive so far. The CSV
  // button reads these, so a second download carries the latest state.
  const rows = useMemo(
    () =>
      created.rows.map((r) => {
        const p = snap?.paid.get(r.index);
        return p ? { ...r, paidHeight: p.height, finalLink: finalLink(r.link, p.height) } : r;
      }),
    [created.rows, snap],
  );
  const paidCount = rows.filter((r) => r.paidHeight !== undefined).length;
  const each = created.breakdown.total;
  return (
    <section className="stack">
      <h1>{groupCopy.title}</h1>
      {isMock ? <MockBadge /> : null}
      <p className="lede" data-testid="group-lede">
        {groupCopy.lede(rows.length, each)}
      </p>
      <p className="badge" data-testid="group-preview">
        {groupCopy.previewBadge}
      </p>

      <div className="card stack">
        <p className="breakdown" data-testid="group-total">
          <span>{groupCopy.total(groupTotal(rows), rows.length, each)}</span>
        </p>
        <p className="warn" data-testid="group-warn">
          {groupCopy.warn}
        </p>
        <button
          type="button"
          className="primary"
          data-testid="download-csv"
          onClick={() => downloadCsv(rows)}
        >
          {groupCopy.download}
        </button>
        <p className="hint">{groupCopy.scrollHint}</p>
        <Birthday created={created} />
      </div>

      <div className="card stack" data-testid="watch-card">
        <h2 data-testid="watch-waiting">
          {snap?.phase === "done" ? watchCopy.groupDone(rows.length) : watchCopy.waitingTitle}
        </h2>
        {created.birthday === null ? (
          <p className="hint" data-testid="watch-off">
            {watchCopy.noHeight}
          </p>
        ) : snap?.phase === "done" ? null : (
          <>
            <p className="hint">{watchCopy.groupWaitingBody}</p>
            <p className="hint" data-testid="watch-count">
              {watchCopy.groupPaid(paidCount, rows.length)}
            </p>
            <WatchStatus snap={snap} total={rows.length} onRestart={restart} />
          </>
        )}
      </div>

      <div className="table-scroll">
        <table className="group-table" data-testid="group-table">
          <caption className="hint">{groupCopy.tableCaption}</caption>
          <thead>
            <tr>
              <th scope="col">{groupCopy.columns.index}</th>
              <th scope="col">{groupCopy.columns.envelope}</th>
              <th scope="col">{groupCopy.columns.send}</th>
              <th scope="col">{groupCopy.columns.link}</th>
              <th scope="col">{groupCopy.columns.paid}</th>
              <th scope="col">{groupCopy.columns.finalLink}</th>
              <th scope="col">{groupCopy.columns.address}</th>
              <th scope="col">{groupCopy.columns.uri}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.index} data-testid="group-row">
                <td className="col-index">{r.index}</td>
                <td className="col-amount" data-testid="row-envelope">
                  {r.envelopeZec} ZEC
                </td>
                <td className="col-amount" data-testid="row-send">
                  {r.sendZec} ZEC
                </td>
                <td>
                  <code className="cell mono" data-testid="row-link">
                    {r.link}
                  </code>
                  <CopyButton value={r.link} label={`Copy the link for envelope ${r.index}`} />
                </td>
                <td className="col-amount" data-testid="row-paid">
                  {r.paidHeight === undefined
                    ? watchCopy.groupUnpaidCell
                    : watchCopy.groupPaidCell(r.paidHeight)}
                </td>
                <td>
                  {r.finalLink ? (
                    <>
                      <code className="cell mono" data-testid="row-final-link">
                        {r.finalLink}
                      </code>
                      <CopyButton
                        value={r.finalLink}
                        label={`Copy the final link for envelope ${r.index}`}
                      />
                    </>
                  ) : null}
                </td>
                <td>
                  <code className="cell mono" data-testid="row-address">
                    {truncateMiddle(r.address, 10)}
                  </code>
                  <CopyButton
                    value={r.address}
                    label={`Copy the address for envelope ${r.index}`}
                  />
                </td>
                <td>
                  <code className="cell mono" data-testid="row-uri">
                    {r.uri}
                  </code>
                  <CopyButton
                    value={r.uri}
                    label={`Copy the payment URI for envelope ${r.index}`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="hint" data-testid="group-columns-note">
        {groupCopy.columnsNote}
      </p>

      <p className="fine" data-testid="group-memory">
        {groupCopy.memoryFine}
      </p>
      <p className="fine">{landing.neverAsk}</p>

      <button type="button" className="ghost wide" onClick={onReset}>
        {groupCopy.again}
      </button>
    </section>
  );
}
