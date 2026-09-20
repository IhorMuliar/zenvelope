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

/** Maximum length of the optional message shown to the recipient on open. */
export const MAX_MESSAGE_LEN = 200;

/** Placeholder: replaced with the real Zenvelope fee address before mainnet launch. */
export const FEE_ADDRESS = "u1zenvelopefeeaddressplaceholder000000000000000000000000000000";

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
