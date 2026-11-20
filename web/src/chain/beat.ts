import type { Hex } from "viem";
import type { Who } from "./accounts";
import type { DecodedError } from "./errors";
import type { Outcome } from "./tx";

/** One thing that happened, or was tried, and how it ended. */
export interface Beat {
  id: string;
  /** Chain time, seconds. */
  at: number;
  block?: number;
  actor: Who;
  /** Who acted, when that is a real account rather than a demo role: "You", or a short address (public chains). */
  by?: string;
  title: string;
  detail?: string;
  ok: boolean;
  error?: DecodedError;
  hash?: Hex;
  /** "app": done from this app, including refused attempts. "chain": read back from event logs. */
  source: "app" | "chain";
  /** The vault an app attempt was made on: another vault's feed does not list it. */
  vault?: string;
}

export type BeatInput = Omit<Beat, "id" | "at" | "source" | "block"> & { at?: number; block?: number };

/** A beat for a transaction outcome. `detail` only renders for successes. */
export function beatOf<T>(o: Outcome<T>, actor: Who, title: string, detail?: (value: T | undefined) => string | undefined): BeatInput {
  return {
    actor,
    title,
    ok: o.ok,
    hash: o.hash,
    block: o.receipt ? Number(o.receipt.blockNumber) : undefined,
    error: o.error,
    detail: o.ok ? detail?.(o.value) : undefined,
  };
}

/** A beat that is just narration: something the world did, or a fact worth showing. */
export const note = (actor: Who, title: string, detail?: string): BeatInput => ({ actor, title, detail, ok: true });
