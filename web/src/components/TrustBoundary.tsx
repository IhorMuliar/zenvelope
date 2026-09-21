/**
 * The screen shown before a Solana exit.
 *
 * Leaving the shielded pool is the one irreversible privacy decision in the
 * product: everything else a recipient does can be done again, and this cannot.
 * So it gets a screen of its own rather than a line of fine print — four things
 * you give up, and a checkbox that is the only way past them.
 *
 * The gate is inside the component on purpose. A caller cannot forget it,
 * cannot style it away, and cannot reach `onContinue` without the tick: the
 * button is disabled *and* the handler re-checks, so neither a devtools poke at
 * the `disabled` attribute nor a keyboard activation gets through.
 *
 * Not wired into the send-on flow yet — M5 does that. It is written, styled and
 * tested here so that the copy and the gate are settled before the rail lands.
 */

import { useState } from "react";
import { trustBoundary as copy } from "../copy/en";

export interface TrustBoundaryProps {
  /** Called only once the box is ticked. Never called otherwise. */
  onContinue?: () => void;
  /** The way back to a shielded destination. Always available. */
  onBack?: () => void;
  /**
   * Controlled tick state, for a caller that wants to own it (and for the test,
   * which has no DOM to click with). Leave it out and the component keeps its
   * own state, which is how the flow will use it.
   */
  acknowledged?: boolean;
  onAcknowledgedChange?: (next: boolean) => void;
  /** Overrides the button label; the gate is the same either way. */
  continueLabel?: string;
}

/**
 * The gate, as a pure function, so the rule itself can be tested without a DOM
 * and so the disabled attribute and the click handler cannot disagree.
 */
export function trustBoundaryBlocked(acknowledged: boolean): boolean {
  return !acknowledged;
}

export function TrustBoundary({
  onContinue,
  onBack,
  acknowledged,
  onAcknowledgedChange,
  continueLabel = copy.continue,
}: TrustBoundaryProps) {
  const [own, setOwn] = useState(false);
  const ticked = acknowledged ?? own;
  const blocked = trustBoundaryBlocked(ticked);

  const setTicked = (next: boolean) => {
    if (acknowledged === undefined) setOwn(next);
    onAcknowledgedChange?.(next);
  };

  return (
    <section className="card stack trust-boundary" data-testid="trust-boundary">
      <h2 data-testid="trust-title">{copy.title}</h2>
      <p className="warn">{copy.lede}</p>

      <ul className="give-up" data-testid="trust-points">
        {copy.points.map((point) => (
          <li key={point.title}>
            <strong>{point.title}</strong>
            <span>{point.body}</span>
          </li>
        ))}
      </ul>

      <label className="check">
        <input
          type="checkbox"
          checked={ticked}
          data-testid="trust-ack"
          onChange={(e) => setTicked(e.target.checked)}
        />
        {copy.checkbox}
      </label>

      <button
        type="button"
        className="primary"
        disabled={blocked}
        aria-disabled={blocked}
        data-testid="trust-continue"
        onClick={() => {
          // Second lock. `disabled` is a DOM attribute and attributes can be
          // edited; this cannot.
          if (trustBoundaryBlocked(ticked)) return;
          onContinue?.();
        }}
      >
        {continueLabel}
      </button>

      {blocked ? (
        <p className="hint" data-testid="trust-blocked">
          {copy.blockedHint}
        </p>
      ) : null}

      <button type="button" className="ghost wide" data-testid="trust-back" onClick={onBack}>
        {copy.back}
      </button>
    </section>
  );
}
