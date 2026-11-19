// The launch desk's order book: the bids a visitor drafts before the auction runs, and the order they go in.
//
// Prices are typed as ETH per token and become the auction's Q96 grid only when placed. The rules are the CCA's own:
// a bid must be priced above the current clearing price, which starts at the floor and never falls
// (ContinuousClearingAuction.sol:355-366). So the floor itself is never a valid bid, and bids go in lowest first: each
// one then lands at or above the clearing price the earlier ones left.

import { parseEther } from "viem";
import type { AuctionGrid } from "./launch";
import { q96ToNumber, snapToAuctionTick } from "./price";

/** The dev chain's scripted bidders. On a public chain every bid is the connected wallet's. */
export type Bidder = "alice" | "bob";

export interface DraftBid {
  id: string;
  bidder: Bidder;
  /** Most the bid pays per token, in ETH. */
  price: number;
  /** ETH committed. */
  amount: number;
}

/** The most bids a draft holds: on a public chain each is a wallet prompt; six fits the seed's six demand levels. */
export const maxBids = (publicChain: boolean) => (publicChain ? 4 : 6);

/** The suite's bids at a launch's scale: two that get outbid and a winner, at prices from the floor, amounts × `scale`. */
export const draftBids = (floorEth: number, scale: number): DraftBid[] => [
  { id: "b1", bidder: "bob", price: floorEth * (1 + 1 / 64), amount: 300 * scale },
  { id: "b2", bidder: "bob", price: floorEth * (1 + 3 / 64), amount: 300 * scale },
  { id: "b3", bidder: "alice", price: floorEth * (1 + 19 / 64), amount: 1400 * scale },
];

/** Larger than any balance here; also where `toFixed` would switch to exponent notation, which parseEther refuses. */
const MAX_BID_ETH = 1e12;

/** A bid's amount in wei; 0 for anything that is not a positive, payable amount. */
export const bidWei = (amount: number) => (Number.isFinite(amount) && amount > 0 && amount < MAX_BID_ETH ? parseEther(amount.toFixed(18)) : 0n);

/** The grid price a draft is placed at: snapped to the auction's ticks, and never below one tick above the floor. */
export function placedPrice(price: number, grid: AuctionGrid): bigint {
  const snapped = snapToAuctionTick(price, grid.floorPrice, grid.auctionTick);
  const lowest = grid.floorPrice + grid.auctionTick;
  return snapped < lowest ? lowest : snapped;
}

/** The bids that are sent, in the order they are sent: lowest grid price first, ties in the order they were drafted. */
export function placementOrder(bids: readonly DraftBid[], grid: AuctionGrid): DraftBid[] {
  return bids
    .map((b, i) => ({ b, i, p: placedPrice(b.price, grid) }))
    .filter(({ b }) => bidWei(b.amount) > 0n)
    .sort((x, y) => (x.p < y.p ? -1 : x.p > y.p ? 1 : x.i - y.i))
    .map(({ b }) => b);
}

const idNumber = (id: string) => Number(id.replace(/^\D+/, "")) || 0;

/** A new bid one tick above the highest drafted, for 200 ETH at the launch's scale, from the bidder with fewer bids. */
export function addBid(bids: readonly DraftBid[], grid: AuctionGrid, scale: number, publicChain: boolean): DraftBid[] {
  if (bids.length >= maxBids(publicChain)) return [...bids];
  const top = bids.reduce((m, b) => (placedPrice(b.price, grid) > m ? placedPrice(b.price, grid) : m), grid.floorPrice);
  const count = (who: Bidder) => bids.filter((b) => b.bidder === who).length;
  const id = `b${bids.reduce((m, b) => Math.max(m, idNumber(b.id)), 0) + 1}`;
  return [...bids, { id, bidder: count("alice") < count("bob") ? "alice" : "bob", price: q96ToNumber(top + grid.auctionTick), amount: 200 * scale }];
}

export const removeBid = (bids: readonly DraftBid[], id: string) => bids.filter((b) => b.id !== id);

export const switchBidder = (bids: readonly DraftBid[], id: string) => bids.map((b) => (b.id === id ? { ...b, bidder: b.bidder === "alice" ? ("bob" as const) : ("alice" as const) } : b));

/**
 * What stands in the way of placing the draft (`blocking`), and what may not go as planned (`warning`). Two bids at one
 * price can both stand only while the first leaves supply at that price: once they fill it, the clearing price reaches
 * it and the next bid there is refused.
 */
export function bidProblems(bids: readonly DraftBid[], grid: AuctionGrid): { blocking: string | null; warning: string | null } {
  const unpayable = bids.find((b) => b.amount > 0 && bidWei(b.amount) === 0n);
  const live = placementOrder(bids, grid);
  const blocking = unpayable
    ? unpayable.amount >= MAX_BID_ETH
      ? "A bid that large can't be paid: lower it or remove it."
      : "A bid that small rounds to nothing: raise it or remove it."
    : live.length === 0
      ? "Add a bid: an auction with no bids raises nothing to migrate."
      : null;
  const prices = live.map((b) => placedPrice(b.price, grid));
  const shared = prices.some((p, i) => prices.indexOf(p) !== i);
  return { blocking, warning: shared ? "Two bids share a price: once the first fills the supply there, the next one is refused." : null };
}
