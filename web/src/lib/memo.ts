/**
 * The sender's name, carried in the memo as a plain trailing line.
 *
 * The memo is the only thing that travels with the money, so the optional
 * "From" field rides in it rather than anywhere else: the message, a blank
 * line, then `From <name>`. A wallet that shows the raw memo shows exactly
 * that, which reads fine. The open page splits it back off and shows the name
 * above the amount.
 *
 * Old memos, and memos written by any other wallet, have no such line and
 * render as they always did.
 */

/** Longest name the form accepts. Plenty for a name, short enough for a memo. */
export const MAX_FROM_CHARS = 40;

const FROM_PREFIX = "From ";

/** One line, single spaces, no leading or trailing whitespace. */
function cleanName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

/** The memo the sender's wallet is asked to write: message, then the From line. */
export function composeMemo(message: string, from: string): string {
  const note = message.trim();
  const name = cleanName(from);
  if (name === "") return note;
  const line = `${FROM_PREFIX}${name}`;
  return note === "" ? line : `${note}\n\n${line}`;
}

export interface ParsedMemo {
  /** The name from a trailing `From <name>` line, or null. */
  from: string | null;
  /** Everything else, trimmed, or null when nothing is left. */
  note: string | null;
}

/**
 * Splits a trailing `From <name>` line off a memo.
 *
 * Only the shape {@link composeMemo} writes is recognised: the whole memo is
 * the From line, or the From line follows a blank line. A message that merely
 * mentions "From" somewhere is left alone.
 */
export function parseMemo(memo: string | null | undefined): ParsedMemo {
  const text = (memo ?? "").trim();
  if (text === "") return { from: null, note: null };
  const re = new RegExp(`(?:^|\\n\\s*\\n)${FROM_PREFIX}([^\\n]{1,${MAX_FROM_CHARS * 2}})$`);
  const m = re.exec(text);
  if (!m) return { from: null, note: text };
  const name = cleanName(m[1]);
  if (name === "") return { from: null, note: text };
  const note = text.slice(0, m.index).trim();
  return { from: name, note: note === "" ? null : note };
}
