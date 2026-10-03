import { useEffect, useId, useRef, useState } from "react";
import { noteCopy } from "../copy/en";
import { useReducedMotion } from "../lib/motion";
import { Note, type NoteProps } from "./Note";

export interface TearProps {
  /** Opens the envelope. Called once, by a tap, a key or a full pull. */
  onOpen: () => void;
  /** The button's face and accessible name. */
  label: string;
  testId: string;
}

interface Props {
  /** Open: flap up, the note out. Sealed: the note inside, flap down, seal on. */
  state: "open" | "sealed";
  /** What is inside. Without it the envelope is empty. */
  note?: NoteProps | null;
  /** Keep room above the envelope for the note to rise into. */
  rise?: boolean;
  /** Mount sealed, then open: the reveal. Instant when motion is reduced. */
  revealOnMount?: boolean;
  /** A slow pulse on the seal while the chain is being read. */
  busy?: boolean;
  /** A postmark on the front: today's date, or "Sent". */
  postmark?: "today" | "sent" | null;
  /** The tear strip with its tab, on the recipient's sealed envelope. */
  tear?: TearProps | null;
  /** The strip, already pulled: the envelope is being opened. */
  torn?: boolean;
  size?: "hero" | "card" | "small";
}

/**
 * The envelope: back, note, flap, front pocket, gold seal. Plain DOM and CSS,
 * no image request, and every state is a class, so prefers-reduced-motion can
 * turn every transition into an instant change.
 */
export function Envelope({
  state,
  note = null,
  rise = false,
  revealOnMount = false,
  busy = false,
  postmark = null,
  tear = null,
  torn = false,
  size = "card",
}: Props) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState<"open" | "sealed">(
    revealOnMount && !reduced ? "sealed" : state,
  );

  useEffect(() => {
    if (shown === state) return;
    // Two frames, so the sealed state is painted before the transition starts.
    let b = 0;
    const a = requestAnimationFrame(() => {
      b = requestAnimationFrame(() => setShown(state));
    });
    return () => {
      cancelAnimationFrame(a);
      cancelAnimationFrame(b);
    };
  }, [state, shown]);

  const open = shown === "open";
  // Settled: no transition under way. The note's own transitionend says when
  // it has finished rising or sinking; a state reached without one (reduced
  // motion, or nothing inside to move) is settled at once.
  const [settled, setSettled] = useState(true);
  const first = useRef(true);
  const hasNote = note !== null;
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!hasNote || reduced) return;
    setSettled(false);
    const t = window.setTimeout(() => setSettled(true), 1400);
    return () => window.clearTimeout(t);
  }, [shown, hasNote, reduced]);
  const cls = [
    "env-stage",
    `env-${size}`,
    rise ? "has-rise" : "",
    open ? "is-open" : "is-sealed",
    busy ? "is-busy" : "",
    note ? "" : "is-empty",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={cls}
      data-testid="envelope"
      data-open={open ? "true" : "false"}
      data-settled={settled && shown === state ? "true" : "false"}
    >
      <span className="sr-only">
        {open ? (note ? noteCopy.openLabel : noteCopy.emptyLabel) : noteCopy.sealedLabel}
      </span>
      <div className="env">
        <div className="env-back" aria-hidden="true" />
        {note ? (
          <div
            className="env-note"
            onTransitionEnd={(e) => {
              if (e.target === e.currentTarget) setSettled(true);
            }}
          >
            <Note {...note} />
          </div>
        ) : null}
        <div className="env-flap" aria-hidden="true">
          <div className="env-flap-face" />
          <div className="env-flap-inside" />
        </div>
        <div className="env-front" aria-hidden="true" />
        <div className="env-seal" aria-hidden="true">
          <SealMark />
        </div>
        {postmark ? <Postmark kind={postmark} /> : null}
        {tear ? <TearStrip {...tear} /> : torn ? <div className="tear is-torn" aria-hidden="true" /> : null}
      </div>
    </div>
  );
}

function SealMark() {
  return (
    <svg viewBox="0 0 30 22" focusable="false">
      <rect x="2" y="2" width="26" height="18" rx="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M2.8 3.4 15 12.4 27.2 3.4" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

/** "3 OCT" and "2026", from the visitor's own clock. */
function today(): [string, string] {
  const d = new Date();
  const month = d.toLocaleDateString("en-GB", { month: "short" }).toUpperCase().slice(0, 3);
  return [`${d.getDate()} ${month}`, String(d.getFullYear())];
}

function Postmark({ kind }: { kind: "today" | "sent" }) {
  const [day, year] = today();
  const id = `pm${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <svg className={`postmark postmark-${kind}`} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <defs>
        <path id={id} d="M50 50 m-36 0 a36 36 0 1 1 72 0 a36 36 0 1 1 -72 0" />
      </defs>
      <circle cx="50" cy="50" r="44" fill="none" stroke="currentColor" strokeWidth="2.4" />
      <circle cx="50" cy="50" r="29" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <text className="postmark-ring" fill="currentColor">
        <textPath href={`#${id}`}>{noteCopy.postmarkRing}</textPath>
      </text>
      {kind === "sent" ? (
        <text className="postmark-day" x="50" y="55" textAnchor="middle" fill="currentColor">
          {noteCopy.postmarkSent}
        </text>
      ) : (
        <>
          <text className="postmark-day" x="50" y="48" textAnchor="middle" fill="currentColor">
            {day}
          </text>
          <text className="postmark-year" x="50" y="61" textAnchor="middle" fill="currentColor">
            {year}
          </text>
        </>
      )}
    </svg>
  );
}

/**
 * The tear strip. Its tab is the Open button: a tap, a click or a key opens at
 * once; pulling the tab along the perforation opens too, as a flourish. A pull
 * let go of early springs back and does not open.
 */
function TearStrip({ onOpen, label, testId }: TearProps) {
  const strip = useRef<HTMLDivElement>(null);
  const tab = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ x: number; span: number; moved: boolean } | null>(null);
  const done = useRef(false);
  const suppressClick = useRef(false);
  const frame = useRef(0);
  const reduced = useReducedMotion();

  const fire = () => {
    if (done.current) return;
    done.current = true;
    strip.current?.style.setProperty("--p", "1");
    onOpen();
  };

  const setP = (p: number) => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => strip.current?.style.setProperty("--p", p.toFixed(3)));
  };

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  return (
    <div className="tear" ref={strip}>
      <div className="tear-perf" aria-hidden="true" />
      <div className="tear-done" aria-hidden="true" />
      <button
        ref={tab}
        type="button"
        className="tear-tab"
        data-testid={testId}
        onPointerDown={(e) => {
          if (reduced || e.button !== 0 || !strip.current || !tab.current) return;
          const span = strip.current.clientWidth - tab.current.offsetWidth;
          drag.current = { x: e.clientX, span: Math.max(1, span), moved: false };
          suppressClick.current = false;
          tab.current.setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x;
          if (!d.moved && Math.abs(dx) < 6) return;
          if (!d.moved) strip.current?.setAttribute("data-drag", "");
          d.moved = true;
          const p = Math.max(0, Math.min(1, dx / d.span));
          setP(p);
          if (p >= 0.92) {
            drag.current = null;
            strip.current?.removeAttribute("data-drag");
            fire();
          }
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          strip.current?.removeAttribute("data-drag");
          if (d?.moved && !done.current) {
            // A pull let go early springs back; it was a pull, not a tap.
            suppressClick.current = true;
            setP(0);
          }
        }}
        onPointerCancel={() => {
          drag.current = null;
          strip.current?.removeAttribute("data-drag");
          if (!done.current) setP(0);
        }}
        onClick={() => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          fire();
        }}
      >
        <span className="tear-grip" aria-hidden="true" />
        {label}
      </button>
    </div>
  );
}
