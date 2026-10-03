import { memo, useId, useLayoutEffect, useMemo, useRef } from "react";
import { noteCopy, revealed } from "../copy/en";
import { PATTERN_H, PATTERN_W, guilloche, serialFor } from "../lib/guilloche";
import { useTilt } from "../lib/motion";

export interface NoteProps {
  /** The amount as a ZEC string, without the unit: "0.05". */
  amount: string;
  /** The message. Clamped to two lines on the note; the DOM keeps all of it. */
  memo?: string;
  /** Shown faded on the memo line when there is no message. */
  memoEmpty?: string;
  /** The sender's name as typed, without "From". */
  from?: string;
  /** What the pattern and serial are drawn from. Public data only: see lib/guilloche. */
  seed: string;
  /** Tilt with the pointer or the phone. Off for small, static notes. */
  tilt?: boolean;
  /** Test ids for the three lines that carry meaning, where a page needs them. */
  testIds?: { amount?: string; memo?: string; from?: string };
  className?: string;
}

/**
 * The engraved pattern: drawn once per seed (the generator caches it) and
 * memoised here, so typing in the form re-renders the text and not the paths.
 */
const Pattern = memo(function Pattern({ seed }: { seed: string }) {
  const p = guilloche(seed);
  const id = `mt${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <svg
      className="note-pattern"
      viewBox={`0 0 ${PATTERN_W} ${PATTERN_H}`}
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {p.paths.map((path, i) => (
        <path key={i} d={path.d} strokeWidth={path.width} opacity={path.opacity} />
      ))}
      <defs>
        <path id={id} d={p.ring} />
      </defs>
      <text className="note-microtext" stroke="none" fill="currentColor">
        <textPath href={`#${id}`}>{noteCopy.microtext.repeat(8)}</textPath>
      </text>
    </svg>
  );
});

/**
 * How wide the amount is in ems, roughly, so the figure can shrink to fit the
 * note's right panel: digits are about 0.58em in Bona Nova bold, a point or a
 * comma about 0.28em.
 */
function amountEms(amount: string): number {
  let ems = 0;
  for (const ch of amount) ems += /[0-9]/.test(ch) ? 0.58 : 0.3;
  return Math.max(ems, 2.2);
}

/**
 * The banknote. A paper object: it stays light on a dark page. Everything in it
 * is sized in container units, so one component serves the landing hero, the
 * wizard's preview and the reveal.
 */
export function Note({
  amount,
  memo: message = "",
  memoEmpty,
  from = "",
  seed,
  tilt = false,
  testIds = {},
  className = "",
}: NoteProps) {
  const card = useRef<HTMLDivElement>(null);
  useTilt(card, tilt);
  const serial = useMemo(() => serialFor(seed), [seed]);
  const name = from.replace(/\s+/g, " ").trim();
  const text = message.trim();
  const denom = useRef<HTMLParagraphElement>(null);
  // Set through the CSSOM, not a style attribute: the CSP allows no inline style.
  useLayoutEffect(() => {
    denom.current?.style.setProperty("--ems", amountEms(amount).toFixed(2));
  }, [amount]);

  return (
    <div className={`note ${className}`.trim()}>
      <div className="note-card" ref={card}>
        <Pattern seed={seed} />
        <div className="note-frame" aria-hidden="true" />
        <div className="note-foil" aria-hidden="true" />
        {name ? (
          <p className="note-from" data-testid={testIds.from}>
            {revealed.from(name)}
          </p>
        ) : null}
        <p
          className="note-denom"
          data-testid={testIds.amount}
          ref={denom}
        >
          <b>{amount}</b> <span>{noteCopy.unit}</span>
        </p>
        <p className={text ? "note-memo" : "note-memo is-empty"}>
          <span className="note-memo-label" aria-hidden="true">
            {noteCopy.memoLabel}
          </span>
          <span className="note-memo-text" data-testid={testIds.memo}>
            {text || memoEmpty || ""}
          </span>
        </p>
        <p className="note-serial" aria-hidden="true">
          {serial}
        </p>
        <p className="note-issuer" aria-hidden="true">
          {noteCopy.issuer}
        </p>
        <div className="note-glare" aria-hidden="true" />
      </div>
    </div>
  );
}
