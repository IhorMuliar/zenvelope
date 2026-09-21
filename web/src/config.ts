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
export const FEE_ADDRESS = "";

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
