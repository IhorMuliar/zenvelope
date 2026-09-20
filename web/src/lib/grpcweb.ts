/**
 * A minimal gRPC-web client, hand rolled: one unary call, no library.
 *
 * We only need CompactTxStreamer/GetLatestBlock, whose request is an empty
 * ChainSpec (zero bytes) and whose response is
 *   BlockID { uint64 height = 1; bytes hash = 2; }
 *
 * Wire format: length-prefixed frames. 1 flag byte (0x00 data, 0x80 trailer)
 * then a big-endian uint32 length, then that many payload bytes.
 */

export const DATA_FRAME = 0x00;
export const TRAILER_FRAME = 0x80;

/** An empty request message: flag 0x00 plus a zero length. */
export const EMPTY_REQUEST_FRAME = new Uint8Array([0, 0, 0, 0, 0]);

export function encodeFrame(payload: Uint8Array, flag = DATA_FRAME): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = flag;
  const n = payload.length;
  out[1] = (n >>> 24) & 0xff;
  out[2] = (n >>> 16) & 0xff;
  out[3] = (n >>> 8) & 0xff;
  out[4] = n & 0xff;
  out.set(payload, 5);
  return out;
}

export interface Frame {
  flag: number;
  payload: Uint8Array;
}

/** Splits a gRPC-web response body into its frames. */
export function decodeFrames(body: Uint8Array): Frame[] {
  const frames: Frame[] = [];
  let off = 0;
  while (off + 5 <= body.length) {
    const flag = body[off];
    const len =
      ((body[off + 1] << 24) >>> 0) +
      (body[off + 2] << 16) +
      (body[off + 3] << 8) +
      body[off + 4];
    const start = off + 5;
    const end = start + len;
    if (end > body.length) throw new Error("truncated gRPC-web frame");
    frames.push({ flag, payload: body.subarray(start, end) });
    off = end;
  }
  if (off !== body.length) throw new Error("trailing bytes in gRPC-web response");
  return frames;
}

export interface Varint {
  value: bigint;
  next: number;
}

/** Protobuf base-128 varint, little-endian groups, continuation bit high. */
export function readVarint(bytes: Uint8Array, offset = 0): Varint {
  let value = 0n;
  let shift = 0n;
  let i = offset;
  for (;;) {
    if (i >= bytes.length) throw new Error("truncated varint");
    if (shift > 63n) throw new Error("varint too long");
    const b = bytes[i++];
    value |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
  }
  return { value, next: i };
}

export interface BlockId {
  height: number;
  hash: Uint8Array;
}

/** Parses BlockID { uint64 height = 1; bytes hash = 2; }. Unknown fields are skipped. */
export function parseBlockId(msg: Uint8Array): BlockId {
  let height = 0;
  let hash = new Uint8Array(0);
  let off = 0;
  while (off < msg.length) {
    const key = readVarint(msg, off);
    off = key.next;
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (field === 1 && wire === 0) {
      const v = readVarint(msg, off);
      off = v.next;
      if (v.value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("height out of range");
      height = Number(v.value);
    } else if (field === 2 && wire === 2) {
      const len = readVarint(msg, off);
      off = len.next;
      const n = Number(len.value);
      if (off + n > msg.length) throw new Error("truncated bytes field");
      hash = new Uint8Array(msg.subarray(off, off + n));
      off += n;
    } else if (wire === 0) {
      off = readVarint(msg, off).next;
    } else if (wire === 2) {
      const len = readVarint(msg, off);
      off = len.next + Number(len.value);
    } else if (wire === 5) {
      off += 4;
    } else if (wire === 1) {
      off += 8;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
  return { height, hash };
}

/** Pulls the first data frame out of a response body and parses it as a BlockID. */
export function parseGetLatestBlockResponse(body: Uint8Array): BlockId {
  const frames = decodeFrames(body);
  const data = frames.find((f) => (f.flag & TRAILER_FRAME) === 0);
  if (!data) throw new Error("no data frame in gRPC-web response");
  return parseBlockId(data.payload);
}

const METHOD = "/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLatestBlock";

/** One unary GetLatestBlock against a single lightwalletd gRPC-web gateway. */
export async function getLatestBlock(base: string, timeoutMs = 8000): Promise<BlockId> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(base.replace(/\/+$/, "") + METHOD, {
      method: "POST",
      headers: {
        "content-type": "application/grpc-web+proto",
        "x-grpc-web": "1",
      },
      body: EMPTY_REQUEST_FRAME,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const status = res.headers.get("grpc-status");
    if (status && status !== "0") {
      throw new Error(`grpc-status ${status} ${res.headers.get("grpc-message") ?? ""}`.trim());
    }
    return parseGetLatestBlockResponse(new Uint8Array(await res.arrayBuffer()));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Current chain height, primary gateway then failover. Returns null if both
 * fail: an envelope without a birthday still works, it just scans from further
 * back when it is opened.
 */
export async function fetchChainHeight(
  primary: string,
  fallback: string,
): Promise<{ height: number; source: string } | null> {
  for (const base of [primary, fallback]) {
    try {
      const block = await getLatestBlock(base);
      if (block.height > 0) return { height: block.height, source: base };
    } catch {
      // try the next gateway
    }
  }
  return null;
}
