import data from "./recorded.json";
import type { Recorded } from "./types";

/** Outcomes recorded from the real contracts on a local chain by `npm run record`. */
export const recorded = data as unknown as Recorded;
export type { Recorded, RecordedBeat, RecordedError, RecordedView } from "./types";
