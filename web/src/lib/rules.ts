/** The covenant's rules, as the landing page explains them, each with the attack from the lab that it stops. */
export const RULES = [
  {
    key: "conservation",
    name: "Conservation",
    line: "Reshape, never take.",
    body: "A reshape puts back everything it lifts; even leaving more than 0.1% of it idle is refused. Liquidity can move along the price axis. It cannot leave.",
    attack: "skim",
  },
  {
    key: "support",
    name: "Support",
    line: "Buy support stays near the price.",
    body: "A fixed share of the vault's quote must bid in a band just under the time-weighted price. Parking it far away, the soft rug, is refused. A rally never breaks it: asks the vault sold count as support.",
    attack: "softrug",
  },
  {
    key: "pace",
    name: "Pace",
    line: "No sudden moves.",
    body: "Only a fixed share of the vault's value can move per epoch, from an allowance that refills over time, and replacing the curator waits out a timelock. Holders always have time to see what is happening.",
    attack: "pace",
  },
  {
    key: "guard",
    name: "Guard",
    line: "No acting on a manipulated price.",
    body: "If spot has strayed from the time-weighted price, reshapes, restores and deposits are refused until the price has held for the window. Exits never are, so nobody can freeze them.",
    attack: "manipulate",
  },
  {
    key: "anchor",
    name: "Anchor",
    line: "No bid chases a pump.",
    body: "No bid may sit above the Anchor plus the guard. The Anchor follows a drop at once but climbs at most one band per epoch, and restore never bids above where the vault has sold. Pushing the price through empty ticks buys nothing.",
    attack: "pump-quick",
  },
] as const;
