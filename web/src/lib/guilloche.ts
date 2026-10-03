/**
 * The engraved pattern printed on every note, and its serial number.
 *
 * Both are drawn from a seed, so the same envelope always prints the same note.
 * The seed is never the secret or anything only the secret knows: on the open
 * page and in the sender's wizard it is the envelope's receiving address, which
 * is public on-chain anyway, so sender and recipient see one and the same note.
 * On the landing page, before an envelope exists, it is random per page load.
 *
 * Pure functions, no DOM. The path data is cached per seed, so a note that
 * re-renders on every keystroke does not redraw two thousand points each time.
 */

/** FNV-1a, 32 bit. Not a security hash: it only spreads a public string over a number. */
export function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32: a small, fast, seedable PRNG. Deterministic, which is the point. */
function rng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The pattern's drawing box. The note stretches it to its own size. */
export const PATTERN_W = 410;
export const PATTERN_H = 200;
/** Where the rosette sits: the left panel of the note. */
const CX = 82;
const CY = 100;

export interface PatternPath {
  d: string;
  width: number;
  opacity: number;
}

export interface Pattern {
  /** Rosette rings, the inner rose, then the wave band. */
  paths: PatternPath[];
  /** The microtext ring around the rosette, as a circle path for a textPath. */
  ring: string;
}

const f = (n: number) => n.toFixed(1);

function draw(seed: string): Pattern {
  const r = rng(hash32(seed));
  const paths: PatternPath[] = [];

  // A rosette: three rings of summed sinusoids around a circle.
  const R = 34 + r() * 6;
  const k1 = 7 + Math.floor(r() * 6);
  const k2 = 13 + Math.floor(r() * 9);
  const a1 = 4 + r() * 5;
  const a2 = 2 + r() * 3;
  for (let ring = 0; ring < 3; ring++) {
    const rr = R + ring * 13;
    let d = "";
    for (let i = 0; i <= 540; i++) {
      const t = (i / 540) * Math.PI * 2;
      const rad = rr + a1 * Math.sin(k1 * t + ring) + a2 * Math.cos(k2 * t);
      d += (i ? "L" : "M") + f(CX + rad * Math.cos(t)) + " " + f(CY + rad * Math.sin(t));
    }
    paths.push({ d: d + "Z", width: ring ? 0.45 : 0.6, opacity: 0.75 - ring * 0.15 });
  }

  // A rose curve in the middle: r = 20 cos(9/7 t), closed after seven turns.
  let rose = "";
  for (let i = 0; i <= 700; i++) {
    const t = (i / 700) * Math.PI * 2 * 7;
    const rad = 20 * Math.cos((9 / 7) * t);
    rose += (i ? "L" : "M") + f(CX + rad * Math.cos(t)) + " " + f(CY + rad * Math.sin(t));
  }
  paths.push({ d: rose, width: 0.5, opacity: 0.8 });

  // A band of interfering waves along the bottom of the right panel.
  for (let j = 0; j < 22; j++) {
    const ph = j * 0.26;
    const amp = 7 + r() * 3;
    let d = "";
    for (let x = 150; x <= PATTERN_W; x += 5) {
      const y = 152 + j * 1.7 + amp * Math.sin(x / 23 + ph) + 3 * Math.sin(x / 9 - ph * 2);
      d += (x === 150 ? "M" : "L") + x + " " + f(y);
    }
    paths.push({ d, width: 0.35, opacity: 0.42 });
  }

  const rr = R + 30;
  const ring = `M${f(CX - rr)} ${CY} a${f(rr)} ${f(rr)} 0 1 1 ${f(2 * rr)} 0 a${f(rr)} ${f(rr)} 0 1 1 ${f(-2 * rr)} 0`;
  return { paths, ring };
}

const cache = new Map<string, Pattern>();

/** The pattern for a seed, drawn once and then served from memory. */
export function guilloche(seed: string): Pattern {
  let p = cache.get(seed);
  if (!p) {
    p = draw(seed);
    // A page shows a handful of seeds; keep the cache from growing without end.
    if (cache.size > 32) cache.clear();
    cache.set(seed, p);
  }
  return p;
}

/** "ZV 1A2B 3C4D": eight hex digits of the seed's hash, in two groups. */
export function serialFor(seed: string): string {
  const h = hash32("serial:" + seed)
    .toString(16)
    .toUpperCase()
    .padStart(8, "0");
  return `ZV ${h.slice(0, 4)} ${h.slice(4)}`;
}

/** A seed for a note that has no envelope yet: random, per page load. */
export function randomSeed(): string {
  const b = new Uint32Array(2);
  crypto.getRandomValues(b);
  return `landing-${b[0].toString(16)}${b[1].toString(16)}`;
}

/**
 * A seed for an envelope: its receiving address, which is public. Prefixed so
 * a note seed can never be mistaken for, or reused as, anything else.
 */
export function seedForAddress(address: string): string {
  return `address:${address}`;
}
