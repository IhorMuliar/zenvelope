import { useEffect, useMemo, useState } from "react";
import {
  FLAT_FEE_ZAT,
  LIGHTWALLETD,
  LIGHTWALLETD_FALLBACK,
  MAX_MEMO_BYTES,
  SENDER_WALLETS,
} from "../config";
import type { LoadedCore, Network } from "../core/types";
import { loadCore } from "../core";
import { breakdownLines, feeBreakdown, validateAmount, type Breakdown } from "../lib/amount";
import { memoByteLength, truncateMiddle } from "../lib/format";
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
import { Qr } from "../components/Qr";
import { group as groupCopy, landing, single as singleCopy } from "../copy/en";

/**
 * What one submission produced.
 *
 * One envelope or fifty, the shape is the same: the difference is only which
 * screen renders it. Every secret in `rows` lives in this React state and in
 * nothing else — not localStorage, not a query string, not a log, not a
 * request. Leaving the page loses them, and that is the design.
 */
interface Created {
  rows: GroupEnvelope[];
  /** Per envelope: amount + flat fee = what one sender payment must be. */
  breakdown: Breakdown;
  birthday: number | null;
  heightSource: string | null;
  network: Network;
  message: string;
}

export function Create() {
  const [core, setCore] = useState<LoadedCore | null>(null);
  const [amount, setAmount] = useState("");
  const [count, setCount] = useState("1");
  const [message, setMessage] = useState("");
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
  const countCheck = validateCount(count);
  // The memo limit is a byte limit, so the counter has to encode to count.
  const messageBytes = memoByteLength(message.trim());
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
    const c = validateCount(count);
    if (!c.ok) {
      setError(c.error);
      return;
    }
    if (memoByteLength(message.trim()) > MAX_MEMO_BYTES) {
      setError(
        `The message is too long: ${memoByteLength(message.trim())} of ${MAX_MEMO_BYTES} bytes.`,
      );
      return;
    }
    setBusy(true);
    setMadeSoFar(c.count > 1 ? [0, c.count] : null);
    try {
      const loaded = core ?? (await loadCore());
      if (!core) setCore(loaded);

      // One height fetch for the whole group: N links cost N derivations and no
      // extra network.
      const chain = await fetchChainHeight(LIGHTWALLETD[network], LIGHTWALLETD_FALLBACK[network]);
      const trimmed = message.trim();

      // Every secret, address, fragment and URI below is a round trip to the core
      // worker: the wasm lives there and only there, so the secrets are made there
      // and kept on neither side once the call is answered.
      const rows = await generateGroup(
        loaded,
        {
          count: c.count,
          envelopeZat: v.zat,
          feeZat: FLAT_FEE_ZAT,
          message: trimmed,
          network,
          birthday: chain?.height,
          origin: window.location.origin,
        },
        c.count > 1 ? (made, total) => setMadeSoFar([made, total]) : undefined,
      );

      setCreated({
        rows,
        breakdown: feeBreakdown(v.zat, FLAT_FEE_ZAT),
        birthday: chain?.height ?? null,
        heightSource: chain?.source ?? null,
        network,
        message: trimmed,
      });
    } catch (err) {
      setError((err as Error).message || "Could not create the envelope.");
    } finally {
      setBusy(false);
      setMadeSoFar(null);
    }
  }

  const reset = () => {
    setCreated(null);
    setAmount("");
    setCount("1");
    setMessage("");
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

  return (
    <section className="stack">
      <h1>{landing.headline}</h1>
      <p className="lede" data-testid="how-paragraph">
        {landing.howInOneParagraph}
      </p>
      {core?.isMock ? <MockBadge /> : null}

      <section className="stack" data-testid="never-hold">
        <h2>{landing.neverHoldTitle}</h2>
        <p className="hint">{landing.neverHoldLede}</p>
        <ol className="strip">
          {landing.neverHoldSteps.map((step) => (
            <li key={step.title} className="card">
              <h3>{step.title}</h3>
              <p className="hint">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <form className="card stack" onSubmit={onSubmit}>
        <h2>{landing.formTitle}</h2>

        <div className="two-up">
          <label className="field">
            <span className="label">{landing.amountLabel}</span>
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
              <span className="hint">{landing.amountHint}</span>
            )}
          </label>

          <label className="field count-field">
            <span className="label">{landing.countLabel}</span>
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
        </div>

        <label className="field">
          <span className="label">{landing.messageLabel}</span>
          <input
            autoComplete="off"
            placeholder={landing.messagePlaceholder}
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
              {n > 1 ? " Every envelope in the group carries the same message." : ""}
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
            {n === 1
              ? `You will send ${preview.total} ZEC: ${preview.envelope} ZEC in the envelope plus a ${preview.fee} ZEC service fee.`
              : `You will send ${zecMultiple(preview.totalZat, n)} ZEC in total: ${n} payments of ${preview.total} ZEC, each ${preview.envelope} ZEC in the envelope plus a ${preview.fee} ZEC service fee.`}
          </p>
        ) : null}

        {error ? <p className="error">{error}</p> : null}

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
      </form>

      <p className="fine" data-testid="never-ask">
        {landing.neverAsk}
      </p>
      <p className="fine">{landing.secretFine}</p>
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

/* --------------------------------------------------------- one envelope (M1) */

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
  const [line1, line2] = breakdownLines(created.breakdown);
  return (
    <section className="stack">
      <h1>{singleCopy.title}</h1>
      {isMock ? <MockBadge /> : null}

      <div className="card stack">
        <h2>{singleCopy.keepTitle}</h2>
        <CopyField label="Envelope link" value={envelope.link} testId="envelope-link" />
        <p className="warn">{singleCopy.keepWarn}</p>
        <Birthday created={created} />
      </div>

      <div className="card stack">
        <h2>{singleCopy.fundTitle}</h2>
        <Qr value={envelope.uri} />
        <p className="breakdown" data-testid="breakdown">
          <span>{line1}</span>
          <span>{line2}</span>
        </p>
        <CopyField label="Payment URI" value={envelope.uri} testId="payment-uri" />
        <p className="hint">Works with {SENDER_WALLETS}.</p>
        <p className="warn">{singleCopy.fundWarn}</p>
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
        <h2>{singleCopy.sendTitle}</h2>
        <p>
          {singleCopy.sendBody}
          {created.message
            ? ` Your message travels inside the payment, encrypted: “${created.message}”.`
            : ""}
        </p>
      </div>

      <button type="button" className="ghost wide" onClick={onReset}>
        {singleCopy.again}
      </button>
    </section>
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
  const { rows } = created;
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

      <div className="table-scroll">
        <table className="group-table" data-testid="group-table">
          <caption className="hint">{groupCopy.tableCaption}</caption>
          <thead>
            <tr>
              <th scope="col">{groupCopy.columns.index}</th>
              <th scope="col">{groupCopy.columns.envelope}</th>
              <th scope="col">{groupCopy.columns.send}</th>
              <th scope="col">{groupCopy.columns.link}</th>
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
