/**
 * The envelope's drawing and its choreography, in one place.
 *
 * Geometry: every shape is drawn in one coordinate space, a 338 x 200 back of
 * an envelope (the stage's 1.69 aspect), so edges that should meet are the same
 * numbers and always coincide. The top flap is drawn in the same space with its
 * hinge on y = 0; closed, it lies exactly where it is drawn.
 *
 * Motion: every delay and duration of the seal and open sequences, in
 * milliseconds. The stage gets them as CSS custom properties, the page waits on
 * the totals, so one edit here retimes both the CSS and the code.
 */

export const ENV_W = 338;
export const ENV_H = 200;
/** The flap's own box: the flap reaches y = 130.3 at its rounded point. */
export const FLAP_BOX_H = 136;

/** The top flap. Corners match the body's 2.5 radius; the point is rounded. */
export const FLAP =
  "M0 2.5A2.5 2.5 0 0 1 2.5 0H335.5A2.5 2.5 0 0 1 338 2.5L178.47 126.63Q169 134 159.53 126.63Z";
/** The flap's free edges only: the seam that is drawn as a line. */
export const FLAP_EDGE = "M0 2.5L159.53 126.63Q169 134 178.47 126.63L338 2.5";

/**
 * The flap's inside, drawn upside down (hinge at the bottom): it is turned
 * over on the hinge to be seen. Flipped in the numbers rather than by a
 * transform, which would turn the fold lighting upside down too.
 */
export const FLAP_IN =
  "M0 133.5A2.5 2.5 0 0 0 2.5 136H335.5A2.5 2.5 0 0 0 338 133.5L178.47 9.37Q169 2 159.53 9.37Z";
export const FLAP_IN_EDGE = "M0 133.5L159.53 9.37Q169 2 178.47 9.37L338 133.5";

/** Left side flap: from the left edge's two corners to a rounded point. */
export const SIDE_L =
  "M0 2.5A2.5 2.5 0 0 1 2.5 0L152.9 101.84Q162 108 152.47 113.5L2.5 200A2.5 2.5 0 0 1 0 197.5Z";
export const SIDE_L_EDGE = "M2.5 0L152.9 101.84Q162 108 152.47 113.5L2.5 200";
export const SIDE_R =
  "M338 2.5A2.5 2.5 0 0 0 335.5 0L185.1 101.84Q176 108 185.53 113.5L335.5 200A2.5 2.5 0 0 0 338 197.5Z";
export const SIDE_R_EDGE = "M335.5 0L185.1 101.84Q176 108 185.53 113.5L335.5 200";

/** Bottom flap: rises from the bottom corners to a broad rounded top. */
export const BOTTOM =
  "M0 197.5L148 103Q169 90 190 103L338 197.5A2.5 2.5 0 0 1 335.5 200H2.5A2.5 2.5 0 0 1 0 197.5Z";
/** The part of the bottom flap's edge that shows between the side flaps. */
export const BOTTOM_EDGE = "M148 103Q169 90 190 103";

/** The whole back, for the panel, the fold lines and the shadow. */
export const BODY = "M2.5 0H335.5A2.5 2.5 0 0 1 338 2.5V197.5A2.5 2.5 0 0 1 335.5 200H2.5A2.5 2.5 0 0 1 0 197.5V2.5A2.5 2.5 0 0 1 2.5 0Z";

/* ------------------------------------------------------------------ wax */

/** The seal's drawing space: a 120 x 120 box centred on the origin. */
export const WAX_R = 46;
export const WAX_RIM = 30.5;
export const WAX_IMP = 25.5;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A puddle of wax: a closed, smooth outline whose radius wanders a little,
 * slightly flattened, with a few small bulges where the wax ran further.
 */
export function waxOutline(seed = 23, n = 64, r = WAX_R, amp = 1, squash = 0.95): string {
  const rand = rng(seed);
  const waves: [number, number, number][] = [];
  for (let k = 2; k <= 7; k++) waves.push([k, (amp * (0.03 + rand() * 0.05)) / Math.sqrt(k - 1), rand() * Math.PI * 2]);
  for (let k = 9; k <= 14; k += 1) waves.push([k, amp * rand() * 0.016, rand() * Math.PI * 2]);
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const th = (i / n) * Math.PI * 2;
    let f = 1;
    for (const [k, a, p] of waves) f += a * Math.sin(k * th + p);
    pts.push([r * f * Math.cos(th), r * f * Math.sin(th) * squash]);
  }
  // Closed Catmull-Rom through the points, as cubic Beziers.
  const f1 = (v: number) => v.toFixed(2);
  let d = `M${f1(pts[0][0])} ${f1(pts[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${f1(c1x)} ${f1(c1y)} ${f1(c2x)} ${f1(c2y)} ${f1(p2[0])} ${f1(p2[1])}`;
  }
  return d + "Z";
}

export const WAX_OUTLINE = waxOutline();
/** The rim the stamp pushed up: nearly round, not quite. */
export const WAX_RIM_PATH = waxOutline(7, 48, WAX_RIM, 0.22, 0.985);
export const WAX_RIM_OUT = waxOutline(7, 48, WAX_RIM + 4.6, 0.35, 0.98);

/** Beads round the impression, as [x, y] centres. */
export const WAX_BEADS: [number, number][] = Array.from({ length: 26 }, (_, i) => {
  const th = (i / 26) * Math.PI * 2;
  return [21 * Math.cos(th), 21 * Math.sin(th)];
});

/** An arc of a circle centred on the origin, angles in degrees, clockwise. */
export function arc(r: number, from: number, to: number): string {
  const p = (deg: number) => {
    const a = (deg * Math.PI) / 180;
    return `${(r * Math.cos(a)).toFixed(2)} ${(r * Math.sin(a)).toFixed(2)}`;
  };
  return `M${p(from)}A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${p(to)}`;
}

/**
 * The wax colour. Gold is the brand; oxblood is there to compare. One constant.
 */
export const WAX_COLOR: "gold" | "oxblood" = "gold";

export const WAX_PALETTES = {
  gold: {
    hi: "#fff6d2",
    light: "#f2cd68",
    mid: "#d49d2c",
    deep: "#a46c14",
    dark: "#5e3a06",
    floor: "#c38c22",
    floorDeep: "#a5721a",
    ink: "#4a2d03",
  },
  oxblood: {
    hi: "#f6b3a8",
    light: "#b9423c",
    mid: "#8c1d21",
    deep: "#621117",
    dark: "#33060a",
    floor: "#7c191e",
    floorDeep: "#611218",
    ink: "#2a0407",
  },
} as const;

/* --------------------------------------------------------------- motion */

type Beat = readonly [delay: number, duration: number];

/** Closing, on the sender's landing page: about two seconds, end to end. */
export const SEAL_BEATS = {
  /** The note slides down into the pocket and settles. */
  note: [0, 560],
  /** The body gives a little as the note lands; the pocket front flexes. */
  bounce: [440, 340],
  /** The flap folds down, overshoots a hair, settles. */
  flap: [420, 680],
  /** Its shadow sweeps down the pocket as it comes. */
  cast: [700, 420],
  /** A drop of wax lands on the point and spreads. */
  drop: [1080, 260],
  /** The stamp presses: squash, rim pushed out, the monogram appears. */
  press: [1300, 340],
  /** Light runs across the fresh wax, once. */
  glint: [1600, 460],
} as const satisfies Record<string, Beat>;

/** Opening, for the recipient, after the tear strip is pulled. */
export const OPEN_BEATS = {
  /** The seal cracks into three and the pieces fall away. */
  crack: [0, 460],
  /** The flap lifts and stands up behind the envelope. */
  flap: [200, 680],
  /** The note rises out with a slight float. */
  note: [620, 980],
  /** The note's foil catches the light, once. */
  glint: [1320, 720],
} as const satisfies Record<string, Beat>;

/** The tab running along the perforation after a tap, before the page moves on. */
export const TEAR_MS = 420;
/** The postmark thumps on once, shortly after a sealed envelope appears. */
export const POSTMARK_BEAT: Beat = [260, 440];

const end = (beats: Record<string, Beat>) =>
  Math.max(...Object.values(beats).map(([d, t]) => d + t));

export const SEAL_TOTAL_MS = end(SEAL_BEATS);
export const OPEN_TOTAL_MS = end(OPEN_BEATS);

/** The beats as custom properties: --seal-note-d (delay), --seal-note-t (time). */
export const MOTION_VARS: [string, string][] = [
  ...Object.entries(SEAL_BEATS).flatMap(([k, [d, t]]) => [
    [`--seal-${k}-d`, `${d}ms`],
    [`--seal-${k}-t`, `${t}ms`],
  ]),
  ...Object.entries(OPEN_BEATS).flatMap(([k, [d, t]]) => [
    [`--open-${k}-d`, `${d}ms`],
    [`--open-${k}-t`, `${t}ms`],
  ]),
  ["--postmark-d", `${POSTMARK_BEAT[0]}ms`],
  ["--postmark-t", `${POSTMARK_BEAT[1]}ms`],
  ["--tear-t", `${TEAR_MS}ms`],
] as [string, string][];
