import { describe, expect, it } from "vitest";
import {
  APP_READY,
  REGISTER_WALLET,
  WalletConnectError,
  connectWallet,
  firstSolanaAddress,
  parseWallet,
  safeIcon,
  watchWallets,
} from "./walletStandard";
import { base58Decode } from "./solana";

const ADDRESS = "9XgwdBnkmJzRyQhM3bAkYqekuG9u2w9eJfjCe2T3HyrS";
const ICON = "data:image/svg+xml;base64,PHN2Zy8+";

function wallet(over: Record<string, unknown> = {}, connect: unknown = async () => ({ accounts: [{ address: ADDRESS }] })) {
  return {
    name: "Phantom",
    icon: ICON,
    chains: ["solana:mainnet", "solana:devnet"],
    features: { "standard:connect": { connect }, "solana:signTransaction": { signTransaction: () => {} } },
    ...over,
  };
}

describe("parseWallet", () => {
  it("keeps name and a data-URI icon", () => {
    expect(parseWallet(wallet())).toMatchObject({ name: "Phantom", icon: ICON });
  });
  it("drops an icon that is not a data image (the CSP would refuse it anyway)", () => {
    expect(safeIcon("https://evil.example/x.png")).toBe("");
    expect(safeIcon("data:text/html;base64,AAAA")).toBe("");
    expect(parseWallet(wallet({ icon: "https://x/y.png" }))?.icon).toBe("");
  });
  it("ignores wallets that are not Solana wallets or cannot connect", () => {
    expect(parseWallet(wallet({ chains: ["eip155:1"] }))).toBeNull();
    expect(parseWallet(wallet({ features: {} }))).toBeNull();
    expect(parseWallet(wallet({ name: "" }))).toBeNull();
    expect(parseWallet(null)).toBeNull();
    expect(parseWallet("phantom")).toBeNull();
  });
});

describe("discovery over the two window events", () => {
  it("finds a wallet that registered before the page asked, and one that comes later", () => {
    const target = new EventTarget();
    const early = wallet({ name: "Early" });
    // A wallet that loaded first listens for app-ready and registers itself.
    target.addEventListener(APP_READY, (e) => (e as CustomEvent).detail.register(early));
    const seen: string[][] = [];
    const reg = watchWallets(target, (w) => seen.push(w.map((x) => x.name)));
    expect(reg.list().map((w) => w.name)).toEqual(["Early"]);

    // A wallet that loads later announces itself with a callback.
    const later = wallet({ name: "Late" });
    target.dispatchEvent(new CustomEvent(REGISTER_WALLET, { detail: (api: { register(w: unknown): void }) => api.register(later) }));
    expect(reg.list().map((w) => w.name)).toEqual(["Early", "Late"]);
    expect(seen.at(-1)).toEqual(["Early", "Late"]);

    // The same wallet twice is listed once.
    target.dispatchEvent(new CustomEvent(REGISTER_WALLET, { detail: (api: { register(w: unknown): void }) => api.register(later) }));
    expect(reg.list()).toHaveLength(2);
    reg.stop();
  });

  it("finds nothing when no wallet is installed (iOS Safari), and survives a bad detail", () => {
    const target = new EventTarget();
    const reg = watchWallets(target);
    target.dispatchEvent(new CustomEvent(REGISTER_WALLET, { detail: "not a function" }));
    target.dispatchEvent(new CustomEvent(REGISTER_WALLET, { detail: () => { throw new Error("boom"); } }));
    expect(reg.list()).toEqual([]);
  });

  it("works with no window at all", () => {
    expect(watchWallets(null).list()).toEqual([]);
  });
});

describe("connecting reads one address and nothing else", () => {
  it("takes the first account's address", async () => {
    const w = parseWallet(wallet())!;
    expect(await connectWallet(w)).toBe(ADDRESS);
  });
  it("falls back to the public key bytes", () => {
    expect(firstSolanaAddress({ accounts: [{ publicKey: base58Decode(ADDRESS) }] })).toBe(ADDRESS);
  });
  it("skips an account whose address is not Solana-shaped", () => {
    expect(firstSolanaAddress({ accounts: [{ address: "0xabc" }, { address: ADDRESS }] })).toBe(ADDRESS);
    expect(firstSolanaAddress({ accounts: [] })).toBeNull();
    expect(firstSolanaAddress(undefined)).toBeNull();
  });
  it("turns a rejection or an empty answer into a WalletConnectError", async () => {
    await expect(connectWallet(parseWallet(wallet({}, async () => { throw new Error("User rejected"); }))!)).rejects.toThrow("User rejected");
    await expect(connectWallet(parseWallet(wallet({}, async () => ({ accounts: [] })))!)).rejects.toBeInstanceOf(WalletConnectError);
  });
  it("never calls a signing feature", async () => {
    let signed = false;
    const w = wallet();
    (w.features["solana:signTransaction"] as { signTransaction: () => void }).signTransaction = () => { signed = true; };
    await connectWallet(parseWallet(w)!);
    expect(signed).toBe(false);
  });
});
