import { single as copy } from "../copy/en";

interface Props {
  /** The amount in the envelope, as a ZEC string without the unit. */
  amount: string;
  message: string;
  from: string;
}

/**
 * What the recipient will see when they open the link: the sender's name, the
 * amount and the note. Shown on every step of the sender's wizard, so a typo
 * is caught before the link goes out rather than after.
 */
export function EnvelopePreview({ amount, message, from }: Props) {
  const name = from.replace(/\s+/g, " ").trim();
  const note = message.trim();
  return (
    <aside className="preview" data-testid="envelope-preview" aria-label={copy.previewLabel}>
      <span className="preview-label">{copy.previewLabel}</span>
      {name ? (
        <span className="preview-from" data-testid="preview-from">
          {copy.previewFrom(name)}
        </span>
      ) : null}
      <strong className="preview-amount" data-testid="preview-amount">
        {amount} ZEC
      </strong>
      <span className={note ? "preview-note" : "preview-note is-empty"} data-testid="preview-note">
        {note || copy.previewEmpty}
      </span>
    </aside>
  );
}
