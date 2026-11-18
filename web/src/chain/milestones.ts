// The moments a launch's rules change, as jumps for the dock's clock: the setup epoch's end (Pace and deposits begin), a
// proposed curator's timelock, the issuer's principal starting to unlock, and its full vesting. Only those still ahead.

import type { VaultView } from "./view";

export interface Milestone {
  key: "setup" | "curator" | "unlock" | "vested";
  label: string;
  /** Chain time, seconds. */
  at: number;
}

export function milestones(v: Pick<VaultView, "time" | "pace" | "lock" | "people">): Milestone[] {
  const all: Milestone[] = [
    { key: "setup", label: "Setup epoch ends", at: v.pace.setupEndsAt },
    ...(v.people.pendingCurator ? [{ key: "curator" as const, label: "Curator timelock ends", at: v.people.curatorReadyAt }] : []),
    { key: "unlock", label: "Principal starts to unlock", at: v.lock.unlockStartsAt },
    { key: "vested", label: "Principal fully vested", at: v.lock.fullyVestedAt },
  ];
  return all.filter((m) => m.at > v.time).sort((a, b) => a.at - b.at);
}
