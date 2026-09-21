/**
 * The dry-run switch.
 *
 * `?dry=1` in the **query string** builds and proves the sweep and stops there:
 * `sweep_envelope` is called with `broadcast: false`, nothing is handed to
 * lightwalletd, and the done screen says so and shows the size of the
 * transaction it built instead of a link to a transaction that does not exist.
 *
 * It is read from the query string and never from the fragment. The fragment is
 * the money, and a flag that lived in it could be lost, mangled or copied along
 * with a secret; the query string is the part of the URL a test may safely write.
 */

export const DRY_RUN_PARAM = "dry";

/** The line the done screen shows when nothing was sent. */
export const DRY_RUN_COPY = "Dry run: transaction built and proved, not sent";

/**
 * True when the page was loaded with `?dry=1`.
 *
 * `search` is an argument so this is testable without a DOM; in the browser it
 * defaults to `window.location.search`, which never contains the fragment.
 */
export function isDryRun(
  search: string = typeof window === "undefined" ? "" : window.location.search,
): boolean {
  try {
    return new URLSearchParams(search).get(DRY_RUN_PARAM) === "1";
  } catch {
    return false;
  }
}

/**
 * How many bytes of transaction the hex body is. 0 when there is none, which is
 * what a broadcast sweep reports.
 */
export function rawTxBytes(hex: string | null | undefined): number {
  if (typeof hex !== "string") return 0;
  const body = hex.trim();
  if (body === "") return 0;
  return Math.floor(body.length / 2);
}
