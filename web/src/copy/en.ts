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

/* ------------------------------------ the same gate, for a pasted t1 (M7) */

/**
 * The trust boundary again, in the words a transparent Zcash address needs.
 *
 * Pasting a `t1` leaves the shielded pool exactly as permanently as the Solana
 * exit does, and for a while it was the cheaper way to do it by accident: one
 * warning line directly above "Send it on", where the Solana card needs a screen
 * and a tick. The privacy loss decides the gate, not which card you came from,
 * so a `t1` now goes through the same component with these words.
 *
 * No swap service is involved here, so the second and third of the Solana
 * points do not apply; what replaces them is what a transparent output actually
 * costs — a public amount, a public address, a higher network fee, and a link
 * back to this envelope that anyone can follow.
 */
export const transparentBoundary = {
  title: "This address leaves the shielded pool",
  lede: "A transparent address is a public one. Read these before you send there; once the transaction is on-chain none of it can be taken back.",

  points: [
    {
      title: "The amount and the address become public",
      body: "A transparent output is written in the clear. Anyone can read how much arrived and where, for as long as Zcash exists. A shielded unified address starting with u1 discloses neither.",
    },
    {
      title: "It can be linked to everything that address does",
      body: "Every other payment that address has made or received is public too, so this one joins them. If that address is known to be yours — an exchange deposit, a published tip address — this envelope becomes yours in public as well.",
    },
    {
      title: "The envelope stops being private at this point",
      body: "The shielded side of the sweep hides where the money came from, and this output is where that ends: the transparent amount leaving the shielded pool is visible, and it is this one.",
    },
    {
      title: "It costs more and it cannot be undone",
      body: "A transparent destination adds a third action to the transaction, so the Zcash network fee is 0.00015 ZEC rather than 0.0001. There is no recall: a Zcash transaction is final once it is mined, and we could not reverse it even if we held the money, which we never do.",
    },
  ] as Step[],

  /** The required tick. Nothing continues until this is true. */
  checkbox: "I understand this address is public",
  blockedHint: "Tick the box above to continue.",
  continue: "Send to this transparent address",
  back: "Use a shielded address instead",
} as const;

/* ------------------------------------------------------- the Solana exit (M5) */

/**
 * The words on the Solana exit itself, after the trust boundary above has been
 * read and ticked.
 *
 * The trust boundary says what you give up. These say what it costs and who is
 * on the other side, in numbers the recipient can check against the quote on the
 * same screen. Four of them are not optional and are asserted by `en.test.ts`:
 * what the swap provider sees, the fee the rail hides inside its spread, the
 * minimum below which it will not trade, and the sentence that we are not the
 * swap provider and never hold the funds.
 *
 * The exit is never the headline. It is the third card of three, behind a
 * required tick, and every screen of it offers the way back to a shielded
 * destination.
 */
export const solanaExit = {
  cardTitle: "USDC or SOL on Solana",
  cardBody:
    "This leaves the shielded pool. A third-party swap rail does the exchange, we never hold the funds on either side, and you see every cost before you commit.",

  /* ------------------------------------------------------------- the asset */

  assetTitle: "What should arrive?",
  assetLede: "Both go to the same Solana address. The costs differ, and you will see them next.",
  usdcTitle: "USDC",
  usdcBody:
    "A dollar stablecoin on Solana. Steady in dollars, and the rail's flat withdrawal fee is a bigger slice of a small amount.",
  solTitle: "SOL",
  solBody:
    "Solana's own coin. Its price moves, and the rail's withdrawal fee is much smaller than USDC's.",

  /* --------------------------------------------------------- the destination */

  destinationTitle: "Where on Solana?",
  pasteTitle: "A Solana address",
  pasteBody: "Paste an address from Phantom, Solflare or any other Solana wallet.",
  pasteLabel: "Solana address",
  invalidCharset:
    "That is not a Solana address: it has a character no Solana address can contain. Check that you copied all of it and nothing else.",
  invalidLength:
    "That is not a Solana address. A Solana address is 32 to 44 characters and decodes to 32 bytes.",
  valid: "That is a valid Solana address. Check it against your wallet before you go on.",

  generateTitle: "A new Solana keypair in this browser",
  generateBody:
    "We make a fresh Solana key here and hand you the secret to keep. Nothing is stored and nothing is sent.",
  secretLabel: "Secret key",
  addressLabel: "Solana address",
  secretOnce:
    "This key is the money. It is shown here once, it is saved nowhere, and it is gone when this tab closes. Write it down or put it in a password manager now.",
  importHint:
    "To use it: install Phantom or Solflare, choose “Import private key”, and paste this key. It is the 64-byte base58 form both of them expect.",
  savedCheckbox: "I saved this key",
  savedBlockedHint: "Tick the box above once the key is somewhere safe.",

  /* ------------------------------------------------------------- the refund */

  refundTitle: "If the swap fails",
  /**
   * D14. The default refund address is the envelope's own address, which this
   * link can open again — so a refund is recoverable with nothing but the link.
   */
  refundDefault:
    "A failed swap sends the ZEC back to this envelope's own address, which means this link opens it again. You need nothing else for that to work.",
  refundOverrideLabel: "Send a refund somewhere else (optional)",
  refundOverrideHint:
    "A Zcash address of your own, if you would rather a refund went straight to you. A unified address starting with u1 keeps the refund shielded; a transparent t1 works too. Leave it empty to use the envelope.",
  refundFeeNote: (fee: string) =>
    `A refund costs ${fee} ZEC, which the swap service keeps.`,

  /* -------------------------------------------------------------- the quote */

  quoteTitle: "What you would get",
  quoteButton: "See what you would get",
  quoteBusy: "Asking the swap service…",
  amountOutLabel: "You would receive",
  spreadLabel: "Cost of leaving",
  timeLabel: "Usually takes",
  /** The 25 bps the rail folds into the price and does not display. Rule: we do. */
  feeLine:
    "Includes a 0.25% service fee to the swap provider. It is charged by the rail, it is not ours, and the rail does not show it.",
  spreadNote:
    "The cost of leaving is the whole difference between the dollar value going in and the dollar value arriving: the rail's rate, its Solana withdrawal fee and that service fee, in one number. The Zcash network fee is listed separately above.",
  /** Shown when the amount is under the rail's floor. The floor is read live. */
  minimum: (min: string) =>
    `The swap service will not trade less than ${min} ZEC, and this envelope is under that. Send it on as shielded ZEC instead, or to a Zcash address of your own.`,
  minimumLabel: "Swap service minimum",

  /** The four things the swap provider learns. Required by the audit test. */
  providerSeesTitle: "What the swap provider sees",
  providerSees:
    "The swap provider sees the amount of ZEC that arrives, the transparent Zcash address it arrives from, the Solana address it pays out to, and the network address of the browser that asked for the quote. It does not see this link, the secret in it, or anything else about the envelope.",
  notProvider:
    "Zenvelope is not the swap provider and never holds the funds. Your browser pays the address the rail quotes, and the rail pays you on Solana.",

  /* --------------------------------------------- the refund address, checked */

  refundChecking: "Checking that address…",
  refundOk: "This address can receive a refund.",
  /**
   * The override is free text and it decides who can recover the money if the
   * swap fails, so it goes through the same core classification every other
   * Zcash address in the product goes through (M4). The core's own reason is
   * shown after this sentence.
   */
  refundInvalid:
    "A refund could not be sent to that address, so the quote is blocked until it is fixed or the box is emptied.",

  /* ------------------------------------------ the quote, before it is accepted */

  /** The cap on the cost of leaving, above which the deposit step is refused. */
  spreadTooHigh: (spread: string, cap: string) =>
    `The cost of leaving this quote is ${spread}, which is above the ${cap} we will go ahead with. Send it on as shielded ZEC instead, or try again later: the rate moves.`,
  /** The rail sent something the spread cannot be computed from. */
  quoteUnreadable:
    "The swap service did not send figures we can check this quote against, so we will not go on with it.",
  /** `amountOut` under the rail's own `minAmountOut`. */
  quoteShortfall:
    "The swap service quoted less than the minimum it says it would pay out, so we will not go on with it.",

  /* -------------------------------------- the deposit address, before it is paid */

  /**
   * The rail hands back an address our own core then classifies. Anything but a
   * transparent address of this network is refused: the sweep would be paying a
   * stranger's address on our recipient's behalf (M6).
   */
  depositNotTransparent:
    "The swap service sent a deposit address that is not a transparent Zcash address on this network. Nothing was sent, and nothing will be.",
  /** The echoed request did not match what we asked for. */
  depositMismatch: (field: string) =>
    `The swap service answered with a different ${field} from the one we asked for. Nothing was sent, and nothing will be.`,
  depositRetry: "Start the swap again",

  /* ------------------------------------------------------ the deposit address */

  depositTitle: "The swap is set up",
  depositLede:
    "The swap service has given us a one-time transparent Zcash address for this swap. The next step pays it out of the envelope, from your browser.",
  depositLabel: "Deposit address",
  depositNoMemo: "No memo and no tag: the address alone identifies this swap.",
  deadlineLabel: "Good until",
  deadlineNote:
    "The address is watched until then. After that a payment to it is refunded rather than swapped.",
  depositContinue: "Send the ZEC",

  /* --------------------------------------------------------- after the sweep */

  trackingTitle: "Watching the swap",
  trackingLede:
    "The ZEC is on its way to the swap service. This page asks it where things stand every 20 seconds. You can close the tab: the swap carries on without it.",
  solanaTxLabel: "Solana transaction",
  trackingLost:
    "We could not reach the swap service just now. It keeps working either way, and this page will try again.",

  /* ------------------------------------------------------------- the dry run */

  dryRunTitle: "Dry run complete.",
  dryRunLine: "Dry run: deposit address obtained, transaction built, nothing sent",
  dryRunNote:
    "The quote and the deposit address are real and the transaction was really built and proved. Nothing was handed to the Zcash network, so the money is still in the envelope and this link still works.",

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
    /** What the person who opens that link receives. The CSV's `envelope_zec`. */
    envelope: "In the envelope",
    /** Envelope plus the flat service fee: the URI's amount, and `send_zec`. */
    send: "To send",
    link: "Link",
    address: "Address",
    uri: "Payment URI",
  },
  /** Said under the table, because two amount columns need one line of explanation. */
  columnsNote:
    "“In the envelope” is what the person who opens that link receives. “To send” is that plus the flat service fee, and it is the amount the payment URI asks your wallet for.",
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
/* ------------------------------------------- open page: already opened (/e) */

/**
 * What the open page says when the scan found the envelope's notes but saw them
 * spent on chain. Without this the page would show the money, take a
 * destination, prove for half a minute, and only then fail at broadcast.
 */
export const alreadyOpened = {
  title: "This envelope was already opened",
  lede: "Someone with this link already moved the money on, so there is nothing left in it to send.",
  /** Height and date of the block the sweep was mined in. */
  when: (height: string, date: string | null) =>
    date ? `Opened in block ${height}, on ${date}.` : `Opened in block ${height}.`,
  txLabel: "Moved on in",
  explorerLink: `See it on ${EXPLORER_NAME}`,
  received: (zec: string) => `It held ${zec}.`,
  notYou:
    "If that was not you, someone else who has this link got there first. The link is the money: whoever holds it can open the envelope, and a spend on chain cannot be undone.",
  /** Shown on the normal open screen when only some of the notes were already moved on. */
  partial: (spentZec: string) =>
    `Another ${spentZec} was sent to this envelope and has already been moved on. It is not counted above.`,
};

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
  walk({
    landing,
    footer,
    how,
    trustBoundary,
    transparentBoundary,
    solanaExit,
    group,
    single,
    alreadyOpened,
    NEVER_ASK,
    ONLY_ASK,
  });
  return out;
}
