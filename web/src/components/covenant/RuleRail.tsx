"use client";

import clsx from "clsx";
import { priceAt, ticksToPct } from "@/chain/price";
import type { VaultView } from "@/chain/view";
import { Dot, Meter, Num } from "@/components/ui";
import { amt, duration, pct, price } from "@/lib/format";

type Status = { word: string; tone: "pass" | "warn" | "breach" | "neutral" };

/** One rule's card. `status` is that rule's own state, read from the vault: never a fixed word. */
function Card({ name, status, value, unit, children, meter }: { name: string; status: Status; value: React.ReactNode; unit?: string; children: React.ReactNode; meter: React.ReactNode }) {
  const text = { pass: "text-pass", warn: "text-warn", breach: "text-breach", neutral: "text-muted" }[status.tone];
  return (
    <div className={clsx("flex flex-col gap-3 rounded-lg border bg-surface p-4", status.tone === "breach" ? "border-breach/50" : "border-line")}>
      <div className="flex items-center justify-between">
        <span className="eyebrow">{name}</span>
        <span className={clsx("flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em]", text)}>
          <Dot tone={status.tone} />
          {status.word}
        </span>
      </div>
      <div className="num text-[26px] leading-none text-ink">
        {value}
        {unit && <span className="ml-1.5 text-[13px] text-faint">{unit}</span>}
      </div>
      {meter}
      <p className="text-[13px] leading-snug text-muted">{children}</p>
    </div>
  );
}

/** The covenant's live state, read from the contract: one card per promise, plus the Anchor that bounds every bid. */
export function RuleRail({ world: v }: { world: VaultView }) {
  const { support: s, guard: g, pace: p, lock, terms: t } = v;
  const toUnlock = lock.unlockStartsAt - v.time;
  const fullyVested = v.time >= lock.fullyVestedAt;
  const allowance = p.cap > 0 ? Math.min(1, p.available / p.cap) : 0;
  const trailing = v.twap - v.anchor;
  const lockStatus: Status = !v.adopted
    ? { word: "Not adopted", tone: "neutral" }
    : toUnlock > 0
      ? { word: "Locked", tone: "pass" }
      : fullyVested
        ? { word: "Released", tone: "neutral" }
        : { word: "Vesting", tone: "pass" };

  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))" }}>
      <Card name="Support" status={s.have >= s.need ? { word: "Holding", tone: "pass" } : { word: "Breached", tone: "breach" }} value={<Num value={s.have} format={(x) => pct(x)} />} unit={`of ${pct(s.need, 0)} required`} meter={<Meter value={s.have / 1e4} mark={s.need / 1e4} tone={s.have >= s.need ? "pass" : "breach"} label="Support share" />}>
        {s.have >= s.need ? (
          <>
            <span className="num text-ink">
              {amt(s.inBand)} {v.quoteSymbol}
            </span>{" "}
            is bidding inside the band below the price.
          </>
        ) : (
          <>The band has moved off the vault&apos;s bids. Anyone can call restore, for a bounty from the vault&apos;s bounty pool, up to its terms.</>
        )}
      </Card>

      <Card name="Guard" status={g.ok ? { word: "Holding", tone: "pass" } : { word: "Tripped", tone: "breach" }} value={<Num value={g.diff} format={(x) => String(Math.round(x))} />} unit={`of ${g.limit} ticks`} meter={<Meter value={g.diff / g.limit} mark={1} tone={g.ok ? "pass" : "breach"} label="Spot distance from TWAP" />}>
        {g.ok ? (
          <>Spot is close to its {duration(t.twapWindow)} average, so reshapes, restores and deposits are allowed.</>
        ) : (
          <>Spot has left its {duration(t.twapWindow)} average. Reshape, restore and deposit wait until it holds. Exits never do.</>
        )}
      </Card>

      <Card
        name="Pace"
        status={!v.adopted ? { word: "Not adopted", tone: "neutral" } : p.setup ? { word: "Not yet in force", tone: "warn" } : { word: "In force", tone: "pass" }}
        value={p.setup ? "Setup" : <Num value={allowance * 1e4} format={(x) => pct(x, 0)} />}
        unit={p.setup ? "epoch" : "of allowance left"}
        meter={<Meter value={p.setup ? 0 : allowance} tone="neutral" label="Pace allowance left" />}
      >
        {p.setup ? (
          <>Not enforced in the first epoch, so the seed can be placed in as many reshapes as it takes. Ends in {duration(p.setupEndsAt - v.time)}.</>
        ) : (
          <>
            Up to <span className="num text-ink">{pct(p.available * 1e4)}</span> of the vault can move now. The allowance refills {pct(t.paceBps, 0)} per {duration(t.epochLength)}.
          </>
        )}
      </Card>

      <Card
        name="Anchor"
        status={trailing > t.guardTicks ? { word: "Trailing the price", tone: "warn" } : { word: "In force", tone: "pass" }}
        value={<Num value={priceAt(v.ceiling)} format={(x) => price(x)} />}
        unit="bid ceiling"
        meter={<Meter value={Math.max(0, Math.min(1, trailing / t.supportBandTicks))} tone={trailing > t.guardTicks ? "warn" : "neutral"} label="How far the Anchor trails the TWAP" />}
      >
        {trailing > t.guardTicks ? (
          <>The price ran ahead. The Anchor climbs at most {ticksToPct(t.supportBandTicks).toFixed(0)}% per {duration(t.epochLength)}, so no bid can chase a pump.</>
        ) : (
          <>No bid may sit above this. The Anchor follows a drop at once and climbs at most one band per epoch.</>
        )}
      </Card>

      <Card
        name="Lock"
        status={lockStatus}
        value={!v.adopted ? "—" : fullyVested ? "Released" : toUnlock > 0 ? duration(toUnlock) : pct(lock.vested * 1e4, 0)}
        unit={fullyVested ? undefined : toUnlock > 0 ? "until unlock" : "vested"}
        meter={<Meter value={lock.vested} tone="accent" label="Issuer principal vested" />}
      >
        {!v.adopted ? (
          <>The vault has not adopted a launch yet: the lock starts when it does, then vests over {duration(t.vestDuration)}.</>
        ) : toUnlock > 0 ? (
          <>Issuer principal is fully locked, then vests in a line over {duration(t.vestDuration)}.</>
        ) : fullyVested ? (
          <>The lock has run its course. The issuer may withdraw its principal to the treasury.</>
        ) : (
          <>Vesting ends in {duration(lock.fullyVestedAt - v.time)}. Only the vested share can leave.</>
        )}
      </Card>
    </div>
  );
}
