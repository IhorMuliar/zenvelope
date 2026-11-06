/**
 * Read-only wallet discovery over the Wallet Standard event protocol, no dependency.
 *
 * The protocol is two window events:
 *
 *   - `wallet-standard:app-ready`      we dispatch it, `detail` = `{ register(...wallets) }`;
 *                                      wallets that loaded first call `register`
 *   - `wallet-standard:register-wallet` a wallet that loads later dispatches it,
 *                                      `detail` = a callback we call with the same API
 *
 * The only feature this module ever calls is `standard:connect`, and the only thing it
 * keeps from the answer is the first account's public address. It never touches a
 * signing feature, so a connected wallet cannot be asked to approve anything here.
 * That is the whole point of "Connect my wallet": it replaces pasting an address.
 *
 * TODO(mobile): Mobile Wallet Adapter on Android Chrome
 * (@solana-mobile/wallet-standard-mobile) is deliberately not wired up. It would need
 * the Local Network Access prompt flow and a user-gesture connect; for now Android
 * users without an extension get the paste box.
 */

import { base58Encode, checkSolanaAddress } from "./solana";

export const APP_READY = "wallet-standard:app-ready";
export const REGISTER_WALLET = "wallet-standard:register-wallet";

/** The parts of a Wallet Standard wallet this module reads. */
export interface RawWallet {
  name?: unknown;
  icon?: unknown;
  chains?: unknown;
  features?: unknown;
}

export interface DiscoveredWallet {
  name: string;
  /** A `data:image/` URI, or "" when the wallet's icon is not one we may render. */
  icon: string;
  raw: RawWallet;
}

export interface WalletRegistry {
  /** Wallets seen so far, in registration order. */
  list(): DiscoveredWallet[];
  /** Stops listening. */
  stop(): void;
}

/** The CSP allows `img-src data:`, so only data URIs are ever put in an <img>. */
const SAFE_ICON = /^data:image\/(png|svg\+xml|webp|gif|jpeg);/i;

export function safeIcon(icon: unknown): string {
  return typeof icon === "string" && SAFE_ICON.test(icon) ? icon : "";
}

function features(w: RawWallet): Record<string, unknown> {
  return w.features && typeof w.features === "object" ? (w.features as Record<string, unknown>) : {};
}

/**
 * A wallet we can list: it has a name, it supports `standard:connect`, and it is a
 * Solana wallet (some `solana:` chain). Anything else is ignored, not an error.
 */
export function parseWallet(raw: unknown): DiscoveredWallet | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as RawWallet;
  if (typeof w.name !== "string" || w.name.trim() === "") return null;
  if (!Array.isArray(w.chains) || !w.chains.some((c) => typeof c === "string" && c.startsWith("solana:"))) {
    return null;
  }
  const connect = features(w)["standard:connect"] as { connect?: unknown } | undefined;
  if (!connect || typeof connect.connect !== "function") return null;
  return { name: w.name.trim().slice(0, 40), icon: safeIcon(w.icon), raw: w };
}

/**
 * Starts listening. `onChange` runs each time the list grows. Safe to call where there
 * is no window (returns an empty registry).
 */
export function watchWallets(
  target: EventTarget | null = typeof window === "undefined" ? null : window,
  onChange: (wallets: DiscoveredWallet[]) => void = () => {},
): WalletRegistry {
  const found: DiscoveredWallet[] = [];
  if (!target) return { list: () => [], stop: () => {} };

  const api = {
    register(...wallets: unknown[]) {
      let added = false;
      for (const raw of wallets) {
        const w = parseWallet(raw);
        if (w && !found.some((f) => f.raw === w.raw)) {
          found.push(w);
          added = true;
        }
      }
      if (added) onChange([...found]);
      return () => {};
    },
  };

  const onRegister = (event: Event) => {
    const callback = (event as CustomEvent).detail;
    if (typeof callback !== "function") return;
    try {
      callback(api);
    } catch {
      /* a misbehaving wallet must not break the page */
    }
  };
  target.addEventListener(REGISTER_WALLET, onRegister);
  try {
    target.dispatchEvent(new CustomEvent(APP_READY, { detail: api }));
  } catch {
    /* no CustomEvent: nothing to discover */
  }
  return {
    list: () => [...found],
    stop: () => target.removeEventListener(REGISTER_WALLET, onRegister),
  };
}

interface ConnectedAccount {
  address?: unknown;
  publicKey?: unknown;
}

/** The first account's Solana address out of a `standard:connect` answer, or null. */
export function firstSolanaAddress(result: unknown): string | null {
  const accounts = (result as { accounts?: unknown } | null)?.accounts;
  if (!Array.isArray(accounts)) return null;
  for (const a of accounts as ConnectedAccount[]) {
    if (typeof a?.address === "string" && checkSolanaAddress(a.address.trim()) === null) {
      return a.address.trim();
    }
    if (a?.publicKey instanceof Uint8Array && a.publicKey.length === 32) {
      return base58Encode(a.publicKey);
    }
  }
  return null;
}

export class WalletConnectError extends Error {}

/** Asks the wallet for its accounts and returns the first address. Read-only. */
export async function connectWallet(wallet: DiscoveredWallet): Promise<string> {
  const feature = features(wallet.raw)["standard:connect"] as {
    connect: () => Promise<unknown>;
  };
  let result: unknown;
  try {
    result = await feature.connect();
  } catch (err) {
    throw new WalletConnectError((err as Error)?.message || "The wallet did not connect.");
  }
  const address = firstSolanaAddress(result);
  if (address === null) throw new WalletConnectError("The wallet did not share an address.");
  return address;
}
