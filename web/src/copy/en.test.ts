/**
 * The drainer-safety audit, as a test.
 *
 * `src/copy/en.ts` is the only place the sender-side pages get their words
 * from, so the rules in its header can be checked mechanically here instead of
 * by grepping JSX. A rule that is only written down is a rule that drifts.
 */

import { describe, expect, it } from "vitest";
import {
  NEVER_ASK,
  ONLY_ASK,
  allStrings,
  doneCopy,
  exchangeBoundary,
  footer,
  group,
  how,
  landing,
  receive,
  revealed,
  sealed,
  single,
  solanaExit,
  takeBack,
  transparentBoundary,
  trustBoundary,
} from "./en";

const strings = allStrings();

/**
 * The two safety lines are the only strings allowed to contain the phrases the
 * rest of the copy bans, because they exist precisely to name them. Everything
 * else that mentions a seed phrase or a wallet connection is a bug.
 */
const SAFETY_LINES = [NEVER_ASK, ONLY_ASK, how.neverAskFine];

function body(s: string): boolean {
  return !SAFETY_LINES.includes(s);
}

describe("rule 1: never the word claim", () => {
  it("does not appear anywhere in the copy, in any compound", () => {
    const offenders = strings.filter((s) => /claim/i.test(s));
    expect(offenders, `copy containing "claim": ${offenders.join(" | ")}`).toEqual([]);
  });

  it("uses open, receive or unwrap instead", () => {
    const verbs = strings.join(" ").toLowerCase();
    expect(verbs).toMatch(/\bopen(s|ed|ing)?\b/);
  });
});

describe("rule 2: never ask for a wallet connection or a seed phrase", () => {
  it("never tells anyone to connect a wallet", () => {
    const offenders = strings.filter(
      (s) => body(s) && /connect\s+(your|a|the|my)?\s*wallet/i.test(s),
    );
    expect(offenders, offenders.join(" | ")).toEqual([]);
  });

  it("never mentions wallet-connect machinery at all", () => {
    const offenders = strings.filter(
      (s) => body(s) && /(walletconnect|connect wallet|link your wallet|sign in with)/i.test(s),
    );
    expect(offenders, offenders.join(" | ")).toEqual([]);
  });

  it("never asks for a seed phrase, recovery phrase, private key or password", () => {
    const offenders = strings.filter(
      (s) =>
        body(s) &&
        /(enter|type|paste|give|share|provide|confirm)[^.]{0,40}(seed|recovery|mnemonic|private key|password)/i.test(
          s,
        ),
    );
    expect(offenders, offenders.join(" | ")).toEqual([]);
  });

  it("asks the recipient for a destination and nothing else", () => {
    expect(ONLY_ASK).toMatch(/one thing/i);
    expect(ONLY_ASK).toMatch(/address/i);
  });
});

describe("rule 3: the never-ask line is stated plainly", () => {
  it("names all three things", () => {
    expect(NEVER_ASK).toMatch(/seed phrase/i);
    expect(NEVER_ASK).toMatch(/wallet password/i);
    expect(NEVER_ASK).toMatch(/wallet connection/i);
    expect(NEVER_ASK).toMatch(/^We will never ask/);
  });

  it("is on the landing page and on /how, word for word", () => {
    expect(landing.neverAsk).toBe(NEVER_ASK);
    expect(how.neverAsk).toBe(NEVER_ASK);
  });
});

describe('rule 4: the "Is this link safe?" section teaches the check', () => {
  it("is titled as a question the reader is already asking", () => {
    expect(how.safeTitle).toBe("Is this link safe?");
  });

  it("covers the host, the fragment, the source and the explorer", () => {
    const all = how.safeChecks.map((c) => `${c.title} ${c.body}`).join(" ");
    expect(all).toMatch(/host/i);
    expect(all).toMatch(/#/);
    expect(all).toMatch(/never (leaves|send)/i);
    expect(all).toMatch(/github\.com\/IhorMuliar\/zenvelope/);
    expect(all).toMatch(/open source/i);
    expect(all).toMatch(/explorer/i);
  });

  it("has four checks, each with a title and a body", () => {
    expect(how.safeChecks).toHaveLength(4);
    for (const c of how.safeChecks) {
      expect(c.title.length).toBeGreaterThan(8);
      expect(c.body.length).toBeGreaterThan(40);
    }
  });
});

describe("the landing page is the tool", () => {
  it("has one headline and one short subline about the recipient", () => {
    expect(landing.headline).toBe("Send shielded ZEC as a link");
    const words = landing.subline.trim().split(/\s+/);
    expect(words.length).toBeLessThanOrEqual(20);
    expect(landing.subline).toMatch(/browser/i);
    expect(landing.subline).toMatch(/no app/i);
    expect(landing.subline).toMatch(/wallet/i);
  });

  it("offers the four preset amounts", () => {
    expect(landing.presets).toEqual(["0.01", "0.05", "0.1", "0.5"]);
  });

  it("has optional message and From fields, and a memo limit that names both", () => {
    expect(landing.messageLabel).toMatch(/optional/i);
    expect(landing.fromLabel).toMatch(/^From/);
    expect(landing.fromLabel).toMatch(/optional/i);
    expect(landing.memoTooLong(600, 512)).toContain("600 of 512 bytes");
  });

  it("keeps group mode behind a small link", () => {
    expect(landing.groupAsk).toBe("Sending to several people?");
    expect(landing.groupLink).toBe("Make several links");
  });

  it('has a three-step "how it works": wallet, chat, they choose', () => {
    expect(landing.howSteps).toHaveLength(3);
    expect(landing.howSteps[0]).toMatch(/Zcash wallet/i);
    expect(landing.howSteps[1]).toMatch(/chat/i);
    expect(landing.howSteps[2]).toMatch(/open it/i);
    expect(landing.howSteps[2]).toMatch(/where the money goes/i);
  });

  it('says "Safe by design" in one short line, next to the never-ask sentence', () => {
    expect(landing.safeTitle).toBe("Safe by design");
    expect(landing.safeLine).toMatch(/never hold/i);
    expect(landing.safeLine.split(". ").length).toBeLessThanOrEqual(3);
  });
});

describe("/how carries the long explanation", () => {
  it("has the one-paragraph protocol, naming the fragment", () => {
    expect(how.inOneParagraph.split(". ").length).toBeGreaterThan(2);
    expect(how.inOneParagraph).toMatch(/#/);
    expect(how.inOneParagraph).toMatch(/never send to any server/);
  });

  it('has the three-card "we never hold funds" strip: wallet, chain, browser', () => {
    expect(how.neverHoldSteps).toHaveLength(3);
    expect(how.neverHoldSteps[0].title).toMatch(/wallet/i);
    expect(how.neverHoldSteps[1].title).toMatch(/on-chain/i);
    expect(how.neverHoldSteps[2].title).toMatch(/browser/i);
  });
});

describe("plain words", () => {
  it("has no em-dashes anywhere in the copy", () => {
    const offenders = strings.filter((s) => s.includes("\u2014"));
    expect(offenders, offenders.join(" | ")).toEqual([]);
  });

  it('never says "nobody" or "unique"', () => {
    const offenders = strings.filter((s) => /\b(nobody|unique)\b/i.test(s));
    expect(offenders, offenders.join(" | ")).toEqual([]);
  });
});

describe("the sender's three steps", () => {
  it("counts the steps out of three", () => {
    expect(single.stepOf(2)).toBe("Step 2 of 3");
  });

  it("saves the link before anything is paid", () => {
    expect(single.saveTitle).toBe("Save your link first");
    expect(single.savedCheckbox).toBe("I saved the link");
    expect(single.keepWarn).toMatch(/cannot be recovered/i);
  });

  it("names the total, both fees, and that the page may be closed", () => {
    expect(single.payTitle("0.0103")).toBe("Pay 0.0103 ZEC from your Zcash wallet");
    expect(single.walletFee).toMatch(/network fee/i);
    expect(single.recipientFee("0.0001")).toContain("0.0001 ZEC");
    expect(single.canClose).toMatch(/close this page/i);
    expect(single.canClose).toMatch(/keep the link/i);
  });

  it("explains taking it back plainly", () => {
    expect(single.takeBackBody).toMatch(/not opened it yet/i);
    expect(takeBack.note).toMatch(/cannot be taken back/i);
  });
});

describe("the open page", () => {
  it("reassures on the sealed screen without asking for anything", () => {
    expect(sealed.title).toBe("You have an envelope");
    expect(sealed.reassure).toMatch(/browser/i);
    expect(sealed.reassure).toMatch(/never ask for a password or card details/i);
    expect(sealed.safeLink).toBe("Is this safe?");
  });

  it("explains ZEC in one or two plain sentences", () => {
    const sentences = revealed.whatIsZecBody.split(/(?<=\.)\s+/);
    expect(sentences.length).toBeLessThanOrEqual(3);
    expect(revealed.whatIsZecBody).toMatch(/digital money/i);
    expect(revealed.whatIsZecBody).toMatch(/dollars/i);
  });

  it("names every destination in plain words", () => {
    expect(receive.exchangeTitle).toBe("My exchange account");
    expect(solanaExit.cardTitle).toBe("USDC in my Solana wallet");
    expect(receive.appTitle).toBe("A Zcash wallet app");
    expect(receive.pageWalletTitle).toBe("Make a wallet in this page");
    expect(receive.pageWalletHint).toMatch(/cannot install an app/i);
  });

  it("warns about the 24 words and says how they are used later", () => {
    expect(receive.pageWalletWarn).toMatch(/never screenshot/i);
    expect(receive.pageWalletWarn).toMatch(/even family/i);
    expect(receive.pageWalletLater).toMatch(/wallet app/i);
  });

  it("names the destination on the send button", () => {
    expect(receive.sendTo.exchange).toBe("Send to my exchange");
    expect(Object.values(receive.sendTo).every((l) => l.startsWith("Send to my"))).toBe(true);
  });

  it("says where the money is and what to do next, for every destination", () => {
    for (const d of Object.values(doneCopy)) {
      expect(d.where.length).toBeGreaterThan(10);
      expect(d.next.length).toBeGreaterThan(10);
    }
    expect(doneCopy.wallet.next).toMatch(/24 words/);
  });
});

describe("the transparent gates", () => {
  it("keeps four points and a required tick for each wording", () => {
    for (const gate of [transparentBoundary, exchangeBoundary]) {
      expect(gate.points).toHaveLength(4);
      expect(gate.checkbox).toMatch(/^I understand/);
      expect(gate.blockedHint).toMatch(/tick the box/i);
    }
  });

  it("words the exchange case as an ordinary, public deposit", () => {
    const all = exchangeBoundary.points.map((p) => `${p.title} ${p.body}`).join(" ");
    expect(exchangeBoundary.lede).toMatch(/like any other deposit/i);
    expect(all).toMatch(/visible/i);
    expect(all).toMatch(/0\.00015/);
  });
});

describe("the footer", () => {
  it("says open source MIT and links the repo", () => {
    expect(footer.sourceLabel).toBe("Open source, MIT");
    expect(footer.sourceUrl).toBe("https://github.com/IhorMuliar/zenvelope");
  });

  it("names the hackathon and the track", () => {
    expect(footer.built).toBe(
      "Built for the Colosseum Crypto World's Fair 2026, Zcash track.",
    );
  });

  it("states no analytics and no cookies as a fact", () => {
    expect(footer.noTracking).toBe("No analytics. No cookies.");
  });
});

describe("the trust boundary", () => {
  it("names all four things you give up", () => {
    expect(trustBoundary.points).toHaveLength(4);
    const all = trustBoundary.points.map((p) => `${p.title} ${p.body}`).join(" ");
    expect(all).toMatch(/public/i);
    expect(all).toMatch(/third-party swap service/i);
    expect(all).toMatch(/spread/i);
    expect(all).toMatch(/fees/i);
    expect(all).toMatch(/not the swap provider/i);
    expect(all).toMatch(/never hold/i);
  });

  it("has the required tick, worded exactly", () => {
    expect(trustBoundary.checkbox).toBe("I understand this leaves the shielded pool");
  });

  it("explains the block rather than just applying it", () => {
    expect(trustBoundary.blockedHint).toMatch(/tick the box/i);
  });
});

describe("the Solana exit", () => {
  it("says what the swap provider sees, in full", () => {
    expect(solanaExit.providerSees).toMatch(/amount of ZEC/i);
    expect(solanaExit.providerSees).toMatch(/Solana address it pays out to/i);
    expect(solanaExit.providerSees).toMatch(/network address/i);
    // And what it does not see, because that is the part that matters here.
    expect(solanaExit.providerSees).toMatch(/does not see this link/i);
  });

  it("surfaces the house fee the quote carries, and hedges when it carries none", () => {
    expect(solanaExit.feeLine(25)).toMatch(/includes a 0\.25% service fee to the swap provider/);
    expect(solanaExit.feeLine(25)).toMatch(/not ours/i);
    expect(solanaExit.feeLine(null)).toBe(
      "The swap provider may charge a service fee included in the quote.",
    );
  });

  it("labels the tracker's figures Quoted and Received", () => {
    expect(solanaExit.quotedLabel).toBe("Quoted");
    expect(solanaExit.receivedLabel).toBe("Received");
  });

  it("explains the minimum with the live figure in it", () => {
    const line = solanaExit.minimum("0.00132");
    expect(line).toContain("0.00132");
    expect(line).toMatch(/will not trade less/i);
    // And it offers the shielded way out rather than a dead end.
    expect(line).toMatch(/shielded ZEC/i);
  });

  it("states that Zenvelope is not the swap provider and never holds funds", () => {
    expect(solanaExit.notProvider).toMatch(/not the swap provider/i);
    expect(solanaExit.notProvider).toMatch(/never holds the funds/i);
  });

  it("is never the headline: the card says what it costs you", () => {
    expect(solanaExit.cardBody).toMatch(/leaves the shielded pool/i);
    expect(solanaExit.back).toMatch(/shielded/i);
  });

  it("puts numbers on the card, never a bare 'fees apply'", () => {
    const line = solanaExit.cardNumbers("0.00085 ZEC", "0.00045 ZEC");
    expect(line).toContain("0.00085 ZEC");
    expect(line).toContain("0.00045 ZEC");
    expect(`${solanaExit.cardBody} ${line}`).not.toMatch(/fees apply/i);
  });

  it("tells a generated secret key holder that it is shown once and stored nowhere", () => {
    expect(solanaExit.secretOnce).toMatch(/once/i);
    expect(solanaExit.secretOnce).toMatch(/saved nowhere/i);
    expect(solanaExit.importHint).toMatch(/Phantom/);
    expect(solanaExit.importHint).toMatch(/Solflare/);
  });

  it("explains the default refund address rather than demanding one", () => {
    expect(solanaExit.refundDefault).toMatch(/this envelope's own address/i);
    expect(solanaExit.refundDefault).toMatch(/this link opens it again/i);
    expect(solanaExit.refundOverrideHint).toMatch(/optional|Leave it empty/i);
  });

  it("says plainly what a dry run did and did not do", () => {
    expect(solanaExit.dryRunLine).toBe(
      "Dry run: deposit address obtained, transaction built, nothing sent",
    );
    expect(solanaExit.dryRunNote).toMatch(/still in the envelope/i);
  });
});

describe("group envelopes", () => {
  it("warns that a link is the money", () => {
    expect(group.warn).toMatch(/anyone holding one can open/i);
  });

  it("says the links are held in memory only", () => {
    expect(group.memoryFine).toMatch(/not stored/i);
    expect(group.memoryFine).toMatch(/not recoverable/i);
  });
});

describe("the single-envelope screen", () => {
  it("still warns that the link is a bearer instrument", () => {
    expect(single.keepWarn).toMatch(/anyone with this link/i);
  });
});
