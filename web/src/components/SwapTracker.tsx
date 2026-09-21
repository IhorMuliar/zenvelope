/**
 * What the swap is doing, after the ZEC has left the envelope.
 *
 * The sweep is finished by the time this renders: the money is on the Zcash
 * chain, on its way to the rail's deposit address, and nothing this component
 * does can change that. It polls `GET /status` every 20 seconds and says where
 * things stand, so the recipient is not left staring at a transaction id
 * wondering whether the other side noticed.
 *
 * It is deliberately harmless. A failed poll is a line on the screen, never an
 * error state: the swap carries on whether or not this tab is open, which the
 * copy says out loud.
 */

import { useEffect, useState } from "react";
import { solanaExit as copy } from "../copy/en";
import {
  formatAssetAmount,
  oneClickStatus,
  solanaTxid,
  type OneClickStatusResponse,
} from "../lib/oneclick";
import { statusPollMs, swapChecklist, swapFinished, swapStatusLine } from "../lib/solanaFlow";
import { truncateMiddle } from "../lib/format";
import type { SwapPlan } from "./SolanaExit";
import { CopyField } from "./CopyField";

interface Props {
  plan: SwapPlan;
  /** Injectable; defaults to `?poll=` or 20 s, so an e2e can watch the whole sequence. */
  pollMs?: number;
}

export function SwapTracker({ plan, pollMs = statusPollMs() }: Props) {
  const [status, setStatus] = useState<OneClickStatusResponse | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;

    const tick = async () => {
      try {
        const next = await oneClickStatus(plan.reservation.address);
        if (!alive) return;
        setStatus(next);
        setUnreachable(false);
        // Nothing changes after SUCCESS, REFUNDED or FAILED, so stop asking.
        if (swapFinished(next)) return;
      } catch {
        if (!alive) return;
        setUnreachable(true);
      }
      timer = window.setTimeout(() => void tick(), pollMs);
    };

    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [plan, pollMs]);

  const rows = swapChecklist(status?.status ?? null);
  const txid = status ? solanaTxid(status) : null;

  return (
    <div className="card stack" data-testid="swap-tracker">
      <h2>{copy.trackingTitle}</h2>
      <p className="hint">{copy.trackingLede}</p>

      <ul className="stage-list" data-testid="swap-stage-list">
        {rows.map((row) => (
          <li
            key={row.stage}
            data-stage={row.stage}
            data-state={row.state}
            data-testid="swap-stage-row"
          >
            <span className="stage-mark" aria-hidden="true">
              {row.state === "done" ? "✓" : row.state === "active" ? "•" : row.state === "stopped" ? "×" : "·"}
            </span>
            <span>{row.label}</span>
          </li>
        ))}
      </ul>

      <p aria-live="polite" data-testid="swap-status-line">
        {swapStatusLine(status?.status ?? null)}
      </p>

      <p className="row">
        <span className="label">{copy.amountOutLabel}</span>
        <span data-testid="swap-tracker-amount-out">
          {formatAssetAmount(plan.reservation.quote, plan.asset)}
        </span>
      </p>

      {txid ? (
        <CopyField
          label={copy.solanaTxLabel}
          value={txid}
          display={truncateMiddle(txid, 10)}
          testId="swap-solana-txid"
        />
      ) : null}

      {unreachable ? (
        <p className="hint" data-testid="swap-tracker-unreachable">
          {copy.trackingLost}
        </p>
      ) : null}

      <p className="fine" data-testid="swap-not-provider">
        {copy.notProvider}
      </p>
    </div>
  );
}
