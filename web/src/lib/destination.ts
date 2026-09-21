/**
 * The destination state machine: what a pasted address is, what the recipient is
 * told about it, and whether they may go on.
 *
 * Kept out of the component so the whole matrix can be tested without a DOM. The
 * classification itself comes from the core (`classify_address`); everything here
 * is the product's answer to it.
 *
 *   unified with an Orchard receiver  -> go, stays shielded
 *   transparent t1                    -> go, with a warning
 *   Sapling-only zs1                  -> stop, not supported yet
 *   unified without an Orchard receiver -> stop, cannot receive this note
 *   anything else                     -> stop, not an address
 */

import type { AddressClass, AddressKind, Network } from "../core/types";

export type DestinationStatus = "empty" | "ok" | "warn" | "error";

export interface DestinationState {
  /** Exactly what the recipient typed, untrimmed. */
  input: string;
  status: DestinationStatus;
  /** null while the field is empty. */
  kind: AddressKind | null;
  /** The line under the field. null when there is nothing to say. */
  message: string | null;
  /** Whether "Send it on" may be reached from here. */
  canContinue: boolean;
}

export const DESTINATION_COPY: Record<AddressKind, string> = {
  unified_orchard: "This is a unified address. The money stays shielded the whole way.",
  transparent:
    "This is a transparent address: this leaves the shielded pool and is visible on-chain.",
  sapling:
    "This address type is not supported yet, paste a unified address starting with u1.",
  unified_no_orchard:
    "This unified address has no Orchard receiver, so it cannot take an Ironwood note. Paste a unified address starting with u1 that can.",
  invalid: "That does not look like a Zcash address. Check that you copied all of it.",
};

/** On a mainnet page, a testnet address is the common paste mistake. */
export const WRONG_NETWORK_HINT = "Testnet addresses do not work here.";

export const emptyDestination: DestinationState = {
  input: "",
  status: "empty",
  kind: null,
  message: null,
  canContinue: false,
};

const STATUS: Record<AddressKind, DestinationStatus> = {
  unified_orchard: "ok",
  transparent: "warn",
  sapling: "error",
  unified_no_orchard: "error",
  invalid: "error",
};

/** The two kinds this note can actually be sent to. */
export function isSendable(kind: AddressKind): boolean {
  return kind === "unified_orchard" || kind === "transparent";
}

export type Classify = (addr: string, network: Network) => AddressClass;

/** The same call across the core worker, which is where it lives from M4 on. */
export type ClassifyAsync = (addr: string, network: Network) => Promise<AddressClass>;

/**
 * One keystroke of the destination field. Pure: the only outside call is
 * `classify`, and a throw from it is treated as "not an address" rather than
 * being allowed to take the page down.
 */
export function classifyDestination(
  input: string,
  classify: Classify,
  network: Network = "main",
): DestinationState {
  const addr = input.trim();
  if (addr === "") return { ...emptyDestination, input };

  let result: AddressClass;
  try {
    result = classify(addr, network);
  } catch {
    result = { kind: "invalid", reason: null };
  }
  return describeDestination(input, result, network);
}

/**
 * The same thing over the core worker. The classification is a message round trip now,
 * so this is a promise; the verdict it turns into is the very same pure function, which
 * is why the whole matrix is still tested synchronously.
 *
 * A rejection is "not an address", exactly as a throw is above: a destination field must
 * never be able to take the page down.
 */
export async function classifyDestinationAsync(
  input: string,
  classify: ClassifyAsync,
  network: Network = "main",
): Promise<DestinationState> {
  const addr = input.trim();
  if (addr === "") return { ...emptyDestination, input };

  let result: AddressClass;
  try {
    result = await classify(addr, network);
  } catch {
    result = { kind: "invalid", reason: null };
  }
  return describeDestination(input, result, network);
}

/** The product's answer to a classification. The only place the copy is chosen. */
export function describeDestination(
  input: string,
  result: AddressClass,
  network: Network = "main",
): DestinationState {
  const addr = input.trim();
  const kind = result.kind;
  let message = DESTINATION_COPY[kind];
  if (kind === "invalid" && network === "main" && /^(utest1|ztestsapling1|t[mn])/.test(addr)) {
    message = `${message} ${WRONG_NETWORK_HINT}`;
  }

  return {
    input,
    status: STATUS[kind],
    kind,
    message,
    canContinue: isSendable(kind),
  };
}
