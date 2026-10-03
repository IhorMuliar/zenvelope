import { useState } from "react";
import { single as copy } from "../copy/en";

interface Props {
  /** The link to hand to the system share sheet. */
  url: string;
  face: string;
  className?: string;
  testId?: string;
}

/** Whether this browser has a system share sheet at all. */
export function canShare(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

/**
 * Opens the system share sheet with the link, and nothing else. Renders nothing
 * where there is no share sheet, so the caller shows Copy instead.
 *
 * A cancelled share is not an error: the sheet closing is the person changing
 * their mind, and the page says nothing about it.
 */
export function ShareButton({ url, face, className = "", testId }: Props) {
  const [failed, setFailed] = useState(false);
  if (!canShare()) return null;
  return (
    <>
      <button
        type="button"
        className={className}
        data-testid={testId}
        onClick={() => {
          setFailed(false);
          navigator.share({ url }).catch((err: Error) => {
            if (err?.name !== "AbortError") setFailed(true);
          });
        }}
      >
        {face}
      </button>
      {failed ? (
        <p className="hint" role="status">
          {copy.shareFailed}
        </p>
      ) : null}
    </>
  );
}
