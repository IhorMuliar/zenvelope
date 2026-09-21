/**
 * Every user-facing string on the pages Zenvelope's sender side owns: the
 * landing page, `/how`, the group-envelope preview and the trust-boundary
 * screen. One file, so the drainer-safety rules can be read in one sitting and
 * enforced mechanically by `en.test.ts`.
 *
 * A Zenvelope link is a bearer link that arrives over a messaging app, which is
 * exactly the shape of a wallet-drainer lure. The copy is therefore written
 * against four rules:
 *
 *   1. **Never the word "claim".** It is the top drainer lure, so it is banned
 *      outright, in every tense and every compound. We say open, receive,
 *      unwrap (docs/PRODUCT.md, "Copy rules").
 *   2. **Never ask for a wallet connection or a seed phrase.** No screen we
 *      own offers to connect a wallet, and no screen asks anyone to type a seed
 *      phrase. The only place funds move is the open page, and the only thing
 *      it asks for is a destination.
 *   3. **Say so out loud.** The landing page and `/how` both carry
 *      {@link NEVER_ASK} verbatim, so a recipient who has been trained by a
 *      drainer has a sentence to compare against.
 *   4. **Teach the check, not the trust.** `/how` explains how to verify the
 *      link without taking our word for anything: the host in the URL bar, the
 *      fragment that never leaves the browser, the source, and the address on a
 *      block explorer.
 *
 * Strings live here and not inline in the components so that the audit is a
 * test over this module's exports rather than a grep over JSX.
 */

import { EXPLORER_NAME, SENDER_WALLETS, TAGLINE } from "../config";

/** The repository every "read the code" line points at. */
export const REPO_URL = "https://github.com/IhorMuliar/zenvelope";

/** The host a real Zenvelope link is served from, for the "check the URL" line. */
export const CANONICAL_HOST_HINT =
  "the host you were told to expect, and nothing else in front of the first /";

/**
 * The sentence, verbatim, on both the landing page and `/how`. Rule 3.
 *
 * It is a promise about behaviour, not a feature: there is nowhere in the
 * product that could ask for any of these three things, because the app has no
 * wallet-connect code path and never accepts key material typed by a person.
 */
export const NEVER_ASK =
  "We will never ask for your seed phrase, your wallet password, or a wallet connection.";

/** The one thing the open page does ask for, said plainly next to NEVER_ASK. */
export const ONLY_ASK =
  "Opening an envelope asks you for one thing: where the money should go. That is a Zcash address you paste, or a wallet this page makes for you in the browser.";

/* --------------------------------------------------------------- landing (/) */

export interface Step {
  title: string;
  body: string;
}

export const landing = {
  headline: TAGLINE,

  /** How it works, in one paragraph. Rule 4 in miniature: no trust asked for. */
  howInOneParagraph:
    "Your browser makes a secret and puts it in the part of a link after the #, which browsers never send to any server. That secret derives a one-time shielded Zcash address, and you pay it from your own wallet. Whoever opens the link uses the same secret, in their own browser, to find the payment and move it wherever they want. The amount is not in the link, so a link on its own tells nobody anything.",

  neverHoldTitle: "We never hold funds",
  neverHoldLede: "Three places the money can be. None of them is us.",

  /** The three-step strip. Sender's wallet, the link's address, the recipient. */
  neverHoldSteps: [
    {
      title: "Your wallet",
      body: "You send the payment yourself, from your own shielded balance, straight to the envelope's address. We never touch it.",
    },
    {
      title: "The link's address, on-chain",
      body: "The money waits in a one-time shielded Zcash address derived from the link. No account of ours, no balance of ours, nothing for us to freeze.",
    },
    {
      title: "Their browser",
      body: "The recipient's browser holds the secret, finds the note and signs the transaction that moves it out. The money goes chain to chain, never through us.",
    },
  ] as Step[],

  formTitle: "Make an envelope",
  amountLabel: "Amount per envelope, in ZEC",
  amountHint: "Minimum 0.0001 ZEC. Up to 8 decimal places.",
  countLabel: "Number of envelopes",
  countHint: "1 to 50. More than one makes a link for each, with the same amount.",
  messageLabel: "Message to the recipient (encrypted on-chain, revealed when opened)",
  messagePlaceholder: "Happy birthday",
  submit: "Create envelope",
  submitMany: "Create envelopes",
  submitBusy: "Creating…",

  neverAsk: NEVER_ASK,
  secretFine:
    "The secret is generated in your browser and lives in the link only. We never see it, and we cannot open, freeze or refund an envelope.",
} as const;

/* ------------------------------------------------------------------ footer */

export const footer = {
  sourceLabel: "Open source, MIT",
  sourceUrl: REPO_URL,
  built: "Built for the Colosseum Crypto World's Fair 2026, Zcash track.",
  /** Stated as a fact, because it is one: there is no analytics code and no cookie. */
  noTracking: "No analytics. No cookies.",
} as const;

/* -------------------------------------------------------------------- /how */

export const how = {
  title: "We never hold funds",
  lede: "Five steps, and none of them is us holding your money.",

  steps: [
    {
      title: "Your browser makes a secret",
      body: "32 random bytes from your browser's own generator. It becomes the part of the link after the #, which browsers never send to any server. We never see it.",
    },
    {
      title: "The secret becomes a one-time shielded address",
      body: "The same secret derives the address, the viewing key and the spending key. No account, no registration, nothing of yours on our side.",
    },
    {
      title: "You pay that address from your own wallet",
      body: `We show a payment URI and a QR for the envelope amount plus the flat service fee. Your wallet sends it directly on-chain. Works with ${SENDER_WALLETS}.`,
    },
    {
      title: "You send the link, they open it in a browser",
      body: "The recipient's browser uses the viewing key to find the note and reveal the amount. No wallet, no install, no address to exchange.",
    },
    {
      title: "They move the money where they want it",
      body: "Their browser signs with the spending key and sends the funds to a Zcash address they choose. The service fee rides along in that transaction. The money never passes through us.",
    },
  ] as Step[],

  fine: "Our server is static HTML, JavaScript and WASM. No keys, no float, no custody. If this site disappeared, an unopened envelope would still be spendable by whoever holds the link, using the open-source code.",

  /* ------------------------------------------------ "Is this link safe?" */

  safeTitle: "Is this link safe?",
  safeLede:
    "A link that carries money is the exact shape of a scam, and you should not take our word for anything. Here is how to check this one yourself, in about a minute.",

  safeChecks: [
    {
      title: "Read the host in the URL bar",
      body: `Everything before the first single / is the host. It has to be ${CANONICAL_HOST_HINT} — a look-alike spelling, an extra word before the dot, or a different ending is a different site. The part after the # is never something you need to read, and never something you should retype somewhere else.`,
    },
    {
      title: "The secret after the # never leaves your browser",
      body: "Browsers do not send the fragment — the part after the # — to any server. Ours never sees it, never logs it, and could not hand it over if asked. You can watch that yourself: open your browser's network panel before you open the envelope and check that the secret appears in no request.",
    },
    {
      title: "Read the code that runs on you",
      body: `The whole app is open source under MIT, including the page you are on. Compare what it does with what we say it does: ${REPO_URL}. There is no backend to audit, because there is no backend.`,
    },
    {
      title: "Check the address on a block explorer",
      body: `An envelope's address and the transaction that funded it are ordinary public Zcash data. Paste the transaction id into ${EXPLORER_NAME} and see it on the chain, independently of us. The amount stays hidden there: it is shielded, and only the person holding the link can decrypt it.`,
    },
  ] as Step[],

  neverAsk: NEVER_ASK,
  onlyAsk: ONLY_ASK,
  neverAskFine:
    "Any page that asks you for more than a destination address is not this one, however much it looks like it. Close it and start again from a link you trust.",

  createCta: "Create an envelope",
} as const;

/* ------------------------------------------------------- trust boundary (M5) */

/**
 * Shown before a Solana exit, and before nothing else. Leaving the shielded pool
 * is the one irreversible privacy decision in the product, so it gets a screen
 * of its own, written to be read rather than clicked past: four things you give
 * up, and a checkbox that is the only way past them.
 */
export const trustBoundary = {
  title: "This leaves the shielded pool",
  lede: "Taking the money out on Solana is not a shielded payment. Read these four before you choose it; they cannot be undone afterwards.",

  points: [
    {
      title: "The amount and the destination become public",
      body: "Solana has no shielded pool. The amount that arrives and the address it arrives at are written in public, permanently, and can be linked to everything else that address ever does. Shielded ZEC discloses neither.",
    },
    {
      title: "A third-party swap service sees the transaction",
      body: "The ZEC leaves Zcash through a swap service that is not us and that we do not control. It sees the amount, the Solana address it pays out to, and the network address of the machine that asked. What it keeps, and for how long, is its business and its terms, not ours.",
    },
    {
      title: "A spread and fees apply",
      body: "You do not get the market price. The service takes a spread, plus its own fees, plus the Zcash and the Solana network fees, and there is a minimum below which the swap is not worth doing. Every one of those numbers is shown to you before you commit, and what you see is what arrives.",
    },
    {
      title: "Zenvelope is not the swap provider and never holds the funds",
      body: "We do not run the swap, we do not set the rate, and we do not take custody at any point. Your browser sends the ZEC straight to the address the service quotes, and the service pays out to you. If it goes wrong, it went wrong between you and them, and we have nothing to refund because we never had the money.",
    },
  ] as Step[],

  /** The required tick. Nothing continues until this is true. */
  checkbox: "I understand this leaves the shielded pool",
  /** Shown next to the disabled button, so the block is explained, not just felt. */
  blockedHint: "Tick the box above to continue.",
  continue: "Continue",
  back: "Keep it shielded instead",
} as const;

/* -------------------------------------------- group envelopes (M6 preview) */

export const group = {
  title: "Your envelopes are ready",
  lede: (n: number, each: string) =>
    `${n} links, ${each} ZEC to send for each. Every one is a separate envelope with its own secret and its own address.`,
  tableCaption: "One row per envelope. Each payment URI is a single ZIP-321 output.",
  scrollHint: "Scroll the table sideways, or download the CSV and pay from a wallet that takes a batch.",
  download: "Download CSV",
  columns: {
    index: "#",
    amount: "Amount to send",
    link: "Link",
    address: "Address",
    uri: "Payment URI",
  },
  warn: "Each link is the money. Anyone holding one can open that envelope, so treat the CSV like cash and send each link to one person only.",
  memoryFine:
    "These links exist in this tab and in the CSV you download. They are not stored, not sent anywhere, and not recoverable: leave this page without saving them and the money stays in the envelopes with nobody able to open them.",
  total: (total: string, n: number, each: string) =>
    `You will send ${total} ZEC in total: ${n} payments of ${each} ZEC.`,
  again: "Create more envelopes",
  previewBadge: "Group envelopes are a preview of M6. The links and URIs are real; batch funding from one wallet is not built yet.",
} as const;

/* ------------------------------------------------------------------ singles */

export const single = {
  title: "Your envelope is ready",
  keepTitle: "1. Keep this link",
  keepWarn: "Anyone with this link can open the envelope. We never see it.",
  fundTitle: "2. Fund it from a shielded balance",
  fundWarn: "Send exactly this amount from a shielded balance.",
  sendTitle: "3. Send the link",
  sendBody:
    "Once the payment confirms, whoever opens the link unwraps the envelope in their browser and moves the money where they want it.",
  again: "Create another envelope",
} as const;

/**
 * Every plain string this module exports, flattened, so the audit test can read
 * the copy without knowing the shape of it. Functions are called with sample
 * arguments, because a template is copy too.
 */
export function allStrings(): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === "function") {
      try {
        walk((v as (...a: unknown[]) => unknown)(3, "0.0103", "0.0309"));
      } catch {
        /* a template that needs other arguments is covered by its own test */
      }
    } else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk({ landing, footer, how, trustBoundary, group, single, NEVER_ASK, ONLY_ASK });
  return out;
}
