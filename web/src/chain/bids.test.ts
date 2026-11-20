import { describe, expect, it } from "vitest";
import { type DraftBid, addBid, bidProblems, bidWei, draftBids, matchPlaced, maxBids, placedPrice, placementOrder, removeBid, switchBidder } from "./bids";
import { AUCTION_FLOOR, AUCTION_TICK } from "./launch";

const GRID = { floorPrice: AUCTION_FLOOR, auctionTick: AUCTION_TICK }; // 1.0 ETH, ticks of 1/64
const bid = (id: string, price: number, amount: number, bidder: DraftBid["bidder"] = "bob"): DraftBid => ({ id, bidder, price, amount });

describe("placementOrder", () => {
  it("sends the lowest price first, keeps drafted order on ties, and skips empty bids", () => {
    const bids = [bid("a", 1.3, 100), bid("b", 1.02, 100), bid("c", 1.3, 50), bid("d", 1.1, 0), bid("e", 1.05, 10)];
    expect(placementOrder(bids, GRID).map((b) => b.id)).toEqual(["b", "e", "a", "c"]);
  });

  it("orders by the grid price the bid is placed at, not the typed one", () => {
    // 1.0160 and 1.0157 both snap to 1 + 1/64; the tie keeps drafted order
    expect(placementOrder([bid("a", 1.016, 1), bid("b", 1.0157, 1)], GRID).map((b) => b.id)).toEqual(["a", "b"]);
  });
});

describe("placedPrice", () => {
  it("places a typed price that is not a number, zero or Infinity one tick above the floor, instead of crashing", () => {
    const lowest = AUCTION_FLOOR + AUCTION_TICK;
    expect(placedPrice(Number.NaN, GRID)).toBe(lowest);
    expect(placedPrice(0, GRID)).toBe(lowest);
    expect(placedPrice(Number("1e309"), GRID)).toBe(lowest);
    // huge, but finite on the Q96 grid: the auction refuses it with its own limit
    expect(placedPrice(1e300, GRID) > lowest).toBe(true);
  });

  it("never places a bid at the floor, which the auction always refuses", () => {
    expect(placedPrice(1, GRID)).toBe(AUCTION_FLOOR + AUCTION_TICK);
    expect(placedPrice(0.5, GRID)).toBe(AUCTION_FLOOR + AUCTION_TICK);
    expect(placedPrice(1 + 3 / 64, GRID)).toBe(AUCTION_FLOOR + 3n * AUCTION_TICK);
  });
});

describe("addBid and removeBid", () => {
  it("adds one tick above the highest bid, for 200 ETH at scale, from the bidder with fewer bids", () => {
    const next = addBid(draftBids(1, 1), GRID, 1, false);
    expect(next).toHaveLength(4);
    expect(next[3]).toEqual({ id: "b4", bidder: "alice", price: 1 + 20 / 64, amount: 200 });
    expect(addBid([], GRID, 2 ** -13, true)[0]).toMatchObject({ id: "b1", price: 1 + 1 / 64, amount: 200 * 2 ** -13 });
  });

  it("stops at the cap: six on a dev chain, four on a public one", () => {
    let dev = draftBids(1, 1);
    for (let i = 0; i < 5; i++) dev = addBid(dev, GRID, 1, false);
    expect(dev).toHaveLength(maxBids(false));
    let pub = draftBids(1, 1);
    for (let i = 0; i < 5; i++) pub = addBid(pub, GRID, 1, true);
    expect(pub).toHaveLength(maxBids(true));
  });

  it("gives a new bid an id no remaining bid has, and removes and switches by id", () => {
    const less = removeBid(draftBids(1, 1), "b2");
    expect(less.map((b) => b.id)).toEqual(["b1", "b3"]);
    expect(addBid(less, GRID, 1, false)[2].id).toBe("b4");
    expect(switchBidder(less, "b1")[0].bidder).toBe("alice");
  });
});

describe("bidProblems", () => {
  it("blocks a draft that would raise nothing, or holds an amount that cannot be sent", () => {
    expect(bidProblems([], GRID).blocking).toMatch(/raises nothing/);
    expect(bidProblems([bid("a", 1.1, 0)], GRID).blocking).toMatch(/raises nothing/);
    expect(bidProblems([bid("a", 1.1, 1e-20)], GRID).blocking).toMatch(/rounds to nothing/);
    expect(bidProblems([bid("a", 1.1, 1e13)], GRID).blocking).toMatch(/can't be paid/);
    expect(bidProblems(draftBids(1, 1), GRID)).toEqual({ blocking: null, warning: null });
  });

  it("warns when two bids share a grid price", () => {
    expect(bidProblems([bid("a", 1.3, 1400), bid("b", 1.3, 1400, "alice")], GRID).warning).toMatch(/share a price/);
  });
});

describe("matchPlaced: which drafts a resumed launch already has in the auction", () => {
  const inAuction = (b: DraftBid) => ({ maxPrice: placedPrice(b.price, GRID), amount: bidWei(b.amount) });

  it("matches each bid the wallet has in the auction to one draft at the same price and amount", () => {
    const drafts = [bid("a", 1.02, 100), bid("b", 1.1, 50), bid("c", 1.3, 10)];
    expect(matchPlaced(drafts, [inAuction(drafts[2]), inAuction(drafts[0])], GRID)).toEqual(["a", "c"]);
  });

  it("matches two identical drafts only as often as the auction holds them", () => {
    const drafts = [bid("a", 1.1, 50), bid("b", 1.1, 50)];
    expect(matchPlaced(drafts, [inAuction(drafts[0])], GRID)).toEqual(["a"]);
    expect(matchPlaced(drafts, [inAuction(drafts[0]), inAuction(drafts[1])], GRID)).toEqual(["a", "b"]);
  });

  it("matches nothing for a different amount or price", () => {
    const drafts = [bid("a", 1.1, 50)];
    expect(matchPlaced(drafts, [{ maxPrice: placedPrice(1.1, GRID), amount: bidWei(49) }], GRID)).toEqual([]);
    expect(matchPlaced(drafts, [{ maxPrice: placedPrice(1.2, GRID), amount: bidWei(50) }], GRID)).toEqual([]);
  });
});
