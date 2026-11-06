/**
 * Which Solana cluster the private route runs on, chosen at build time.
 *
 *   VITE_SOLANA_CLUSTER = "mainnet" (default) | "devnet"
 *
 * Anything else, or nothing, is mainnet. The 1Click swap rail exists on mainnet
 * only, so a devnet build skips the swap and the ZEC sweep for the private route:
 * it shows the router wallet's address and waits for a tester to send devnet SOL or
 * USDC to it. That is how the whole route UI is exercised on a branch deploy
 * without spending real money.
 */

export type SolanaCluster = "mainnet" | "devnet";

export const USDC_MINT: Record<SolanaCluster, string> = {
  mainnet: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  devnet: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
};

/** Wrapped SOL: the mint MultiHopper uses for a SOL route. */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export function parseCluster(value: unknown): SolanaCluster {
  return typeof value === "string" && value.trim().toLowerCase() === "devnet" ? "devnet" : "mainnet";
}

function fromEnv(): SolanaCluster {
  try {
    return parseCluster(import.meta.env?.VITE_SOLANA_CLUSTER);
  } catch {
    return "mainnet";
  }
}

export const SOLANA_CLUSTER: SolanaCluster = fromEnv();

/** True on the cluster where the 1Click rail exists. */
export function oneClickAvailable(cluster: SolanaCluster = SOLANA_CLUSTER): boolean {
  return cluster === "mainnet";
}

export function usdcMint(cluster: SolanaCluster = SOLANA_CLUSTER): string {
  return USDC_MINT[cluster];
}

/** "?cluster=devnet" on devnet, nothing on mainnet. */
export function clusterSuffix(cluster: SolanaCluster = SOLANA_CLUSTER): string {
  return cluster === "devnet" ? "?cluster=devnet" : "";
}

export function solscanTx(signature: string, cluster: SolanaCluster = SOLANA_CLUSTER): string {
  return `https://solscan.io/tx/${encodeURIComponent(signature)}${clusterSuffix(cluster)}`;
}

export function solscanAccount(address: string, cluster: SolanaCluster = SOLANA_CLUSTER): string {
  return `https://solscan.io/account/${encodeURIComponent(address)}${clusterSuffix(cluster)}`;
}
