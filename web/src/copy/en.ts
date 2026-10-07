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

import { EXPLORER_NAME, SENDER_WALLETS } from "../config";

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
  "To open an envelope, we ask one thing: where the money should go. You paste an address, or this page makes a wallet for you.";

/* --------------------------------------------------------------- landing (/) */

export interface Step {
  title: string;
  body: string;
}

export const landing = {
  /** One headline. The longer tagline stays in the page's meta description. */
  headline: "Send shielded ZEC as a link",
  /** One short line under it. Under 20 words, and it is about the recipient. */
  subline: "They open it in any browser. No app or wallet needed.",

  amountLabel: "Amount",
  amountUnit: "ZEC",
  amountHint: "Minimum 0.0001 ZEC.",
  /** Quick picks under the amount. */
  presets: ["0.01", "0.05", "0.1", "0.5"],
  messageLabel: "Message (optional)",
  messagePlaceholder: "Happy birthday",
  fromLabel: "From (optional)",
  fromPlaceholder: "Your name",
  /** Under the message and name, with the live byte count. */
  memoHint: (used: number, max: number) =>
    `Only the person who opens it can read this. ${used}/${max} bytes.`,
  memoTooLong: (used: number, max: number) =>
    `Message and name are too long: ${used} of ${max} bytes.`,

  /** Group mode sits behind this, so the common case is one simple form. */
  groupAsk: "Sending to several people?",
  groupLink: "Make several links",
  groupHide: "Just one link",
  countLabel: "Number of links",
  countHint: "1 to 50. Each link is its own envelope, with the same amount.",

  submit: "Create envelope",
  submitMany: "Create envelopes",
  submitBusy: "Creating…",

  howTitle: "How it works",
  /** The three-step strip under the form. */
  howSteps: [
    "You pay from your Zcash wallet.",
    "You send the link in any chat.",
    "They open it and choose where the money goes.",
  ],
  howMore: "More about how it works",

  safeTitle: "Safe by design",
  safeLine:
    "We never hold your money. The secret lives in the link. The code is open source.",
  neverAsk: NEVER_ASK,
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
  title: "We never hold your money",
  lede: "Five steps. None of them puts your money with us.",

  /** How it works, in one paragraph. Rule 4 in miniature: no trust asked for. */
  inOneParagraph:
    "Your browser makes a secret and puts it after the # in the link, a part browsers never send to any server. The secret gives a one-time shielded Zcash address, and you pay it from your own wallet. Whoever opens the link uses the same secret, in their own browser, to find the payment and send it where they want. The amount is not in the link, so the link alone tells a stranger nothing.",

  neverHoldTitle: "Where the money is",
  neverHoldLede: "The money is always in one of three places. None of them is ours.",

  /** The three-step strip. Sender's wallet, the link's address, the recipient. */
  neverHoldSteps: [
    {
      title: "Your wallet",
      body: "You pay from your own shielded balance, straight to the envelope's address. We never touch it.",
    },
    {
      title: "The link's address, on-chain",
      body: "The money waits at a one-time shielded Zcash address made from the link. We have no account there and nothing to freeze.",
    },
    {
      title: "Their browser",
      body: "Their browser holds the secret, finds the payment and signs the transaction that moves it out. The money stays on-chain and never passes through us.",
    },
  ] as Step[],

  stepsTitle: "Step by step",

  steps: [
    {
      title: "Your browser makes a secret",
      body: "32 random bytes from your browser's own generator. They go after the # in the link, a part browsers never send to any server. We never see it.",
    },
    {
      title: "The secret becomes a one-time shielded address",
      body: "The same secret gives the address, the viewing key and the spending key. No account and no sign-up. Nothing of yours is stored with us.",
    },
    {
      title: "You pay that address from your own wallet",
      body: `We show a payment request and a QR code for the amount plus our flat service fee. Your wallet sends it straight on-chain. Works with ${SENDER_WALLETS}.`,
    },
    {
      title: "You send the link, they open it in a browser",
      body: "Their browser uses the viewing key to find the payment and show the amount. They install nothing and need no wallet or address.",
    },
    {
      title: "They move the money where they want it",
      body: "Their browser signs with the spending key and sends the money to the address they choose. Our service fee goes out in the same transaction. The money never passes through us.",
    },
  ] as Step[],

  fine: "This site is static files: HTML, JavaScript and WASM. We hold no keys and no money. If the site went away, whoever holds a link could still open its envelope with the open-source code.",

  /* ------------------------------------------------ "Is this link safe?" */

  safeTitle: "Is this link safe?",
  safeLede:
    "A link that carries money looks exactly like a scam, so do not take our word for it. Here is how to check this one yourself. It takes about a minute.",

  safeChecks: [
    {
      title: "Read the host in the URL bar",
      body: `The host is everything before the first single /. It must be ${CANONICAL_HOST_HINT}. A look-alike spelling, an extra word before the dot or a different ending means a different site. You never need to read the part after the #, and you should never retype it anywhere.`,
    },
    {
      title: "The secret after the # never leaves your browser",
      body: "Browsers do not send the part after the # to any server. Ours never sees it, never logs it and could not hand it over if asked. To check, open your browser's network panel before you open the envelope. The secret appears in no request.",
    },
    {
      title: "Read the code that runs here",
      body: `The whole app is open source under MIT, this page included. Compare what it does with what we say: ${REPO_URL}. There is no backend to audit, because there is no backend.`,
    },
    {
      title: "Check the address on a block explorer",
      body: `An envelope's address and the payment into it are public Zcash data. Paste the transaction ID into ${EXPLORER_NAME} to see it on the chain without us. The amount stays hidden there. It is shielded, and only someone with the link can read it.`,
    },
  ] as Step[],

  neverAsk: NEVER_ASK,
  onlyAsk: ONLY_ASK,
  neverAskFine:
    "A page that asks for more than an address to send to is not this one, however real it looks. Close it and start again from a link you trust.",

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
  lede: "Taking the money out on Solana is not private. Read these four points first. They cannot be undone later.",

  points: [
    {
      title: "The amount and the destination become public",
      body: "Solana has no shielded pool. The amount and the address it lands at are public forever. They can be linked to everything else that address does. Shielded ZEC shows neither.",
    },
    {
      title: "A third-party swap service sees the transaction",
      body: "The ZEC leaves Zcash through a swap service we do not run or control. It sees the amount, the Solana address it pays out to, and the network address of the device that asked. What it keeps, and for how long, is set by its terms, not ours.",
    },
    {
      title: "A spread and fees apply",
      body: "You do not get the market price. The service takes a spread and its own fees, and the Zcash and Solana networks charge fees too. Below a minimum amount, the swap will not run. You see every number before you commit, and what you see is what arrives.",
    },
    {
      title: "Zenvelope is not the swap provider and never holds the funds",
      body: "We do not run the swap or set the rate, and we never hold the money. Your browser sends the ZEC straight to the address the service gives, and the service pays you. If something goes wrong, it is between you and them. We have nothing to refund, because we never had the money.",
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
 * costs: a public amount, a public address, a higher network fee, and a link
 * back to this envelope that anyone can follow.
 */
export const transparentBoundary = {
  title: "This address leaves the shielded pool",
  lede: "A transparent address is public. Read these before you send. Once the payment is on-chain, none of it can be undone.",

  points: [
    {
      title: "The amount and the address become public",
      body: "A payment to this address is written in the clear. Anyone can see how much arrived and where, for as long as Zcash exists. A shielded address starting with u1 shows neither.",
    },
    {
      title: "It can be linked to everything that address does",
      body: "Every other payment to or from that address is public too, and this one joins them. If the address is known to be yours, like an exchange deposit or a public tip address, this envelope becomes publicly yours too.",
    },
    {
      title: "The envelope stops being private at this point",
      body: "The shielded part of the transfer hides where the money came from. This payment is where that ends. The amount leaving the shielded pool is visible, and it is this one.",
    },
    {
      title: "It costs more and it cannot be undone",
      body: "A transparent address adds a step to the transaction, so the Zcash network fee is 0.00015 ZEC instead of 0.0001. There is no recall. A Zcash payment is final once it is in a block. We could not reverse it even if we held the money, and we never do.",
    },
  ] as Step[],

  /** The required tick. Nothing continues until this is true. */
  checkbox: "I understand this address is public",
  blockedHint: "Tick the box above to continue.",
  continue: "Send to this transparent address",
  back: "Use a shielded address instead",
} as const;

/* ---------------------------------- the same gate, for an exchange deposit */

/**
 * The transparent gate again, in the words someone sending to their own
 * exchange account needs. The gate is the same component and the same tick:
 * the deposit really is public. What changes is the framing, because for an
 * exchange deposit that is normal and expected, not a mistake to warn off.
 */
export const exchangeBoundary = {
  title: "Exchange deposits are public",
  lede: "Your exchange gets this like any other deposit. Read these before you send. A sent payment cannot be taken back.",

  points: [
    {
      title: "The amount and the address are visible on-chain",
      body: "Most exchange deposit addresses are transparent. Anyone can see how much arrived and where. That is normal for exchange deposits.",
    },
    {
      title: "Your exchange links it to your account",
      body: "The exchange knows this deposit is yours, like every deposit you make.",
    },
    {
      title: "The network fee is a little higher",
      body: "Sending to this kind of address costs 0.00015 ZEC in network fees, not 0.0001 ZEC.",
    },
    {
      title: "Check the address, then it is final",
      body: "Copy the address straight from your exchange's ZEC deposit page. Once the payment is on-chain, it cannot be reversed, by you or by us.",
    },
  ] as Step[],

  checkbox: "I understand this deposit is public",
  blockedHint: "Tick the box above to continue.",
  continue: "Continue",
  back: "Choose somewhere else",
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
 * The exit is never the headline. It is one card of four, behind a required
 * tick, and every screen of it offers the way back to a shielded destination.
 */
export const solanaExit = {
  cardTitle: "USDC in my Solana wallet",
  cardHint: "Phantom, Solflare and other Solana wallets.",
  cardBody:
    "A swap service changes it into USDC. This leaves the shielded pool. We never hold the money.",
  /** The numbers on the card itself, so the option never says only "fees apply". */
  cardNumbers: (zecIn: string, zcashFees: string) =>
    `${zecIn} goes into the swap after ${zcashFees} of Zcash fees. You see the exact USDC amount and the swap's cost before anything is sent.`,
  /** The Zcash side of the cost, as its own row on the quote. */
  zcashFeesLabel: "Zcash fees, already taken off",

  /* ------------------------------------------------------------- the asset */

  assetTitle: "What should arrive?",
  assetLede: "Both go to the same Solana address. The costs differ. You see them on the next screen.",
  usdcTitle: "USDC",
  usdcBody:
    "A dollar stablecoin on Solana. It holds its dollar value, but its flat withdrawal fee takes a bigger share of a small amount.",
  solTitle: "SOL",
  solBody:
    "Solana's own coin. Its price moves, and its withdrawal fee is much smaller than USDC's.",

  /* --------------------------------------------------------- the destination */

  destinationTitle: "Where on Solana?",
  pasteTitle: "A Solana address",
  pasteBody: "Paste an address from Phantom, Solflare or any Solana wallet.",
  pasteLabel: "Solana address",
  invalidCharset:
    "That is not a Solana address: it has a character no Solana address can contain. Check that you copied all of it and nothing else.",
  invalidLength:
    "That is not a Solana address. A Solana address is 32 to 44 characters and decodes to 32 bytes.",
  valid: "That is a valid Solana address. Check it against your wallet before you go on.",

  generateTitle: "A new Solana wallet, made here",
  generateBody:
    "This page makes a new Solana key and gives you the secret to keep. Nothing is stored and nothing is sent.",
  secretLabel: "Secret key",
  addressLabel: "Solana address",
  secretOnce:
    "This key is the money. It is shown once, saved nowhere, and gone when you close this tab. Write it down or put it in a password manager now.",
  importHint:
    "To use it, install Phantom or Solflare, choose “Import private key” and paste this key. It is in the 64-byte base58 format both apps expect.",
  savedCheckbox: "I saved this key",
  savedBlockedHint: "Tick the box above once the key is somewhere safe.",

  /* ------------------------------------------------------------- the refund */

  refundTitle: "If the swap fails",
  /**
   * D14. The default refund address is the envelope's own address, which this
   * link can open again, so a refund is recoverable with nothing but the link.
   */
  refundDefault:
    "If the swap fails, the ZEC goes back to this envelope's own address, and this link opens it again. You need nothing else.",
  refundOverrideLabel: "Send a refund somewhere else (optional)",
  refundOverrideHint:
    "Your own Zcash address, if you want a refund to come straight to you. An address starting with u1 keeps it shielded. One starting with t1 works too. Leave it empty to use the envelope.",
  refundFeeNote: (fee: string) =>
    `A refund costs ${fee} ZEC, which the swap service keeps.`,

  /* -------------------------------------------------------------- the quote */

  quoteTitle: "What you would get",
  quoteButton: "See what you would get",
  quoteBusy: "Asking the swap service…",
  amountOutLabel: "You would receive",
  /** On the tracker: what the quote promised. */
  quotedLabel: "Quoted",
  /** On the tracker after SUCCESS: what the rail says it actually paid out. */
  receivedLabel: "Received",
  spreadLabel: "Cost of leaving",
  timeLabel: "Usually takes",
  /**
   * The rail's service fee, summed from the quote's `appFees` in basis points.
   * The rail folds it into the price and does not display it. Rule: we do. When
   * the quote does not carry the field, we say it may be there.
   */
  feeLine: (bps: number | null): string =>
    bps === null || !Number.isFinite(bps)
      ? "The swap provider may charge a service fee included in the quote."
      : `The quote includes a ${(bps / 100).toFixed(2)}% service fee to the swap provider. That fee is theirs, not ours, and their quote does not show it.`,
  spreadNote:
    "The cost of leaving is the full gap between the dollar value going in and the dollar value arriving. It covers the swap rate, the Solana withdrawal fee and any service fee. The Zcash network fee is listed above.",
  /** Shown when the amount is under the rail's floor. The floor is read live. */
  minimum: (min: string) =>
    `The swap service will not trade less than ${min} ZEC, and this envelope holds less. Send it on as shielded ZEC instead, to a Zcash address of your own.`,
  minimumLabel: "Swap service minimum",

  /** The four things the swap provider learns. Required by the audit test. */
  providerSeesTitle: "What the swap provider sees",
  providerSees:
    "The swap provider sees the amount of ZEC that arrives, the transparent Zcash address it comes from, the Solana address it pays out to, and the network address of the browser that asked for the quote. It does not see this link, the secret in it or anything else about the envelope.",
  notProvider:
    "Zenvelope is not the swap provider and never holds the funds. Your browser pays the address the provider gives, and the provider pays you on Solana.",

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
    "A refund could not be sent to that address. Fix it or empty the box to get a quote.",

  /* ------------------------------------------ the quote, before it is accepted */

  /** The cap on the cost of leaving, above which the deposit step is refused. */
  spreadTooHigh: (spread: string, cap: string) =>
    `The cost of leaving on this quote is ${spread}, above our ${cap} limit. Send it on as shielded ZEC instead, or try again later. The rate moves.`,
  /** The rail sent something the spread cannot be computed from. */
  quoteUnreadable:
    "The swap service did not send figures we can check, so we will not go on with this quote.",
  /** `amountOut` under the rail's own `minAmountOut`. */
  quoteShortfall:
    "The swap service quoted less than its own minimum payout, so we will not go on with this quote.",

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
    `The swap service answered with a different ${field} than we asked for. Nothing was sent, and nothing will be.`,
  depositRetry: "Start the swap again",

  /* ------------------------------------------------------ the deposit address */

  depositTitle: "The swap is set up",
  depositLede:
    "The swap service gave a one-time transparent Zcash address for this swap. Next, your browser pays it from the envelope.",
  depositLabel: "Deposit address",
  depositNoMemo: "No memo or tag needed. The address alone identifies this swap.",
  deadlineLabel: "Good until",
  deadlineNote:
    "The address is watched until then. A payment after that is refunded, not swapped.",
  depositContinue: "Send the ZEC",

  /* --------------------------------------------------------- after the sweep */

  trackingTitle: "Watching the swap",
  trackingLede:
    "The ZEC is on its way to the swap service. This page checks on it every 20 seconds. You can close the tab. The swap goes on without it.",
  solanaTxLabel: "Solana transaction",
  trackingLost:
    "We could not reach the swap service just now. The swap keeps going, and this page will try again.",

  /* ------------------------------------------------------------- the dry run */

  dryRunTitle: "Dry run complete.",
  dryRunLine: "Dry run: deposit address obtained, transaction built, nothing sent",
  dryRunNote:
    "The quote and the deposit address are real, and the transaction was built and proved. Nothing went to the Zcash network, so the money is still in the envelope and this link still works.",

  back: "Keep it shielded instead",
} as const;

/* -------------------------------------------- group envelopes (M6 preview) */

export const group = {
  title: "Your envelopes are ready",
  lede: (n: number, each: string) =>
    `${n} links, ${each} ZEC to send for each. Each one is a separate envelope with its own secret and address.`,
  tableCaption: "One row per envelope. Each payment URI pays one envelope.",
  scrollHint: "Scroll the table sideways, or download the CSV and pay from a wallet that takes a batch.",
  download: "Download CSV",
  columns: {
    index: "#",
    /** What the person who opens that link receives. The CSV's `envelope_zec`. */
    envelope: "In the envelope",
    /** Envelope plus the flat service fee: the URI's amount, and `send_zec`. */
    send: "To send",
    link: "Link",
    /** The block the payment arrived in, once this tab has seen it. The CSV's `paid_height`. */
    paid: "Paid",
    /** The link with its birthday at the payment's block. The CSV's `final_link`. */
    finalLink: "Final link",
    address: "Address",
    uri: "Payment URI",
  },
  /** Said under the table, because two amount columns need one line of explanation. */
  columnsNote:
    "“In the envelope” is what the person who opens that link receives. “To send” adds the flat service fee. It is the amount the payment URI asks your wallet for.",
  warn: "Each link is the money. Anyone holding one can open that envelope. Treat the CSV like cash, and send each link to one person only.",
  memoryFine:
    "These links exist in this tab and in the CSV you download. They are not stored, not sent anywhere and not recoverable. Leave this page without saving them, and the money stays in envelopes that cannot be opened.",
  total: (total: string, n: number, each: string) =>
    `You will send ${total} ZEC in total: ${n} payments of ${each} ZEC.`,
  again: "Create more envelopes",
  previewBadge: "Group envelopes are a preview. The links and payment URIs are real. Paying them all at once from one wallet is not built yet.",
} as const;

/* ------------------------------------------------------------------ singles */

export const single = {
  stepOf: (n: number) => `Step ${n} of 3`,
  previewLabel: "What they will see",
  previewEmpty: "No message",
  previewFrom: (name: string) => `From ${name}`,

  /* Step 1: save the link before paying. */
  saveTitle: "Save your link first",
  saveLede:
    "This link will hold the money. Save a copy before you pay. Sending it to yourself in a chat works.",
  linkLabel: "Your envelope link",
  copy: "Copy",
  share: "Share…",
  shareFailed: "Sharing does not work here. Use Copy instead.",
  keepWarn:
    "This link is the money. Anyone with this link can open the envelope. If you lose it after paying, the money cannot be recovered, by you or by us.",
  savedCheckbox: "I saved the link",
  savedBlocked: "Tick the box once the link is somewhere safe.",
  saveContinue: "Continue to payment",

  /* Step 2: pay. */
  payTitle: (total: string) => `Pay ${total} ZEC from your Zcash wallet`,
  openWallet: "Open in my wallet app",
  scanHint: "Or scan this with your wallet app.",
  inEnvelope: "In the envelope",
  serviceFee: "Service fee",
  total: "Total",
  walletFee: "Your wallet may add a small network fee on top.",
  recipientFee: (fee: string) =>
    `When they send it on, a network fee of about ${fee} ZEC comes out of the envelope.`,
  wallets: (list: string) => `Works with ${list}.`,
  fundWarn: "Send exactly this amount from a shielded balance.",
  canClose:
    "You can close this page. The money is safe as long as you keep the link. Open the link any time to check.",
  paidSkip: "I paid. Show me how to send it",
  payExtras: "Payment details",
  paymentUriLabel: "Payment URI",
  addressLabel: "Envelope address",
  viewingKeyLabel: "Advanced: viewing key",
  viewingKeyHint:
    "This full viewing key lets a wallet watch the envelope. It shows the amounts and messages that arrive at this address. It cannot spend and cannot open the envelope. Share it only with someone you want watching.",
  back: "Back",

  /* Step 3: send the link. */
  sendTitlePaid: "Paid. Now send it.",
  sendTitle: "Now send it.",
  sendLede: (amount: string) => `${amount} ZEC is in the envelope. Send them the link in any chat.`,
  sendLedeUnpaid:
    "We have not seen your payment yet. The link works as soon as it arrives, so you can send it now.",
  shareLink: "Share link…",
  copyLink: "Copy link",
  showQr: "Show QR",
  hideQr: "Hide QR",
  qrHint: "For in person: they scan this with their phone camera.",
  takeBack: "Take it back",
  takeBackBody:
    "If they have not opened it yet, open your own link and send the money back to your wallet.",
  takeBackGo: "Open my link",
  again: "Make another envelope",
} as const;

/* ------------------------------------------------------------ payment watch */

/**
 * The create page watching for the sender's payment. Sender-facing: it names
 * the payment, the block and the faster link, and nothing a recipient does.
 */
export const watch = {
  waitingTitle: "Waiting for your payment",
  /** The status line on step 2, before the first look has an answer. */
  waitingLine: "Waiting for your payment. Usually about a minute.",
  groupWaitingBody:
    "Keep this tab open and it checks each envelope every 45 seconds, for two hours. As payments land, the table and the CSV get the block each one arrived in and a faster link for it. Closing the tab loses nothing. Your links work as they are.",
  firstLook: "First look in about 30 seconds.",
  checking: "Checking the chain now…",
  checkingOne: (i: number, n: number) => `Checking envelope ${i} of ${n}…`,
  nothingYet: (time: string) => `Nothing yet as of ${time}. Next look in 45 seconds.`,
  paused: "Paused while this tab is in the background. It starts again when you come back.",
  stopped: "Stopped checking after two hours. Your link still works.",
  checkAgain: "Check again",
  errors: (n: number) =>
    `${n === 1 ? "One look" : `${n} looks`} could not reach the chain. It keeps trying.`,
  noHeight:
    "This page could not read the chain height, so it is not watching for your payment. The link still works.",
  paidDetail: (zec: string, height: number) => `${zec} ZEC arrived in block ${height}.`,
  groupPaid: (paid: number, n: number) => `${paid} of ${n} paid.`,
  groupDone: (n: number) =>
    `All ${n} paid. Download the CSV again for the faster final links. The first ones still work.`,
  groupPaidCell: (height: number) => `block ${height}`,
  groupUnpaidCell: "not yet",
} as const;

/* ------------------------------------------------------- take one back (/back) */

export const takeBack = {
  title: "Take an envelope back",
  lede: "Paste the link of an envelope you made. If it has not been opened yet, you can open it and send the money back to your own wallet.",
  label: "Your envelope link",
  placeholder: "https://…/e#…",
  submit: "Open my envelope",
  notHere: "That is not an envelope link from this site. Check that you copied all of it.",
  noSecret: "That link has no envelope in it. Check that you copied all of it.",
  note: "Once someone has opened it and sent the money on, it cannot be taken back.",
} as const;

/* ------------------------------------------------ open page: sealed and revealed */

export const sealed = {
  title: "You have an envelope",
  open: "Open",
  reassure:
    "It opens here in your browser. Nothing to install. We never ask for a password or card details.",
  safeLink: "Is this safe?",
  scanningTitle: "Opening your envelope…",
  scanningHint: "Looking for it on the Zcash network. Your browser checks every block itself.",
} as const;

export const revealed = {
  title: "Your envelope is open",
  from: (name: string) => `From ${name}`,
  receive: "Receive it",
  checking: "Checking…",
  details: "Details",
  whatIsZec: "What is ZEC?",
  whatIsZecBody:
    "ZEC is Zcash, a kind of digital money. You can keep it as ZEC or change it into dollars.",
  compactLabel: "In this envelope",
} as const;

/* -------------------------------------------- open page: where should it go? */

export const receive = {
  title: "Where should it go?",
  back: "Back",
  continue: "Continue",

  exchangeTitle: "My exchange account",
  exchangeHint: "Coinbase, Kraken, Binance and others.",
  exchangeHow: "In your exchange, open Deposit, choose ZEC and copy the deposit address.",
  exchangeLabel: "Your ZEC deposit address",

  appTitle: "A Zcash wallet app",
  appHint: "Zodl, Zingo and others. Free on your phone.",
  appSteps: [
    "Install Zodl or Zingo from your app store.",
    "Open it and tap Receive.",
    "Copy the address and paste it here.",
  ],
  appLabel: "Your Zcash address",

  pageWalletTitle: "Make a wallet in this page",
  pageWalletHint: "For people who cannot install an app. You get 24 words to keep.",
  pageWalletWords:
    "These 24 words are the wallet. Write them on paper now. They are shown once and saved nowhere.",
  pageWalletWarn: "Never screenshot these words or send them to anyone, even family.",
  pageWalletLater:
    "To use this money later, type these 24 words into a wallet app such as Zodl or Zingo.",
  pageWalletCheckbox: "I wrote these down",

  /** The review button, named after where the money goes. */
  sendTo: {
    exchange: "Send to my exchange",
    app: "Send to my wallet app",
    wallet: "Send to my new wallet",
    solana: "Send to my Solana wallet",
  },
} as const;

/** The done screen: where the money is now, and what to do next. */
export const doneCopy = {
  exchange: {
    where: "The money is on its way to your exchange account.",
    next: "It shows in your account after the exchange sees enough confirmations. Usually minutes, sometimes longer.",
  },
  app: {
    where: "The money is on its way to your Zcash wallet app.",
    next: "It shows in the app within a few minutes, once the next blocks arrive.",
  },
  wallet: {
    where: "The money is in the wallet this page made for you.",
    next: "To use it, install a wallet app such as Zodl or Zingo, choose to restore a wallet and type your 24 words.",
  },
  solana: {
    where: "The ZEC is on its way to the swap service.",
    next: "The USDC arrives in your Solana wallet when the swap finishes. This page follows it below.",
  },
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
  lede: "Someone with this link already sent the money on. There is nothing left to send.",
  /** Height and date of the block the sweep was mined in. */
  when: (height: string, date: string | null) =>
    date ? `Opened in block ${height}, on ${date}.` : `Opened in block ${height}.`,
  txLabel: "Moved on in",
  explorerLink: `See it on ${EXPLORER_NAME}`,
  received: (zec: string) => `It held ${zec}.`,
  notYou:
    "If that was not you, someone else with this link got there first. The link is the money. Whoever holds it can open the envelope, and a payment on-chain cannot be undone.",
  /** Shown on the normal open screen when only some of the notes were already moved on. */
  partial: (spentZec: string) =>
    `Another ${spentZec} was sent to this envelope and has already been moved on. It is not counted above.`,
};

/* ------------------------------------ open page: the spend check (/e) */

/**
 * A final link carries the block the envelope was paid in, so the core finds the
 * note in the first block it reads and the page shows it at once. The walk to
 * the chain tip then only checks that nobody has moved it on; until that is
 * done, nothing can be sent.
 */
export const spendCheck = {
  /** Shown under the amount while the walk runs; the span is not known yet. */
  starting: "Checking it hasn't been opened…",
  line: (scanned: string, total: string) =>
    `Checking it hasn't been opened… block ${scanned} of ${total}`,
  sendOnTitle: "Send it on",
  sendOnWaiting: "You can send it on as soon as the check finishes.",
  sendOnButton: "Checking…",
};

/* -------------------------------------------------- the note and the envelope */

/**
 * The words printed on the paper objects: the banknote, the postmark and the
 * tear strip. They are print, not interface, which is why the microtext and
 * the postmark ring are in capitals.
 */
export const noteCopy = {
  issuer: "Zenvelope shielded note",
  unit: "ZEC",
  memoLabel: "Memo",
  microtext: "SHIELDED ZCASH NOTE   ",
  postmarkRing: "ZENVELOPE  SHIELDED  POST  ",
  postmarkSent: "SENT",
  sealedLabel: "A sealed envelope",
  openLabel: "An open envelope with a note inside",
  emptyLabel: "An empty envelope",
  pullHint: "Tap Open, or pull the strip.",
} as const;

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
    exchangeBoundary,
    takeBack,
    sealed,
    revealed,
    receive,
    doneCopy,
    solanaExit,
    group,
    single,
    alreadyOpened,
    spendCheck,
    watch,
    noteCopy,
    NEVER_ASK,
    ONLY_ASK,
  });
  return out;
}
