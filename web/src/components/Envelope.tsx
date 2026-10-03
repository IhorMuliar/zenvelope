import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { noteCopy } from "../copy/en";
import {
  BODY,
  BOTTOM,
  BOTTOM_EDGE,
  ENV_H,
  ENV_W,
  FLAP,
  FLAP_BOX_H,
  FLAP_EDGE,
  FLAP_IN,
  FLAP_IN_EDGE,
  MOTION_VARS,
  OPEN_TOTAL_MS,
  SEAL_TOTAL_MS,
  SIDE_L,
  SIDE_L_EDGE,
  SIDE_R,
  SIDE_R_EDGE,
  TEAR_MS,
  WAX_BEADS,
  WAX_COLOR,
  WAX_IMP,
  WAX_OUTLINE,
  WAX_PALETTES,
  WAX_RIM,
  WAX_RIM_OUT,
  WAX_RIM_PATH,
  arc,
} from "../lib/envelopeArt";
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

/** Ids for one envelope's SVG definitions: several envelopes share a page. */
type Ids = { id: (n: string) => string; url: (n: string) => string };

function useIds(): Ids {
  const uid = `ev${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return { id: (n) => `${uid}-${n}`, url: (n) => `url(#${uid}-${n})` };
}

/**
 * The envelope, drawn as paper: a back panel with its security tint, the note,
 * then the side and bottom flaps in front of it, the top flap on a hinge, and a
 * wax seal. Every shape shares one coordinate space (lib/envelopeArt), so the
 * edges meet exactly; the filters are static and only transform and opacity
 * move. Each state is a class, and the seal and open sequences are keyframes
 * under a class that is never set when motion is reduced.
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
  const ids = useIds();
  const stage = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<"open" | "sealed">(
    revealOnMount && !reduced ? "sealed" : state,
  );
  const [anim, setAnim] = useState<"seal" | "open" | null>(null);
  const [settled, setSettled] = useState(true);
  // The postmark is inked on once, when a sealed envelope first appears.
  const [inking] = useState(() => !!postmark && state === "sealed" && !busy && !torn && !reduced);

  // The timings, from the one table, as custom properties on this stage.
  useLayoutEffect(() => {
    const el = stage.current;
    if (el) for (const [k, v] of MOTION_VARS) el.style.setProperty(k, v);
  }, []);

  useEffect(() => {
    if (shown === state) return;
    // Two frames, so the starting state is painted before the sequence starts.
    let b = 0;
    const a = requestAnimationFrame(() => {
      b = requestAnimationFrame(() => {
        if (!reduced) {
          setAnim(state === "sealed" ? "seal" : "open");
          setSettled(false);
        }
        setShown(state);
      });
    });
    return () => {
      cancelAnimationFrame(a);
      cancelAnimationFrame(b);
    };
  }, [state, shown, reduced]);

  // The sequence ends on the static pose of the new state, so dropping the
  // class at the end changes nothing on screen.
  useEffect(() => {
    if (!anim) return;
    const t = window.setTimeout(
      () => {
        setAnim(null);
        setSettled(true);
      },
      anim === "seal" ? SEAL_TOTAL_MS : OPEN_TOTAL_MS,
    );
    return () => window.clearTimeout(t);
  }, [anim, shown]);

  const open = shown === "open";
  const cls = [
    "env-stage",
    `env-${size}`,
    `wax-${WAX_COLOR}`,
    rise ? "has-rise" : "",
    open ? "is-open" : "is-sealed",
    busy ? "is-busy" : "",
    note ? "" : "is-empty",
    anim ? `anim-${anim}` : "",
    inking ? "is-inking" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={cls}
      ref={stage}
      data-testid="envelope"
      data-open={open ? "true" : "false"}
      data-settled={settled && shown === state ? "true" : "false"}
    >
      <span className="sr-only">
        {open ? (note ? noteCopy.openLabel : noteCopy.emptyLabel) : noteCopy.sealedLabel}
      </span>
      <div className="env">
        <Defs ids={ids} />
        <div className="env-shadow" aria-hidden="true" />
        <Back ids={ids} />
        <div className="env-flap" aria-hidden="true">
          <FlapInside ids={ids} />
          <FlapFace ids={ids} />
          <svg className="env-flap-shade" viewBox={`0 0 ${ENV_W} ${FLAP_BOX_H}`} preserveAspectRatio="none" focusable="false">
            <path d={FLAP} fill="#3b2a10" />
          </svg>
        </div>
        {note ? (
          <div className="env-note">
            <Note {...note} />
            <div className="env-glint" aria-hidden="true" />
          </div>
        ) : null}
        <Front ids={ids} />
        <svg className="env-cast" viewBox={`0 0 ${ENV_W} ${ENV_H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <path d={FLAP} transform="translate(1.6 3)" fill="rgba(60, 42, 12, 0.3)" filter={ids.url("b3")} />
          <path d={FLAP} transform="translate(0.5 1)" fill="rgba(60, 42, 12, 0.32)" filter={ids.url("b08")} />
        </svg>
        <div className="env-seal" aria-hidden="true">
          <Wax ids={ids} />
          {anim === "open" ? (
            <>
              <Wax ids={ids} piece={1} />
              <Wax ids={ids} piece={2} />
              <Wax ids={ids} piece={3} />
            </>
          ) : null}
        </div>
        {postmark ? <Postmark kind={postmark} ids={ids} /> : null}
        {tear ? (
          <TearStrip {...tear} />
        ) : torn ? (
          <div className="tear is-torn" aria-hidden="true">
            <div className="tear-band" />
            <div className="tear-channel" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Gradients, the security tint, and the filters: the fold-edge lighting (one
 * light, from the top left), the paper grain, the wax and ink. Drawn once per
 * envelope and never animated.
 */
function Defs({ ids }: { ids: Ids }) {
  const { id } = ids;
  const w = WAX_PALETTES[WAX_COLOR];
  return (
    <svg className="env-defs" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        {/* Paper: the outside stock, a little warmer to the light. */}
        <linearGradient id={id("face")} x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0" stopColor="#fbf8f1" />
          <stop offset="1" stopColor="#f2ebdc" />
        </linearGradient>
        <linearGradient id={id("sideL")} x1="0" y1="0" x2="1" y2="0.4">
          <stop offset="0" stopColor="#f8f4ea" />
          <stop offset="1" stopColor="#f1eadb" />
        </linearGradient>
        <linearGradient id={id("sideR")} x1="1" y1="0" x2="0" y2="0.4">
          <stop offset="0" stopColor="#efe7d7" />
          <stop offset="1" stopColor="#f0e9da" />
        </linearGradient>
        <linearGradient id={id("bottom")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f3ecde" />
          <stop offset="1" stopColor="#ece4d2" />
        </linearGradient>
        {/* The inside: cooler, greyer, in the envelope's own shade. */}
        <linearGradient id={id("inside")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ecebe6" />
          <stop offset="1" stopColor="#dedcd5" />
        </linearGradient>
        <linearGradient id={id("pocket")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2c2414" stopOpacity="0" />
          <stop offset="0.4" stopColor="#2c2414" stopOpacity="0.05" />
          <stop offset="1" stopColor="#2c2414" stopOpacity="0.2" />
        </linearGradient>
        <linearGradient id={id("flapIn")} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#e6e4de" />
          <stop offset="1" stopColor="#f0efea" />
        </linearGradient>
        {/* The security tint: fine interlocking waves on a 4-unit repeat. */}
        <pattern id={id("tint")} width="4" height="4" patternUnits="userSpaceOnUse">
          <path
            d="M0 1Q1 -0.2 2 1T4 1M0 3Q1 4.2 2 3T4 3"
            fill="none"
            stroke="#5f7489"
            strokeWidth="0.42"
          />
          <circle cx="2" cy="2" r="0.32" fill="#5f7489" />
        </pattern>
        <clipPath id={id("fclip")}>
          <path d={FLAP_IN} />
        </clipPath>
        {/* Gum along the flap's edges: a glossier, slightly darker band. */}
        <linearGradient id={id("gum")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#b8a77c" stopOpacity="0.16" />
          <stop offset="1" stopColor="#a8976c" stopOpacity="0.26" />
        </linearGradient>

        {/* Fold edges: the shape's own alpha as a height map, lit from the top left. */}
        <filter id={id("bev")} x="-2%" y="-2%" width="104%" height="104%" colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceAlpha" stdDeviation="0.6" result="b" />
          <feDiffuseLighting in="b" surfaceScale="1.1" diffuseConstant="1" lightingColor="#fff" result="l">
            <feDistantLight azimuth="225" elevation="58" />
          </feDiffuseLighting>
          <feComposite in="SourceGraphic" in2="l" operator="arithmetic" k1="1.18" result="lit" />
          <feComposite in="lit" in2="SourceAlpha" operator="in" />
        </filter>
        {/* Paper grain: fine specks and a faint mottle, clipped to the shape. */}
        <filter id={id("grain")} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="1.15" numOctaves="2" seed="4" stitchTiles="stitch" result="t" />
          <feColorMatrix in="t" type="matrix" values="0 0 0 0 0.3  0 0 0 0 0.24  0 0 0 0 0.15  -2.4 0 0 0 1.3" result="specks" />
          <feTurbulence type="fractalNoise" baseFrequency="0.018 0.06" numOctaves="3" seed="11" result="f" />
          <feColorMatrix in="f" type="matrix" values="0 0 0 0 0.35  0 0 0 0 0.28  0 0 0 0 0.16  -0.6 0 0 0 0.33" result="mottle" />
          <feMerge result="m">
            <feMergeNode in="mottle" />
            <feMergeNode in="specks" />
          </feMerge>
          <feComposite in="m" in2="SourceAlpha" operator="in" />
        </filter>
        <filter id={id("b08")} x="-10%" y="-10%" width="120%" height="120%">
          <feGaussianBlur stdDeviation="0.8" />
        </filter>
        <filter id={id("b16")} x="-10%" y="-10%" width="120%" height="120%">
          <feGaussianBlur stdDeviation="1.6" />
        </filter>
        <filter id={id("b3")} x="-10%" y="-10%" width="120%" height="120%">
          <feGaussianBlur stdDeviation="3" />
        </filter>

        {/* Wax. */}
        <radialGradient id={id("wbody")} cx="0.4" cy="0.36" r="0.7">
          <stop offset="0" stopColor={w.light} />
          <stop offset="0.42" stopColor={w.mid} />
          <stop offset="0.8" stopColor={w.deep} />
          <stop offset="1" stopColor={w.dark} />
        </radialGradient>
        <linearGradient id={id("wedge")} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={w.hi} stopOpacity="0.95" />
          <stop offset="0.38" stopColor={w.light} stopOpacity="0" />
          <stop offset="0.62" stopColor={w.dark} stopOpacity="0" />
          <stop offset="1" stopColor={w.dark} stopOpacity="0.85" />
        </linearGradient>
        <linearGradient id={id("wrim")} x1="0.15" y1="0.1" x2="0.85" y2="0.9">
          <stop offset="0" stopColor={w.hi} />
          <stop offset="0.3" stopColor={w.light} />
          <stop offset="0.62" stopColor={w.mid} />
          <stop offset="1" stopColor={w.dark} />
        </linearGradient>
        <radialGradient id={id("wfloor")} cx="0.55" cy="0.58" r="0.6">
          <stop offset="0" stopColor={w.floor} />
          <stop offset="1" stopColor={w.floorDeep} />
        </radialGradient>
        <linearGradient id={id("wwall")} x1="0.15" y1="0.1" x2="0.85" y2="0.9">
          <stop offset="0" stopColor={w.dark} stopOpacity="0.9" />
          <stop offset="0.45" stopColor={w.deep} stopOpacity="0.2" />
          <stop offset="0.7" stopColor={w.light} stopOpacity="0.3" />
          <stop offset="1" stopColor={w.hi} stopOpacity="0.95" />
        </linearGradient>
        <filter id={id("wsoft")} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="0.9" />
        </filter>
        <filter id={id("wfine")} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="0.35" />
        </filter>
        <filter id={id("wglow")} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.6" />
        </filter>

        {/* Ink: spread a little, wander a little, and take unevenly. */}
        <filter id={id("ink")} x="-5%" y="-5%" width="110%" height="110%" colorInterpolationFilters="sRGB">
          <feMorphology in="SourceGraphic" operator="dilate" radius="0.3" result="d" />
          <feTurbulence type="fractalNoise" baseFrequency="0.25" numOctaves="2" seed="3" result="n" />
          <feDisplacementMap in="d" in2="n" scale="0.9" xChannelSelector="R" yChannelSelector="G" result="w" />
          <feTurbulence type="fractalNoise" baseFrequency="0.9 1.3" numOctaves="2" seed="8" result="n2" />
          <feColorMatrix in="n2" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1.7 0 0 0 0.25" result="m" />
          <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="5" result="n3" />
          <feColorMatrix in="n3" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  2 0 0 0 -0.05" result="m2" />
          <feComposite in="m" in2="m2" operator="in" result="mm" />
          <feComposite in="w" in2="mm" operator="in" />
        </filter>
      </defs>
    </svg>
  );
}

const S = { focusable: "false" as const, preserveAspectRatio: "none" };

/** The back panel, seen from inside: tint, the pocket's depth, the fold lines. */
function Back({ ids }: { ids: Ids }) {
  const { url } = ids;
  return (
    <svg className="env-back" viewBox={`0 0 ${ENV_W} ${ENV_H}`} aria-hidden="true" {...S}>
      <path d={BODY} fill={url("inside")} filter={url("bev")} />
      <path d={BODY} fill={url("tint")} className="env-tint" />
      <path d={BODY} fill={url("pocket")} />
      <path d={BODY} fill="#000" filter={url("grain")} className="env-grain" />
    </svg>
  );
}

/** The flap's outside: what shows when the envelope is sealed. */
function FlapFace({ ids }: { ids: Ids }) {
  const { url } = ids;
  return (
    <svg className="env-flap-face" viewBox={`0 0 ${ENV_W} ${FLAP_BOX_H}`} {...S}>
      <path d={FLAP} fill={url("face")} filter={url("bev")} />
      <path d={FLAP} fill="#000" filter={url("grain")} className="env-grain" />
      <path d={FLAP_EDGE} transform="translate(0 -0.9)" className="seam-hi" />
      <path d={FLAP_EDGE} className="seam" />
    </svg>
  );
}

/**
 * The flap's inside, seen when it stands open. Turned over on the hinge, so it
 * is drawn upside down here: the hinge at the bottom, the point at the top.
 */
function FlapInside({ ids }: { ids: Ids }) {
  const { url } = ids;
  return (
    <svg className="env-flap-inside" viewBox={`0 0 ${ENV_W} ${FLAP_BOX_H}`} {...S}>
      <path d={FLAP_IN} fill={url("flapIn")} filter={url("bev")} />
      <path d={FLAP_IN} fill={url("tint")} className="env-tint" />
      <g clipPath={url("fclip")}>
        <path d={FLAP_IN_EDGE} className="env-gum" stroke={url("gum")} />
        <path d={FLAP_IN_EDGE} transform="translate(0 9.2)" className="env-gum-shine" />
      </g>
      <path d={FLAP_IN} fill="#000" filter={url("grain")} className="env-grain" />
      <path d={FLAP_IN_EDGE} className="seam" />
    </svg>
  );
}

/** The pocket: the bottom flap, and the two side flaps lying over it. */
function Front({ ids }: { ids: Ids }) {
  const { url } = ids;
  return (
    <svg className="env-front" viewBox={`0 0 ${ENV_W} ${ENV_H}`} aria-hidden="true" {...S}>
      <path d={BOTTOM} fill={url("bottom")} filter={url("bev")} />
      <path d={BOTTOM_EDGE} transform="translate(0 0.9)" className="seam-hi" />
      <path d={BOTTOM_EDGE} className="seam" />
      {/* Where the side flaps lie on the bottom flap: a contact shadow each. */}
      <g className="env-contact">
        <path d={SIDE_L} transform="translate(1.4 2.2)" filter={url("b16")} />
        <path d={SIDE_L} transform="translate(0.4 0.7)" filter={url("b08")} />
        <path d={SIDE_R} transform="translate(0.6 2.2)" filter={url("b16")} />
        <path d={SIDE_R} transform="translate(0 0.7)" filter={url("b08")} />
      </g>
      <path d={SIDE_L} fill={url("sideL")} filter={url("bev")} />
      <path d={SIDE_R} fill={url("sideR")} filter={url("bev")} />
      <path d={SIDE_L_EDGE} transform="translate(-0.9 0)" className="seam-hi" />
      <path d={SIDE_R_EDGE} transform="translate(0.9 0)" className="seam-hi" />
      <path d={SIDE_L_EDGE} className="seam" />
      <path d={SIDE_R_EDGE} className="seam" />
      <g fill="#000" filter={url("grain")} className="env-grain">
        <path d={BOTTOM} />
        <path d={SIDE_L} />
        <path d={SIDE_R} />
      </g>
    </svg>
  );
}

/**
 * The wax seal, as stacked layers so the stamp can press each one: the puddle,
 * the rim the stamp pushed out, the impression with its monogram, the gloss.
 * `piece` draws one of three shards for the crack when the envelope opens.
 */
function Wax({ ids, piece }: { ids: Ids; piece?: number }) {
  const { url } = ids;
  const v = "-60 -60 120 120";
  return (
    <div className={piece ? `wax wax-piece wax-piece-${piece}` : "wax wax-whole"}>
      <svg className="wax-l wax-base" viewBox={v} focusable="false">
        <path d={WAX_OUTLINE} transform="translate(2 3.4)" fill="rgba(45, 26, 0, 0.42)" filter={url("wglow")} />
        <path d={WAX_OUTLINE} transform="translate(0.5 0.9)" fill="rgba(45, 26, 0, 0.45)" filter={url("wfine")} />
        <path d={WAX_OUTLINE} fill={url("wbody")} />
        <path d={WAX_OUTLINE} fill="none" stroke={url("wedge")} strokeWidth="2.2" filter={url("wfine")} />
      </svg>
      <svg className="wax-l wax-rim" viewBox={v} focusable="false">
        <path d={WAX_RIM_OUT} fill="none" stroke="rgba(40, 22, 0, 0.3)" strokeWidth="1.8" filter={url("wsoft")} />
        <path d={WAX_RIM_PATH} fill="none" stroke={url("wrim")} strokeWidth="8" filter={url("wfine")} />
        <path d={arc(WAX_RIM + 6, 20, 80)} fill="none" stroke="#fff" strokeOpacity="0.28" strokeWidth="2.4" strokeLinecap="round" filter={url("wsoft")} />
      </svg>
      <svg className="wax-l wax-imp" viewBox={v} focusable="false">
        <circle r={WAX_IMP} fill={url("wfloor")} />
        <circle r={WAX_IMP - 1} fill="none" stroke={url("wwall")} strokeWidth="2.6" filter={url("wfine")} />
        <g className="wax-beads">
          {WAX_BEADS.map(([x, y], i) => (
            <g key={i}>
              <circle cx={x + 0.45} cy={y + 0.45} r="1.05" className="wax-deb-hi" />
              <circle cx={x - 0.35} cy={y - 0.35} r="1.05" className="wax-deb-lo" />
              <circle cx={x} cy={y} r="0.95" className="wax-deb" />
            </g>
          ))}
        </g>
        <text x="0.7" y="10.7" textAnchor="middle" className="wax-z wax-deb-hi">Z</text>
        <text x="-0.5" y="9.5" textAnchor="middle" className="wax-z wax-deb-lo">Z</text>
        <text x="0" y="10" textAnchor="middle" className="wax-z wax-deb">Z</text>
      </svg>
      <svg className="wax-l wax-spec" viewBox={v} focusable="false">
        <ellipse cx="-22" cy="-25" rx="9" ry="4.2" transform="rotate(-38 -22 -25)" fill="#fff" opacity="0.38" filter={url("wglow")} />
        <path d={arc(WAX_RIM + 1.2, 196, 252)} className="wax-spark" filter={url("wfine")} />
        <path d={arc(WAX_RIM + 1.2, 206, 236)} className="wax-spark wax-spark-core" />
        <path d={arc(WAX_IMP - 0.6, 18, 66)} className="wax-spark wax-spark-low" filter={url("wfine")} />
        <circle cx="30.5" cy="24" r="1.1" fill="#fff" opacity="0.6" filter={url("wfine")} />
      </svg>
      {piece ? null : <div className="wax-glint" />}
    </div>
  );
}

/** "3 OCT" and "2026", from the visitor's own clock. */
function today(): [string, string] {
  const d = new Date();
  const month = d.toLocaleDateString("en-GB", { month: "short" }).toUpperCase().slice(0, 3);
  return [`${d.getDate()} ${month}`, String(d.getFullYear())];
}

/** The postmark: a dated ring and the wavy cancellation lines, in ink. */
function Postmark({ kind, ids }: { kind: "today" | "sent"; ids: Ids }) {
  const [day, year] = today();
  const ring = ids.id(`pm-${kind}`);
  return (
    <svg className={`postmark postmark-${kind}`} viewBox="0 0 160 100" aria-hidden="true" focusable="false">
      <defs>
        <path id={ring} d="M110 50m-35 0a35 35 0 1 1 70 0a35 35 0 1 1 -70 0" />
      </defs>
      <g filter={ids.url("ink")} fill="currentColor">
        <g fill="none" stroke="currentColor" strokeWidth="2">
          {[28, 38, 48, 58, 68].map((y) => (
            <path key={y} d={`M2 ${y}c6 -5 10 -5 16 0s10 5 16 0s10 -5 16 0s10 5 16 0`} />
          ))}
        </g>
        <circle cx="110" cy="50" r="44" fill="none" stroke="currentColor" strokeWidth="2.6" />
        <circle cx="110" cy="50" r="28.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <text className="postmark-ring">
          <textPath href={`#${ring}`}>{noteCopy.postmarkRing}</textPath>
        </text>
        {kind === "sent" ? (
          <text className="postmark-day" x="110" y="55" textAnchor="middle">
            {noteCopy.postmarkSent}
          </text>
        ) : (
          <>
            <text className="postmark-day" x="110" y="48" textAnchor="middle">
              {day}
            </text>
            <text className="postmark-year" x="110" y="61" textAnchor="middle">
              {year}
            </text>
          </>
        )}
      </g>
    </svg>
  );
}

/**
 * The tear strip. Its tab is the Open button: a tap, a click or a key runs the
 * tab along the perforation and opens; pulling the tab along it opens too. A
 * pull let go of early springs back and does not open.
 */
function TearStrip({ onOpen, label, testId }: TearProps) {
  const strip = useRef<HTMLDivElement>(null);
  const tab = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ x: number; span: number; moved: boolean } | null>(null);
  const done = useRef(false);
  const suppressClick = useRef(false);
  const frame = useRef(0);
  const timer = useRef(0);
  const reduced = useReducedMotion();

  const fire = () => {
    if (done.current) return;
    done.current = true;
    const el = strip.current;
    el?.removeAttribute("data-drag");
    if (reduced || !el) {
      onOpen();
      return;
    }
    cancelAnimationFrame(frame.current);
    el.setAttribute("data-tearing", "");
    el.style.setProperty("--p", "1");
    timer.current = window.setTimeout(onOpen, TEAR_MS);
  };

  const setP = (p: number) => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => strip.current?.style.setProperty("--p", p.toFixed(3)));
  };

  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      window.clearTimeout(timer.current);
    },
    [],
  );

  return (
    <div className="tear" ref={strip}>
      <div className="tear-band" aria-hidden="true" />
      <div className="tear-channel" aria-hidden="true" />
      <div className="tear-peel" aria-hidden="true" />
      <button
        ref={tab}
        type="button"
        className="tear-tab"
        data-testid={testId}
        onPointerDown={(e) => {
          if (reduced || done.current || e.button !== 0 || !strip.current || !tab.current) return;
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
        {label}
        <span className="tear-grip" aria-hidden="true" />
      </button>
    </div>
  );
}
