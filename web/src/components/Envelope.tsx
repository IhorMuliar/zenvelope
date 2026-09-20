interface Props {
  /** Plays the unwrap: the flap opens and the note slides out. */
  open?: boolean;
  /** A slow breath while the chain is being scanned. */
  busy?: boolean;
}

/**
 * The envelope illustration. Inline SVG, no external asset, no image request:
 * it inherits the page colours and animates from CSS, which
 * prefers-reduced-motion switches off.
 */
export function Envelope({ open = false, busy = false }: Props) {
  const className = ["envelope", open ? "is-open" : "", busy ? "is-busy" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={className} data-testid="envelope" data-open={open ? "true" : "false"}>
      <svg viewBox="0 0 200 140" role="img" aria-label={open ? "An open envelope" : "A sealed envelope"}>
        <rect className="env-body" x="10" y="34" width="180" height="96" rx="12" />
        <path className="env-pocket" d="M10 126 L100 74 L190 126" />
        <path className="env-flap" d="M10 36 L100 96 L190 36 Z" />
        <g className="env-note">
          <rect x="38" y="44" width="124" height="66" rx="8" />
          <path d="M54 66 H146 M54 80 H146 M54 94 H118" />
        </g>
      </svg>
    </div>
  );
}
