import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXPLORE, PRIMARY } from "./nav";

// The app's pages: each folder of src/app with a page.tsx. The landing (src/app/page.tsx) is the logo's link, and api/
// holds routes, not pages.
const app = fileURLToPath(new URL("../../app/", import.meta.url));
const pages = readdirSync(app, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(`${app}${d.name}/page.tsx`))
  .map((d) => `/${d.name}`)
  .sort();
const menu = [...PRIMARY, ...EXPLORE].map((n) => n.href);

describe("the top bar's menu", () => {
  it("finds the app's pages", () => {
    expect(pages).toContain("/vault");
    expect(pages).not.toContain("/api");
  });

  it("reaches every page, each once", () => {
    expect([...menu].sort()).toEqual(pages);
    expect(new Set(menu).size).toBe(menu.length);
  });

  it("keeps the bar to the demo and the vault", () => {
    expect(PRIMARY.map((n) => n.href)).toEqual(["/demo", "/vault"]);
  });

  it("says what each page under Explore is", () => {
    for (const n of EXPLORE) expect(n.about.length, n.href).toBeGreaterThan(0);
  });
});
