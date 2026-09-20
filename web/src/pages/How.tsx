import { SENDER_WALLETS } from "../config";

const STEPS: [string, string][] = [
  [
    "Your browser makes a secret",
    "32 random bytes from your browser's own generator. It becomes the part of the link after the #, which browsers never send to any server. We never see it.",
  ],
  [
    "The secret becomes a one-time shielded address",
    "The same secret derives the address, the viewing key and the spending key. No account, no registration, nothing of yours on our side.",
  ],
  [
    "You pay that address from your own wallet",
    `We show a payment URI and a QR for the envelope amount plus the flat service fee. Your wallet sends it directly on-chain. Works with ${SENDER_WALLETS}.`,
  ],
  [
    "You send the link, they open it in a browser",
    "The recipient's browser uses the viewing key to find the note and reveal the amount. No wallet, no install, no address to exchange.",
  ],
  [
    "They move the money where they want it",
    "Their browser signs with the spending key and sends the funds to a Zcash address they choose. The service fee rides along in that transaction. The money never passes through us.",
  ],
];

export function How() {
  return (
    <section className="stack">
      <h1>We never hold funds</h1>
      <p className="lede">Five steps, and none of them is us holding your money.</p>
      <ol className="steps">
        {STEPS.map(([title, body], i) => (
          <li key={i} className="card">
            <h2>{title}</h2>
            <p>{body}</p>
          </li>
        ))}
      </ol>
      <p className="fine">
        Our server is static HTML, JavaScript and WASM. No keys, no float, no custody. If
        this site disappeared, an unopened envelope would still be spendable by whoever
        holds the link, using the open-source code.
      </p>
      <p>
        <a href="/">Create an envelope</a>
      </p>
    </section>
  );
}
