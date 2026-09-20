import { useEffect, useMemo, useState } from "react";
import {
  FLAT_FEE_ZAT,
  LIGHTWALLETD,
  LIGHTWALLETD_FALLBACK,
  MAX_MEMO_BYTES,
  SENDER_WALLETS,
  TAGLINE,
} from "../config";
import type { Network } from "../core/types";
import { loadCore } from "../core";
import type { LoadedCore } from "../core/types";
import { breakdownLines, feeBreakdown, validateAmount, type Breakdown } from "../lib/amount";
import { memoByteLength } from "../lib/format";
import { fetchChainHeight } from "../lib/grpcweb";
import { CopyField } from "../components/CopyField";
import { Qr } from "../components/Qr";

interface Envelope {
  /** Held in memory only: never stored, never in a query string, never logged. */
  link: string;
  address: string;
  /** Full viewing key. Reveals amounts and memos; it cannot spend. */
  ufvk: string;
  uri: string;
  breakdown: Breakdown;
  birthday: number | null;
  heightSource: string | null;
  network: Network;
  message: string;
}

export function Create() {
  const [core, setCore] = useState<LoadedCore | null>(null);
  const [amount, setAmount] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [envelope, setEnvelope] = useState<Envelope | null>(null);

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
  // The memo limit is a byte limit, so the counter has to encode to count.
  const messageBytes = memoByteLength(message.trim());
  const preview =
    validation && validation.ok ? feeBreakdown(validation.zat, FLAT_FEE_ZAT) : null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const v = validateAmount(amount);
    if (!v.ok) {
      setError(v.error);
      return;
    }
    if (memoByteLength(message.trim()) > MAX_MEMO_BYTES) {
      setError(
        `The message is too long: ${memoByteLength(message.trim())} of ${MAX_MEMO_BYTES} bytes.`,
      );
      return;
    }
    setBusy(true);
    try {
      const c = core ?? (await loadCore());
      if (!core) setCore(c);

      // The secret lives in this closure and in the rendered link. Nowhere else.
      const secret = c.generate_secret();

      const chain = await fetchChainHeight(LIGHTWALLETD[network], LIGHTWALLETD_FALLBACK[network]);
      const derived = c.derive(secret, network);
      const fragment = c.build_fragment(secret, chain?.height);
      const breakdown = feeBreakdown(v.zat, FLAT_FEE_ZAT);
      const trimmed = message.trim();
      const uri = c.payment_uri(
        derived.address,
        breakdown.totalZat,
        trimmed === "" ? undefined : trimmed,
      );

      setEnvelope({
        link: `${window.location.origin}/e#${fragment}`,
        address: derived.address,
        ufvk: derived.ufvk,
        uri,
        breakdown,
        birthday: chain?.height ?? null,
        heightSource: chain?.source ?? null,
        network,
        message: trimmed,
      });
    } catch (err) {
      setError((err as Error).message || "Could not create the envelope.");
    } finally {
      setBusy(false);
    }
  }

  if (envelope) {
    return (
      <Result
        envelope={envelope}
        isMock={core?.isMock ?? true}
        onReset={() => {
          setEnvelope(null);
          setAmount("");
          setMessage("");
        }}
      />
    );
  }

  return (
    <section className="stack">
      <h1>{TAGLINE}</h1>
      <p className="lede">
        Fund a link from a shielded balance. Whoever opens it takes the money out in their
        browser, with no wallet and no install. We never hold funds.
      </p>
      {core?.isMock ? <MockBadge /> : null}

      <form className="card stack" onSubmit={onSubmit}>
        <label className="field">
          <span className="label">Amount in ZEC</span>
          <input
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.01"
            value={amount}
            data-testid="amount"
            onChange={(e) => setAmount(e.target.value)}
          />
          {validation && !validation.ok ? (
            <span className="error" data-testid="amount-error">
              {validation.error}
            </span>
          ) : (
            <span className="hint">Minimum 0.0001 ZEC. Up to 8 decimal places.</span>
          )}
        </label>

        <label className="field">
          <span className="label">Message to the recipient (encrypted on-chain, revealed when opened)</span>
          <input
            autoComplete="off"
            placeholder="Happy birthday"
            value={message}
            data-testid="message"
            aria-invalid={messageBytes > MAX_MEMO_BYTES}
            onChange={(e) => setMessage(e.target.value)}
          />
          {messageBytes > MAX_MEMO_BYTES ? (
            <span className="error" data-testid="message-error">
              The message is too long: {messageBytes} of {MAX_MEMO_BYTES} bytes.
            </span>
          ) : (
            <span className="hint" data-testid="message-count">
              It travels in the payment itself, encrypted, and only the person who opens
              the envelope can read it. {messageBytes}/{MAX_MEMO_BYTES} bytes.
            </span>
          )}
        </label>

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
            You will send {preview.total} ZEC: {preview.envelope} ZEC in the envelope plus a{" "}
            {preview.fee} ZEC service fee.
          </p>
        ) : null}

        {error ? <p className="error">{error}</p> : null}

        <button type="submit" className="primary" disabled={busy} data-testid="create">
          {busy ? "Creating…" : "Create envelope"}
        </button>
      </form>

      <p className="fine">
        The secret is generated in your browser and lives in the link only. We never see it,
        and we cannot open, freeze or refund an envelope.
      </p>
    </section>
  );
}

function MockBadge() {
  return (
    <p className="badge" data-testid="mock-badge">
      MOCK CORE — no WASM build found. Addresses on this page are placeholders and are not
      spendable. Do not send real ZEC.
    </p>
  );
}

function Result({
  envelope,
  isMock,
  onReset,
}: {
  envelope: Envelope;
  isMock: boolean;
  onReset: () => void;
}) {
  const [line1, line2] = breakdownLines(envelope.breakdown);
  return (
    <section className="stack">
      <h1>Your envelope is ready</h1>
      {isMock ? <MockBadge /> : null}

      <div className="card stack">
        <h2>1. Keep this link</h2>
        <CopyField label="Envelope link" value={envelope.link} testId="envelope-link" />
        <p className="warn">Anyone with this link can open the envelope. We never see it.</p>
        <p className="hint">
          {envelope.birthday !== null
            ? `Birthday height ${envelope.birthday}, from ${envelope.heightSource}.`
            : "Chain height unavailable, so this link carries no birthday. Opening it will scan from further back."}
          {envelope.network === "test" ? " Testnet." : ""}
        </p>
      </div>

      <div className="card stack">
        <h2>2. Fund it from a shielded balance</h2>
        <Qr value={envelope.uri} />
        <p className="breakdown" data-testid="breakdown">
          <span>{line1}</span>
          <span>{line2}</span>
        </p>
        <CopyField label="Payment URI" value={envelope.uri} testId="payment-uri" />
        <p className="hint">Works with {SENDER_WALLETS}.</p>
        <p className="warn">Send exactly this amount from a shielded balance.</p>
        <details>
          <summary>Envelope address</summary>
          <code className="value mono" data-testid="envelope-address">
            {envelope.address}
          </code>
        </details>
        <details data-testid="advanced-ufvk">
          <summary>Advanced: viewing key</summary>
          <p className="hint">
            This full viewing key lets a light client watch the envelope: it reveals the
            amounts and memos that arrive at this address. It cannot spend, and it cannot
            open the envelope. Share it only with someone you want watching.
          </p>
          <code className="value mono" data-testid="envelope-ufvk">
            {envelope.ufvk}
          </code>
        </details>
      </div>

      <div className="card stack">
        <h2>3. Send the link</h2>
        <p>
          Once the payment confirms, whoever opens the link unwraps the envelope in their
          browser and moves the money where they want it.
          {envelope.message
            ? ` Your message travels inside the payment, encrypted: “${envelope.message}”.`
            : ""}
        </p>
      </div>

      <button type="button" className="ghost wide" onClick={onReset}>
        Create another envelope
      </button>
    </section>
  );
}
