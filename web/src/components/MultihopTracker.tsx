/**
 * The private route, from the moment the swap pays the router wallet until the money is
 * in the recipient's wallet.
 *
 *   Swapping -> Packed -> Hop i of n -> Landing -> In your wallet
 *
 * Everything here is resumable from the link: the router wallet and the transfer id
 * both come from the secret, so a closed tab loses nothing and "Open this link again
 * any time to check" is literally true. The page does the driving (see lib/routeRun);
 * MultiHopper's keeper finishes the route whether or not this tab is open.
 *
 * Three ways in:
 *   route   straight after the sweep: the 1Click swap is paying the router wallet
 *   resume  the link was opened again and the router holds funds or a transfer exists
 *   devnet  a test build: no swap, a tester sends devnet funds to the router address
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { privateRoute as copy } from "../copy/en";
import { SOLANA_CLUSTER, solscanAccount, solscanTx } from "../lib/cluster";
import { truncateMiddle } from "../lib/format";
import {
  createMhClient,
  createSolRpc,
  emptyRouter,
  externalIdFor,
  type MhTransfer,
} from "../lib/multihop";
import { initialMhState, mhReducer } from "../lib/multihopFlow";
import type { SolanaAsset } from "../lib/oneclick";
import type { RouterKey } from "../lib/router";
import { deriveRouterKey, secretBytesFromB64url } from "../lib/router";
import { assetForMint, mintFor, runRoute, type RunInfo } from "../lib/routeRun";
import { etaWords, routeEta, routePollMs, trackerRows } from "../lib/routeTracker";
import { checkSolanaAddress } from "../lib/solana";
import { CopyField } from "./CopyField";
import { Qr } from "./Qr";

export type TrackerMode = "route" | "resume" | "devnet";

interface Props {
  /** Reads the link secret for the router key. Called here and nowhere else. */
  getSecret: () => string | null;
  /** The wallet the money ends at. null on a reopened link that never got a transfer. */
  recipient: string | null;
  /** The gift's asset when the page knows it; null to infer it from the router's holdings. */
  asset: SolanaAsset | null;
  mode: TrackerMode;
  pollMs?: number;
  onBack?: () => void;
}

type Refund = "idle" | "sending" | "done" | "failed";

export function MultihopTracker({ getSecret, recipient, asset, mode, pollMs = routePollMs(), onBack }: Props) {
  const [state, dispatch] = useReducer(mhReducer, initialMhState);
  const [info, setInfo] = useState<RunInfo>({});
  const [to, setTo] = useState<string | null>(recipient);
  const [needsRecipient, setNeedsRecipient] = useState(false);
  const [typed, setTyped] = useState("");
  const [runKey, setRunKey] = useState(0);
  const [routerAddress, setRouterAddress] = useState<string | null>(null);
  const [refund, setRefund] = useState<Refund>("idle");
  const [now, setNow] = useState(() => Date.now());
  const router = useRef<RouterKey | null>(null);
  const rpc = useMemo(() => createSolRpc(), []);

  // The run. Re-runs only when the recipient becomes known or "Try again" is pressed.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const secret = getSecret();
      if (!secret) {
        dispatch({ type: "failed", message: "This page no longer has the link. Open the original link again." });
        return;
      }
      const bytes = secretBytesFromB64url(secret);
      const key = await deriveRouterKey(bytes);
      router.current = key;
      if (alive) setRouterAddress(key.address);
      const externalId = await externalIdFor(bytes);
      const mh = createMhClient(undefined, externalId);

      if (!to) {
        // A reopened link: a transfer already knows where the money goes.
        const t = await mh.byExternal(externalId).catch(() => null);
        if (!alive) return;
        if (t?.recipientWallet) setTo(t.recipientWallet);
        else setNeedsRecipient(true);
        return;
      }
      setNeedsRecipient(false);
      await runRoute({
        mh,
        rpc,
        key,
        externalId,
        pollMs,
        asset,
        alive: () => alive,
        emit: (ev) => alive && dispatch(ev),
        info: (patch) => alive && setInfo((i) => ({ ...i, ...patch })),
        recipient: () => to,
      });
    })();
    return () => {
      alive = false;
    };
  }, [getSecret, to, asset, pollMs, rpc, runKey]);

  // A slow clock for "about N min" and for the late notice.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(t);
  }, []);

  const transfer: MhTransfer | null = state.transfer;
  const phase = state.phase;
  const swapping = mode === "route" && !info.funded && transfer === null;
  const arrived = info.arrived === true;
  const rows = trackerRows({
    swapping,
    phase,
    transfer,
    arrived,
    hideSwap: mode === "devnet",
  });
  const eta = routeEta(transfer, now);
  const recipientShown = transfer?.recipientWallet ?? to;
  const giftAsset = info.asset ?? asset ?? (transfer ? assetForMint(transfer.tokenMint) : null);

  const sendBack = useCallback(async () => {
    const key = router.current;
    const dest = transfer?.recipientWallet ?? to;
    if (!key || !dest) return;
    setRefund("sending");
    try {
      const mint = transfer?.tokenMint ?? mintFor(giftAsset ?? "sol");
      await emptyRouter(key, dest, mint, rpc, { sendTokens: true });
      setRefund("done");
    } catch {
      setRefund("failed");
    }
  }, [giftAsset, rpc, to, transfer]);

  /* ----------------------------------------------- a reopened link: where to? */

  if (needsRecipient && !to) {
    const problem = typed.trim() === "" ? "empty" : checkSolanaAddress(typed.trim());
    return (
      <div className="card stack" data-testid="route-resume-ask">
        <h2>{copy.resumeAsk}</h2>
        <p className="hint">{copy.resumeAskBody}</p>
        <label className="field">
          <span className="label">{copy.resumeAddress}</span>
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            data-testid="route-resume-input"
          />
        </label>
        <button
          type="button"
          className="primary"
          disabled={problem !== null}
          onClick={() => setTo(typed.trim())}
          data-testid="route-resume-go"
        >
          {copy.resumeGo}
        </button>
      </div>
    );
  }

  /* ------------------------------------------------------------ the tracker */

  const testing = mode === "devnet";
  const waitingForFunds = testing && !info.funded && transfer === null;
  const hops = transfer?.route?.hops ?? [];

  let line: string;
  if (arrived) line = copy.arrivedLine;
  else if (phase === "signing" || phase === "creating") {
    line = state.step ? copy.signing(state.step.index, state.step.total) : copy.working;
  } else if (phase === "routing") {
    const words = etaWords(eta.remainingSec);
    line = words ? copy.eta(words) : copy.working;
  } else if (phase === "done") line = copy.landing;
  else line = swapping ? copy.waitingFunds : copy.working;

  return (
    <div className="card stack" data-testid="route-tracker" data-phase={phase} data-arrived={arrived}>
      <h2>{testing ? copy.devnetTitle : copy.trackerTitle}</h2>

      {testing ? (
        <p className="warn" data-testid="route-devnet-badge">
          {copy.devnetBadge}
        </p>
      ) : null}

      {waitingForFunds && routerAddress ? (
        <div className="stack" data-testid="route-devnet-fund">
          <p>{copy.devnetBody}</p>
          <CopyField label={copy.devnetLabel} value={routerAddress} testId="route-router-address" />
          <div className="qr">
            <Qr value={routerAddress} label="Route wallet address" />
          </div>
          <p className="hint">{copy.devnetWaiting}</p>
          <p className="fine">{copy.devnetNote}</p>
        </div>
      ) : null}

      <ul className="stage-list" data-testid="route-stage-list">
        {rows.map((row) => (
          <li key={row.key} data-stage={row.key} data-state={row.state} data-testid="route-stage-row">
            <span className="stage-mark" aria-hidden="true">
              {row.state === "done" ? "✓" : row.state === "active" ? "•" : row.state === "stopped" ? "×" : "·"}
            </span>
            <span>{row.label}</span>
          </li>
        ))}
      </ul>

      {phase === "refunded" ? (
        <div className="stack" data-testid="route-refunded">
          <h3>{copy.refundedTitle}</h3>
          <p className="warn">{copy.refunded}</p>
          <p>{copy.refundedBody}</p>
          {refund === "done" ? (
            <p data-testid="route-refund-done">{copy.refundDone}</p>
          ) : (
            <button
              type="button"
              className="primary"
              disabled={refund === "sending" || !recipientShown}
              onClick={() => void sendBack()}
              data-testid="route-refund-send"
            >
              {refund === "sending" ? copy.refundSending : copy.refundSend}
            </button>
          )}
          {refund === "failed" ? (
            <p className="error" data-testid="route-refund-failed">
              {copy.refundFailed}
            </p>
          ) : null}
        </div>
      ) : phase === "failed" ? (
        <div className="stack" data-testid="route-failed">
          <p className="error">{copy.failedLine}</p>
          {state.error ? <p className="fine">{state.error}</p> : null}
          <button
            type="button"
            className="primary"
            onClick={() => {
              dispatch({ type: "retry" });
              setRunKey((k) => k + 1);
            }}
            data-testid="route-retry"
          >
            {copy.retry}
          </button>
        </div>
      ) : waitingForFunds ? null : (
        <p aria-live="polite" data-testid="route-status-line">
          {line}
        </p>
      )}

      {eta.late && !arrived && phase !== "refunded" && phase !== "failed" ? (
        <p className="hint" data-testid="route-late">
          {copy.late}
        </p>
      ) : null}

      {info.note && phase !== "failed" ? (
        <p className="fine" data-testid="route-note">
          {info.note}
        </p>
      ) : null}

      {recipientShown ? (
        <p className="row">
          <span className="label">{copy.receivedLabel}</span>
          <span className="mono" data-testid="route-recipient">
            {truncateMiddle(recipientShown, 10)}
          </span>
        </p>
      ) : null}

      <p className="hint" data-testid="route-close-note">
        {copy.closeNote}
      </p>

      <details data-testid="route-details">
        <summary>{copy.details}</summary>
        <div className="stack tight">
          {routerAddress ? (
            <p className="row">
              <span className="label">{copy.routerLabel}</span>
              <a
                className="mono"
                href={solscanAccount(routerAddress, SOLANA_CLUSTER)}
                target="_blank"
                rel="noreferrer noopener"
                data-testid="route-router-link"
              >
                {truncateMiddle(routerAddress, 10)}
              </a>
            </p>
          ) : null}
          {hops
            .filter((h) => h.txSignature)
            .map((h, i) => (
              <p className="row" key={h.index}>
                <span className="label">{copy.hopTx(i + 1)}</span>
                <a
                  className="mono"
                  href={solscanTx(h.txSignature!, SOLANA_CLUSTER)}
                  target="_blank"
                  rel="noreferrer noopener"
                  data-testid="route-hop-link"
                >
                  {truncateMiddle(h.txSignature!, 8)}
                </a>
              </p>
            ))}
          {(info.finalSignatures ?? []).map((sig) => (
            <p className="row" key={sig}>
              <span className="label">{copy.swapTx}</span>
              <a
                className="mono"
                href={solscanTx(sig, SOLANA_CLUSTER)}
                target="_blank"
                rel="noreferrer noopener"
                data-testid="route-final-link"
              >
                {truncateMiddle(sig, 8)}
              </a>
            </p>
          ))}
          {phase === "routing" || phase === "signing" ? (
            <p className="fine">{copy.stuckHint}</p>
          ) : null}
        </div>
      </details>

      {onBack && waitingForFunds ? (
        <button type="button" className="ghost wide" onClick={onBack} data-testid="route-back">
          {copy.devnetSkip}
        </button>
      ) : null}
    </div>
  );
}
