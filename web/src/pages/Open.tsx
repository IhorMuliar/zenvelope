import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { LIGHTWALLETD, LIGHTWALLETD_FALLBACK, explorerTxUrl } from "../config";
import { alreadyOpened, noteCopy, revealed, sealed, spendCheck } from "../copy/en";
import { loadCore, provingNote } from "../core";
import type { FoundNote, LoadedCore, Network } from "../core/types";
import {
  BAD_FRAGMENT_COPY,
  LINK_FORGOTTEN_COPY,
  eventFromScan,
  NO_FRAGMENT_COPY,
  formatSpendDate,
  initialOpenState,
  latestSpend,
  openReducer,
  progressLabel,
  runOpen,
  stripSecretFromUrl,
  unspentNotes,
} from "../lib/openFlow";
import { formatCount, formatZec, formatZecAmount, poolLabel, sumZat, truncateTxid } from "../lib/format";
import { seedForAddress } from "../lib/guilloche";
import { parseMemo } from "../lib/memo";
import { CopyField } from "../components/CopyField";
import { Envelope } from "../components/Envelope";
import { SendOn } from "../components/SendOn";

interface Link {
  /** The address the sender paid. Safe to show: it reveals nothing and cannot spend. */
  address: string;
  birthday?: number;
  network: Network;
}

export function Open() {
  const [state, dispatch] = useReducer(openReducer, initialOpenState);
  const [link, setLink] = useState<Link | null>(null);
  const [isMock, setIsMock] = useState(false);
  /** "proving: 4 threads" / "proving: 1 thread": which wasm package the worker loaded. */
  const [proving, setProving] = useState<string | null>(null);
  /**
   * How long the scan took, tap to result. Only this page knows when the tap
   * happened, so it measures and the send-on card shows it in its Timing block.
   */
  const [openMs, setOpenMs] = useState<number | null>(null);
  const scanStartedAt = useRef<number | null>(null);

  /**
   * The secret lives in this ref and nowhere else: not in storage, not in a query
   * string, not in any link this page renders, never logged — and, from the
   * moment it has been read, not in the URL either (`stripSecretFromUrl` below).
   * It is handed to the core and to nothing else.
   *
   * It is deliberately not React state and is never spread into a child's props:
   * a ref is not walked by the React DevTools props inspector, and the children
   * that need it are given {@link getSecret} rather than the string.
   */
  const secret = useRef<string | null>(null);
  const core = useRef<LoadedCore | null>(null);
  /** Bumped per scan, so a superseded run cannot write over a newer one. */
  const runId = useRef(0);

  // The wasm core loads while the recipient is still reading the sealed screen.
  useEffect(() => {
    let alive = true;
    const frag = window.location.hash.replace(/^#/, "");
    const network: Network =
      new URLSearchParams(window.location.search).get("net") === "test" ? "test" : "main";

    if (frag.trim() === "") {
      dispatch({ type: "invalid", message: NO_FRAGMENT_COPY });
      return;
    }

    loadCore()
      .then(async (c) => {
        if (!alive) return;
        // Both of these are now round trips to the core worker, which is the only
        // thread that ever holds the wasm. The secret goes there and nowhere else.
        const parsed = await c.parse_fragment(frag);
        const derived = await c.derive(parsed.secret, network);
        if (!alive) return;
        core.current = c;
        setProving(provingNote(c));
        secret.current = parsed.secret;
        // The bearer secret is in memory now, so it has no further business in
        // the address bar, the history entry or anything the recipient shares.
        // Every retry below re-scans from `secret.current`, never from the hash.
        stripSecretFromUrl(window);
        setIsMock(c.isMock);
        setLink({ address: derived.address, birthday: parsed.birthday, network });
        dispatch({ type: "parsed" });
      })
      .catch(() => {
        if (alive) dispatch({ type: "invalid", message: BAD_FRAGMENT_COPY });
      });

    return () => {
      alive = false;
    };
  }, []);

  const scan = useCallback(async () => {
    const c = core.current;
    const s = secret.current;
    if (!c || !s || !link) return;
    const id = ++runId.current;
    scanStartedAt.current = Date.now();
    try {
      const result = await runOpen({
        core: c,
        secret: s,
        birthday: link.birthday,
        network: link.network,
        hosts: [LIGHTWALLETD[link.network], LIGHTWALLETD_FALLBACK[link.network]],
        onProgress: (scanned, total, event) => {
          if (id !== runId.current) return;
          // The early reveal first, so the count that rides with it lands on the
          // verifying screen.
          const early = eventFromScan(event);
          if (early) dispatch(early);
          dispatch({ type: "progress", scanned, total });
        },
        onAttempt: (attempt) => {
          if (id === runId.current) dispatch({ type: "attempt", attempt });
        },
      });
      if (id === runId.current) {
        const started = scanStartedAt.current;
        setOpenMs(started === null ? null : Date.now() - started);
        dispatch({ type: "result", result });
      }
    } catch (err) {
      if (id === runId.current) dispatch({ type: "failed", message: (err as Error).message });
    }
  }, [link]);

  /**
   * The children get a getter, not the string (I12). React DevTools shows a prop
   * that is a function as `f () {}`; a string prop is shown in full, and the
   * secret is the money. The closure reads the same ref the scan does.
   */
  const getSecret = useCallback(() => secret.current, []);

  const onOpen = () => {
    dispatch({ type: "open" });
    void scan();
  };

  const onRetry = () => {
    dispatch({ type: "retry" });
    void scan();
  };

  /** From the send-on flow, after another device swept this envelope first. */
  const onCheckAgain = useCallback(() => {
    dispatch({ type: "recheck" });
    void scan();
  }, [scan]);

  const badge = isMock ? <MockBadge /> : null;
  const provingFooter = proving ? <ProvingNote note={proving} /> : null;

  if (state.phase === "invalid") {
    return (
      <section className="stack">
        <h1>We could not read this link</h1>
        <p className="error" data-testid="open-error">
          {state.message}
        </p>
        <p>
          <a href="/">Create an envelope instead</a>
        </p>
      </section>
    );
  }

  if (state.phase === "reading" || !link) {
    return (
      <section className="stack">
        <h1>Reading the link…</h1>
      </section>
    );
  }

  if (state.phase === "sealed") {
    return (
      <section className="stack center open-sealed">
        <h1>{sealed.title}</h1>
        {badge}
        <Envelope
          state="sealed"
          postmark="today"
          tear={{ onOpen, label: sealed.open, testId: "open-envelope" }}
        />
        <p className="hint pull-hint">{noteCopy.pullHint}</p>
        <p className="hint" data-testid="open-fineprint">
          {sealed.reassure}
        </p>
        <p className="hint">
          {/* A new tab, so following it does not lose this page and its link. */}
          <a href="/how#safe" target="_blank" rel="noopener noreferrer" data-testid="safe-link">
            {sealed.safeLink}
          </a>
        </p>
        <p className="fine" data-testid="link-forgotten">
          {LINK_FORGOTTEN_COPY}
        </p>
        <details className="sealed-details">
          <summary data-testid="open-address-toggle">Check the envelope address</summary>
          <code className="value mono" data-testid="open-address">
            {link.address}
          </code>
          <p className="hint">
            The sender paid this address. Your browser worked it out from the link.
            {link.birthday !== undefined ? ` Birthday height ${link.birthday}.` : ""}
            {link.network === "test" ? " Testnet." : ""}
          </p>
        </details>
        {provingFooter}
      </section>
    );
  }

  if (state.phase === "scanning") {
    const line = progressLabel(state, formatCount);
    return (
      <section className="stack center">
        <h1 data-testid="scanning">{sealed.scanningTitle}</h1>
        {badge}
        <Envelope state="sealed" busy torn postmark="today" />
        <progress
          className="scan-bar"
          max={state.total > 0 ? state.total : undefined}
          value={state.total > 0 ? state.scanned : undefined}
          data-testid="scan-bar"
        />
        <p className="hint" aria-live="polite" data-testid="scan-progress">
          {line ?? "Starting the scan…"}
        </p>
        <p className="fine">
          {sealed.scanningHint}
          {state.attempt > 0 ? " The main Zcash server did not answer, so we switched to the backup." : ""}
        </p>
      </section>
    );
  }

  if (state.phase === "spent" && state.result) {
    return (
      <AlreadyOpened
        notes={state.result.notes}
        network={link.network}
        badge={badge}
        provingFooter={provingFooter}
      />
    );
  }

  if (state.phase === "verifying" && state.early && core.current && secret.current) {
    // The note is known; the walk to the tip is still checking for its spend.
    // The amount shows now, the send-on controls wait for the result.
    return (
      <Opened
        notes={unspentNotes(state.early.notes)}
        spentZat={0n}
        tipHeight={state.early.tip_height}
        badge={badge}
        provingFooter={provingFooter}
        core={core.current}
        getSecret={getSecret}
        network={link.network}
        envelopeAddress={link.address}
        openMs={null}
        checking={{ scanned: state.scanned, total: state.total }}
      />
    );
  }

  if (state.phase === "opened" && state.result && core.current && secret.current) {
    return (
      <Opened
        notes={unspentNotes(state.result.notes)}
        spentZat={BigInt(state.result.spent_zat ?? "0")}
        tipHeight={state.result.tip_height}
        badge={badge}
        provingFooter={provingFooter}
        core={core.current}
        getSecret={getSecret}
        network={link.network}
        envelopeAddress={link.address}
        openMs={openMs}
        onCheckAgain={onCheckAgain}
      />
    );
  }

  // empty and failed both end here: a wait-and-see screen with a retry.
  const failed = state.phase === "failed";
  return (
    <section className="stack">
      <h1>{failed ? "We could not finish looking" : "Nothing here yet"}</h1>
      {badge}
      <div className="card stack">
        <p className={failed ? "error" : ""} data-testid={failed ? "scan-error" : "not-found"}>
          {state.message}
        </p>
        <button type="button" className="primary" onClick={onRetry} data-testid="retry">
          Try again
        </button>
      </div>
      <div className="card stack">
        <CopyField label="Waiting for" value={link.address} testId="waiting-address" />
        <p className="hint">
          This is the envelope's address. Send it to whoever gave you the link, so they can
          check they paid the right place.
          {link.birthday !== undefined ? ` Scanned from block ${formatCount(link.birthday)}.` : ""}
        </p>
      </div>
      <p className="fine">
        The secret in this link stayed in your browser. Nothing about it was sent anywhere.
      </p>
      <p className="fine" data-testid="link-forgotten">
        {LINK_FORGOTTEN_COPY}
      </p>
      {provingFooter}
    </section>
  );
}

/**
 * Found, and already swept. Deliberately no send-on controls: there is nothing
 * to send, and proving a spend of a note the chain has already seen spent would
 * only fail at broadcast.
 */
function AlreadyOpened({
  notes,
  network,
  badge,
  provingFooter,
}: {
  notes: FoundNote[];
  network: Network;
  badge: React.ReactNode;
  provingFooter: React.ReactNode;
}) {
  const spend = latestSpend(notes);
  const received = sumZat(notes.map((n) => n.amount_zat));
  const date = spend?.time ? formatSpendDate(spend.time) : null;
  return (
    <section className="stack" data-testid="already-opened">
      <h1>{alreadyOpened.title}</h1>
      {badge}
      <div className="unwrap">
        <Envelope state="open" size="small" postmark="sent" />
      </div>
      <div className="card stack">
        <p className="lede">{alreadyOpened.lede}</p>
        {spend ? (
          <>
            <p data-testid="spent-when">{alreadyOpened.when(formatCount(spend.height), date)}</p>
            <CopyField
              label={alreadyOpened.txLabel}
              value={spend.txid}
              display={truncateTxid(spend.txid)}
              testId="spent-txid"
            />
            <p>
              <a
                href={explorerTxUrl(spend.txid, network)}
                target="_blank"
                rel="noreferrer noopener"
                data-testid="spent-explorer"
              >
                {alreadyOpened.explorerLink}
              </a>
            </p>
          </>
        ) : null}
        <p className="hint" data-testid="spent-received">
          {alreadyOpened.received(formatZecAmount(received))}
        </p>
      </div>
      <p className="fine">{alreadyOpened.notYou}</p>
      <p className="fine" data-testid="link-forgotten">
        {LINK_FORGOTTEN_COPY}
      </p>
      {provingFooter}
    </section>
  );
}

function Opened({
  notes,
  spentZat,
  tipHeight,
  badge,
  provingFooter,
  core,
  getSecret,
  network,
  envelopeAddress,
  openMs,
  checking = null,
  onCheckAgain,
}: {
  /** The UNSPENT notes only: these are what the amount shows and SendOn sweeps. */
  notes: FoundNote[];
  /** Zatoshi already moved on out of this envelope, for the line about the rest. */
  spentZat: bigint;
  tipHeight: number;
  badge: React.ReactNode;
  provingFooter: React.ReactNode;
  core: LoadedCore;
  /** Reads the secret out of the open page's ref, for the sweep and nothing else. */
  getSecret: () => string | null;
  network: Network;
  /** The envelope's own address: the Solana exit's default refund target (D14). */
  envelopeAddress: string;
  /** Wall clock of the scan that got here, for the Timing block on the done screen. */
  openMs: number | null;
  /**
   * Set while the walk to the tip is still checking the note has not been
   * spent: the count for the check line. The send-on flow is not mounted until
   * it is done, because mounting it would start the proving-key warm-up, which
   * runs on the same worker thread as the walk and would hold the check up.
   */
  checking?: { scanned: number; total: number } | null;
  /** Runs the open again; offered after a sweep lost the race to another device. */
  onCheckAgain?: () => void;
}) {
  const total = sumZat(notes.map((n) => n.amount_zat));
  const rawMemo = notes.find((n) => n.memo && n.memo.trim() !== "")?.memo ?? null;
  // A trailing "From <name>" line is the sender's name; the rest is the note.
  const { from, note } = parseMemo(rawMemo);
  const single = notes.length === 1 ? notes[0] : null;
  /** Past "Receive it": the reveal folds down and the destinations take the screen. */
  const [receiving, setReceiving] = useState(false);

  const details = (
    <details className="extras" data-testid="open-details">
      <summary>{revealed.details}</summary>
      <div className="stack tight">
        {single ? (
          <>
            <Row label="Pool" value={poolLabel(single.pool)} testId="pool" />
            <Row label="Block" value={formatCount(single.height)} testId="height" />
            <CopyField
              label="Transaction"
              value={single.txid}
              display={truncateTxid(single.txid)}
              testId="txid"
            />
          </>
        ) : (
          <>
            <Row label="Payments" value={`${notes.length} notes, added up above`} testId="note-count" />
            <ul className="notes" data-testid="note-details">
              {notes.map((n) => (
                <li key={`${n.txid}-${n.height}`} className="stack">
                  <strong>{formatZecAmount(BigInt(n.amount_zat))}</strong>
                  <span className="hint">
                    {poolLabel(n.pool)} · block {formatCount(n.height)}
                  </span>
                  <CopyField label="Transaction" value={n.txid} display={truncateTxid(n.txid)} />
                </li>
              ))}
            </ul>
          </>
        )}
        {checking ? null : (
          <p className="hint">Chain tip {formatCount(tipHeight)} when this scan finished.</p>
        )}
        <p className="fine">
          The secret in this link stayed in your browser. Nothing about this envelope was sent
          anywhere.
        </p>
      </div>
    </details>
  );

  const sendOn = checking ? null : (
    <SendOn
      core={core}
      getSecret={getSecret}
      network={network}
      notes={notes}
      tipHeight={tipHeight}
      envelopeAddress={envelopeAddress}
      openMs={openMs}
      onCheckAgain={onCheckAgain}
      started={receiving}
      onStart={() => {
        setReceiving(true);
        window.scrollTo?.(0, 0);
      }}
      onBackToEnvelope={() => setReceiving(false)}
    />
  );

  // One tree for both states, with SendOn in the same slot, so going to the
  // destinations and back keeps its state and does not restart the key warm-up.
  return (
    <section className="stack">
      <h1 className="sr-only">{revealed.title}</h1>
      {badge}

      {receiving ? (
        <p className="compact-amount">
          {from ? <span data-testid="from">{revealed.from(from)}</span> : null}
          <span className="hint">{revealed.compactLabel}</span>
          <strong data-testid="amount">{formatZecAmount(total)}</strong>
        </p>
      ) : (
        <div className="unwrap">
          <Envelope
            state="open"
            revealOnMount
            rise
            size="hero"
            note={{
              amount: formatZec(total),
              memo: note ?? "",
              from: from ?? "",
              seed: seedForAddress(envelopeAddress),
              tilt: true,
              testIds: { amount: "amount", from: "from", memo: note ? "memo" : undefined },
            }}
          />
          {checking ? (
            <p className="hint" aria-live="polite" data-testid="spend-check">
              {checking.total > 0
                ? spendCheck.line(formatCount(checking.scanned), formatCount(checking.total))
                : spendCheck.starting}
            </p>
          ) : null}
          {spentZat > 0n ? (
            <p className="hint" data-testid="spent-partial">
              {alreadyOpened.partial(formatZecAmount(spentZat))}
            </p>
          ) : null}
        </div>
      )}

      {/* The note prints two lines of the message. A longer one is written out
          in full here too; the note's own memo line already carries every word
          for a screen reader, so this copy is for the eye only. */}
      {!receiving && note && note.length > LONG_MEMO ? (
        <blockquote className="letter" aria-hidden="true">
          <p className="memo">{note}</p>
        </blockquote>
      ) : null}

      {checking ? (
        <div className="stack tight" data-testid="send-on-waiting">
          <button type="button" className="primary" disabled data-testid="send-on-disabled">
            {revealed.checking}
          </button>
          <p className="hint center-text">{spendCheck.sendOnWaiting}</p>
        </div>
      ) : null}
      {sendOn}

      {receiving ? null : (
        <details className="extras" data-testid="what-is-zec">
          <summary>{revealed.whatIsZec}</summary>
          <p className="hint">{revealed.whatIsZecBody}</p>
        </details>
      )}
      {receiving ? null : details}

      <p className="fine" data-testid="link-forgotten">
        {LINK_FORGOTTEN_COPY}
      </p>
      {provingFooter}
    </section>
  );
}

/** Past this many characters the message no longer fits the note's two lines. */
const LONG_MEMO = 64;

function Row({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <p className="row">
      <span className="label">{label}</span>
      <span data-testid={testId}>{value}</span>
    </p>
  );
}

/**
 * The footer note. Tiny on purpose: it is not product copy, it is a statement of which
 * of the two wasm packages is doing the proving, so a slow sweep can be explained
 * without opening the console.
 */
function ProvingNote({ note }: { note: string }) {
  return (
    <p className="fine proving-note" data-testid="proving-note">
      {note}
    </p>
  );
}

function MockBadge() {
  return (
    <p className="badge" data-testid="mock-badge">
      MOCK CORE: no WASM build found. No chain is read, the scan is simulated, and any
      amount shown is not real money.
    </p>
  );
}
