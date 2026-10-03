import { single as copy } from "../copy/en";
import { Note } from "./Note";

interface Props {
  /** The amount in the envelope, as a ZEC string without the unit. */
  amount: string;
  message: string;
  from: string;
  /** The note's pattern seed: the envelope's public receiving address. */
  seed: string;
}

/**
 * What the recipient will see when they open the link: the note itself, with
 * the sender's name, the amount and the message printed on it. Shown on every
 * step of the sender's wizard, so a typo is caught before the link goes out.
 */
export function EnvelopePreview({ amount, message, from, seed }: Props) {
  return (
    <aside className="preview" data-testid="envelope-preview" aria-label={copy.previewLabel}>
      <span className="preview-label">{copy.previewLabel}</span>
      <Note
        amount={amount}
        memo={message}
        memoEmpty={copy.previewEmpty}
        from={from}
        seed={seed}
        tilt
        testIds={{ amount: "preview-amount", memo: "preview-note", from: "preview-from" }}
      />
    </aside>
  );
}
