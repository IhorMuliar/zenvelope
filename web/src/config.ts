/**
 * Static configuration. No secrets here, ever.
 */

export type Network = "main" | "test";

/**
 * Flat service fee, in zatoshi. 30000 zat = 0.0003 ZEC.
 * The sender funds envelope + fee as a single ZIP-321 output (DECISIONS D5).
 * The fee is taken as a second output of the recipient's sweep transaction.
 */
export const FLAT_FEE_ZAT = 30000n;

/** Minimum envelope amount, in zatoshi. 10000 zat = 0.0001 ZEC. */
export const MIN_ENVELOPE_ZAT = 10000n;

/**
 * Maximum size of the sender's message, in UTF-8 bytes.
 *
 * The message travels as the ZIP-321 `memo=` parameter and ends up in the note's
 * memo field, which is exactly 512 bytes. The limit is counted in bytes, not
 * characters: one emoji costs four.
 */
export const MAX_MEMO_BYTES = 512;

/**
 * Where the flat fee goes, as the second output of the sweep (DECISIONS D5).
 *
 * Placeholder. It is deliberately **empty** until a real Zenvelope address
 * exists: a made-up unified address would make every mainnet sweep fail, and a
 * sweep is the recipient's money. While it is empty the open flow passes
 * `fee_zat: "0"`, builds no fee output, and shows no fee line. Filling it in is
 * the only change needed to start taking the fee.
 */
const FEE_ADDRESS_DEFAULT = "";

/**
 * `VITE_FEE_ADDRESS` overrides the constant at build time.
 *
 * The verification run needs a real fee envelope on the second output, and that
 * address lives in a private, gitignored file. An env var keeps it out of the
 * repository while still letting the whole two-output sweep be proved. Unset, or
 * set to nothing, and the constant above wins — which is what every ordinary
 * build sees.
 */
function feeAddressFromEnv(): string {
  try {
    const value = import.meta.env?.VITE_FEE_ADDRESS;
    return typeof value === "string" && value.trim() !== "" ? value.trim() : FEE_ADDRESS_DEFAULT;
  } catch {
    // No import.meta.env at all (a plain node context): the constant stands.
    return FEE_ADDRESS_DEFAULT;
  }
}

export const FEE_ADDRESS = feeAddressFromEnv();

/** True when a fee is actually charged. Everything fee-shaped keys off this. */
export const FEE_ENABLED = FEE_ADDRESS.trim() !== "";

/** The fee in zatoshi that the sweep is asked for: 0 while there is no fee address. */
export const SWEEP_FEE_ZAT = FEE_ENABLED ? FLAT_FEE_ZAT : 0n;

/**
 * ZIP-317 miner fee for the sweep. Two logical actions for a shielded
 * destination; a transparent destination adds one more.
 */
export const NETWORK_FEE_ZAT = 10000n;
export const NETWORK_FEE_TRANSPARENT_ZAT = 15000n;

/**
 * Block explorer for the done screen.
 *
 * Probed 2026-09-21 with the known mainnet txid
 * 281e9f7b…341d43: zcashexplorer.app answered 200 and renders the transaction,
 * 3xpl.com also answered 200, zcashblockexplorer.com did not resolve, and
 * blockchair.com answered 401. The first working one wins.
 */
export const EXPLORER_TX: Record<Network, string> = {
  main: "https://mainnet.zcashexplorer.app/transactions/",
  test: "https://testnet.zcashexplorer.app/transactions/",
};

export function explorerTxUrl(txid: string, network: Network = "main"): string {
  return `${EXPLORER_TX[network]}${txid}`;
}

/**
 * The worst rate the Solana exit will let a recipient accept, in basis points.
 *
 * `effectiveCost().spreadBps` is the whole cost of leaving — the rail's rate, its
 * withdrawal fee and the 25 bps house fee in one number — and above this the
 * deposit step is refused outright rather than shown as a percentage nobody can
 * act on. 1500 bps is 15%: generous next to the 40-60 bps a healthy quote costs,
 * and far under the "amountOut is nearly zero" answer this exists to stop.
 */
export const MAX_SPREAD_BPS = 1500;

/** The explorer's own name, for the link text. */
export const EXPLORER_NAME = "zcashexplorer.app";

/** Primary lightwalletd gRPC-web gateways (DECISIONS D3). */
export const LIGHTWALLETD: Record<Network, string> = {
  main: "https://zjs.zec.rocks/mainnet",
  test: "https://zjs.zec.rocks/testnet",
};

/** Failover gateways. */
export const LIGHTWALLETD_FALLBACK: Record<Network, string> = {
  main: "https://zcash-mainnet.chainsafe.dev",
  test: "https://zcash-testnet.chainsafe.dev",
};

/** Sender wallets we test against (DECISIONS D6). */
export const SENDER_WALLETS = "Zodl, Zingo, ZKool2, Vizor, Cake";

export const TAGLINE =
  "Send shielded money as a link. No wallet, no address, no amount on screen.";
