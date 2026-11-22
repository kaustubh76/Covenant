// The top bar's menu, as data: the guided demo and the vault side by side, and every other page under Explore with a
// line on what it is, from that page's own heading. The Playground sits between them; it is a chain, not a page
// (AppShell). Kept apart from AppShell so a test can check that every page is in it.

export interface NavItem {
  href: string;
  label: string;
}

export interface ExploreItem extends NavItem {
  about: string;
}

export const PRIMARY: readonly NavItem[] = [
  { href: "/demo", label: "Demo" },
  { href: "/vault", label: "Vault" },
];

export const EXPLORE: readonly ExploreItem[] = [
  { href: "/launch", label: "Launch", about: "Write the terms, then run the auction" },
  { href: "/curate", label: "Curate", about: "Reshape the liquidity, simulated first" },
  { href: "/keep", label: "Keep", about: "Bring support back after a sell-off" },
  { href: "/provide", label: "Provide", about: "Add liquidity beside the issuer's" },
  { href: "/govern", label: "Govern", about: "Few powers, each slow or harmless" },
  { href: "/attacks", label: "Attack lab", about: "Try to take the liquidity" },
  { href: "/ledger", label: "Ledger", about: "Every recorded move, on chain" },
];
