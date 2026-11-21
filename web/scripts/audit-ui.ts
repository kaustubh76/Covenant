// npm run audit:ui [-- --url https://covenant-uhi11.vercel.app] [--vaults CVNT,CVLP,CVQ] [--rpc <url>]
//
// Read-only, no wallet. Opens the app's pages on Base Sepolia for each live vault, and checks every figure the pages
// mark with `data-fact` (lib/fact.ts) against a direct read of the contracts at the block the page read it at. Also
// fails on placeholder text ("TOKEN", "NaN", "undefined"), on page errors, and on a page that shows fewer marked figures
// than it should. Relay POSTs are blocked: the audit never sends anything. Uses the system Chrome (playwright-core).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { type Address, type Hex, createPublicClient, encodePacked, formatEther, http, keccak256, pad, zeroAddress } from "viem";
import { baseSepolia } from "viem/chains";
import { covenantHookAbi, covenantVaultAbi, poolManagerAbi, testTokenAbi } from "../src/chain/abi.generated";

const argv = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const URL_BASE = opt("url", "https://covenant-uhi11.vercel.app").replace(/\/$/, "");
const RPC = opt("rpc", process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org");
const DEPLOYMENTS = join(process.cwd(), "..", "deployments");
const manifest = JSON.parse(readFileSync(join(DEPLOYMENTS, "84532.json"), "utf8")) as Record<string, string>;
const runtime = JSON.parse(readFileSync(join(DEPLOYMENTS, "84532.runtime.json"), "utf8")) as { launches: { vault: Address; symbol: string }[] };
const wanted = opt("vaults", runtime.launches.map((l) => l.symbol).join(",")).split(",");
const VAULTS = runtime.launches.filter((l) => wanted.includes(l.symbol));
/** Self-test: `--tamper <key>` alters what the page shows for that key before it is checked, which must then fail. */
const TAMPER = opt("tamper", "");

const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC, { retryCount: 4, retryDelay: 600, batch: { batchSize: 20, wait: 20 } }) });

/** A page to open, as which role (the role decides which panels show), and the fewest marked figures it must show. */
const PAGES: { path: string; role?: string; min: number }[] = [
  { path: "/govern", min: 10 },
  { path: "/provide", role: "issuer", min: 4 },
];

type Fact = { key: string; raw: string; block: string | null };
const f = (x: bigint) => Number(formatEther(x));

/** The expected raw value of each fact key, read from the contracts at `block`; null for a key with no verifier. */
async function expected(vault: Address, key: string, block: bigint): Promise<string | null> {
  const at = { blockNumber: block };
  const r = <T>(functionName: string, args: readonly unknown[] = []) =>
    pub.readContract({ address: vault, abi: covenantVaultAbi, functionName, args, ...at } as never) as Promise<T>;
  const q0 = await r<boolean>("quoteIsCurrency0");
  const split = async (fn0: string, fn1: string, args: readonly unknown[] = []) => {
    const [a0, a1] = await Promise.all([r<bigint>(fn0, args), r<bigint>(fn1, args)]);
    return q0 ? { quote: f(a0), token: f(a1) } : { quote: f(a1), token: f(a0) };
  };
  const addr = (a: Address) => (a === zeroAddress ? "" : a.toLowerCase());
  const [base, sub] = key.split(":");
  switch (base) {
    case "vault.supportBps":
      return String((await r<readonly [bigint, bigint]>("support"))[0]);
    case "vault.supportNeedBps":
      return String((await r<readonly [bigint, bigint]>("support"))[1]);
    case "vault.totalValue":
      return String(f(await r<bigint>("totalValue")));
    case "vault.totalShares":
      return String(await r<bigint>("totalShares"));
    case "vault.bountyPool":
      return String(f(await r<bigint>("bountyPool")));
    case "vault.feePot.quote":
    case "vault.feePot.token":
      return String((await split("feePot0", "feePot1"))[base.endsWith("quote") ? "quote" : "token"]);
    case "vault.principalOwed.quote":
    case "vault.principalOwed.token": {
      const [a0, a1] = await r<readonly [bigint, bigint]>("feesOwed", [zeroAddress]);
      const o = q0 ? { quote: f(a0), token: f(a1) } : { quote: f(a1), token: f(a0) };
      return String(o[base.endsWith("quote") ? "quote" : "token"]);
    }
    case "vault.curatorFees.quote":
    case "vault.curatorFees.token": {
      const curator = await r<Address>("curator");
      return String((await split("curatorFees0", "curatorFees1", [curator]))[base.endsWith("quote") ? "quote" : "token"]);
    }
    case "vault.curator":
    case "vault.issuer":
    case "vault.treasury":
    case "vault.pendingCurator":
    case "vault.pendingIssuer":
      return addr(await r<Address>(base.slice("vault.".length)));
    case "vault.principalWithdrawable":
      return String(await r<bigint>("principalWithdrawable"));
    case "vault.vested": {
      const [w, done] = await Promise.all([r<bigint>("principalWithdrawable"), r<bigint>("principalWithdrawn")]);
      return String(Number(w + done) / 1e18);
    }
    case "vault.unlockStartsAt": {
      const [adoptedAt, terms] = await Promise.all([r<bigint>("adoptedAt"), r<{ lockDuration: number | bigint }>("terms")]);
      return String(Number(adoptedAt) + Number(terms.lockDuration));
    }
    case "vault.anchor":
      return String(await r<number>("anchor"));
    case "vault.rangeCount":
      return String(await r<bigint>("rangeCount"));
    case "vault.sharesOf":
      return String(await r<bigint>("sharesOf", [sub as Address]));
    case "vault.guardGap": {
      const [poolId, terms] = await Promise.all([r<Hex>("poolId"), r<{ twapWindow: number }>("terms")]);
      const slot = keccak256(encodePacked(["bytes32", "bytes32"], [poolId, pad("0x06", { size: 32 })]));
      const word = BigInt(await pub.readContract({ address: manifest.poolManager as Address, abi: poolManagerAbi, functionName: "extsload", args: [slot], ...at }));
      const raw24 = Number((word >> 160n) & 0xffffffn);
      const spot = raw24 >= 0x800000 ? raw24 - 0x1000000 : raw24;
      const twap = await pub.readContract({ address: manifest.hook as Address, abi: covenantHookAbi, functionName: "consult", args: [poolId, Number(terms.twapWindow)], ...at });
      return String(Math.abs(spot - twap));
    }
    case "token.symbol": {
      const key = await r<{ currency0: Address; currency1: Address }>("poolKey");
      return await pub.readContract({ address: q0 ? key.currency1 : key.currency0, abi: testTokenAbi, functionName: "symbol" });
    }
    default:
      if (base.startsWith("vault.terms.")) {
        const terms = await r<Record<string, number | bigint>>("terms");
        const field = base.slice("vault.terms.".length);
        return field in terms ? String(terms[field]) : null;
      }
      return null;
  }
}

/** Raw values match when equal as text, or, for decimals, within float rounding of each other. */
function same(raw: string, want: string): boolean {
  if (raw.toLowerCase() === want.toLowerCase()) return true;
  const a = Number(raw);
  const b = Number(want);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b));
}

async function main() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const failures: string[] = [];
  let checkedFacts = 0;
  let relayBlocked = 0;
  for (const v of VAULTS) {
    for (const page of PAGES) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      await ctx.addInitScript(
        ([vault, role]) => {
          try {
            localStorage.setItem("covenant.vault.base-sepolia", vault);
            if (role) localStorage.setItem("covenant.role", role);
          } catch {
            /* storage blocked */
          }
        },
        [v.vault, page.role ?? ""] as const,
      );
      await ctx.route(/\/v1\/relay\//, (route) => {
        if (route.request().method() !== "POST") return route.continue();
        relayBlocked++;
        return route.abort();
      });
      const p = await ctx.newPage();
      const errors: string[] = [];
      p.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
      const where = `${v.symbol} ${page.path}${page.role ? ` as ${page.role}` : ""}`;
      try {
        await p.goto(`${URL_BASE}${page.path}?net=base-sepolia`, { waitUntil: "domcontentloaded", timeout: 300_000 });
        // until the marked figures stop changing in number: the page has read the chain
        let last = -1;
        let steady = 0;
        for (let i = 0; i < 120 && steady < 3; i++) {
          await p.waitForTimeout(1000);
          const n = await p.locator("[data-fact]").count();
          steady = n === last && n > 0 ? steady + 1 : 0;
          last = n;
        }
        const facts = (await p.$$eval("[data-fact]", (els) =>
          els.map((e) => ({ key: e.getAttribute("data-fact") ?? "", raw: e.getAttribute("data-raw") ?? "", block: e.getAttribute("data-block") })),
        )) as Fact[];
        for (const fct of facts) if (TAMPER && fct.key === TAMPER) fct.raw = Number.isFinite(Number(fct.raw)) && fct.raw !== "" ? String(Number(fct.raw) * 2 + 1) : `${fct.raw}x`;
        if (facts.length < page.min) failures.push(`${where}: ${facts.length} marked figures, expected at least ${page.min}`);
        for (const fct of facts) {
          if (!fct.block) {
            failures.push(`${where}: ${fct.key} carries no block`);
            continue;
          }
          const want = await expected(v.vault, fct.key, BigInt(fct.block));
          checkedFacts++;
          if (want === null) failures.push(`${where}: no verifier for ${fct.key}`);
          else if (!same(fct.raw, want)) failures.push(`${where}: ${fct.key} shows ${fct.raw}, the chain has ${want} at block ${fct.block}`);
        }
        const text = await p.evaluate(() => document.body.innerText);
        for (const bad of [/\bTOKEN\b/, /\bNaN\b/, /\bundefined\b/, /\bInfinity\b/]) if (bad.test(text)) failures.push(`${where}: placeholder text ${bad} on the page`);
        if (errors.length) failures.push(`${where}: page errors: ${errors.join(" | ")}`);
        console.log(`  ${where}: ${facts.length} figures checked`);
      } catch (e) {
        failures.push(`${where}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
      } finally {
        await ctx.close();
      }
    }
  }
  await browser.close();
  console.log(`audit:ui of ${URL_BASE} against ${RPC}: ${checkedFacts} figures, ${VAULTS.length} vaults, ${PAGES.length} pages each, ${relayBlocked} relay POSTs blocked`);
  if (failures.length) {
    console.log(`\n${failures.length} problem${failures.length === 1 ? "" : "s"}:`);
    for (const x of failures) console.log(`  ✗ ${x}`);
    process.exit(1);
  }
  console.log("  ✓ every marked figure equals the contracts' own state at its block; no placeholders, no page errors");
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
