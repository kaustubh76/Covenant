// The relayer: real Base Sepolia transactions for visitors without a wallet, from the backend's own small, separately
// funded key (RELAYER_PRIVATE_KEY, a Render secret; never the deployer's). It sends only a fixed list of actions, built
// here from validated fields, never calldata from the caller. Each is simulated first and sent only if the simulation
// passes. Calls per address are limited, a drip goes once a day per address, and a daily ETH budget caps it all.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Abi,
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  type Hex,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  isAddress,
  maxUint256,
  parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { covenantLensAbi, covenantVaultAbi, poolSwapTestAbi, testTokenAbi } from "../../../web/src/chain/abi.generated";
import { MAX_SQRT_PRICE, MIN_SQRT_PRICE, sqrtPriceLimitAt, toPool } from "../../../web/src/chain/price";
import { Buckets, HttpError } from "../http";

export const RELAY_ACTIONS = ["poke", "collectFees", "restore", "sell", "buy", "drip"] as const;
export type RelayAction = (typeof RELAY_ACTIONS)[number];
const NEVER = 2n ** 256n - 1n;
/** About +1% in price ticks (ln 1.01 / ln 1.0001): far inside any vault's guard. */
const ONE_PCT_TICKS = 100;

export interface RelayOptions {
  key: Hex | null;
  rpc: string;
  /** Where deployments/84532.json and 84532.runtime.json are. */
  records: string;
  dailyEth: number;
  dripEth: number;
  dripTokens: number;
  now?: () => number;
  /** For tests: clients to use instead of ones built from `rpc` and `key`. */
  clients?: { pub: PublicClient; wallet: WalletClient };
}

interface Launch {
  vault: Address;
  token: Address;
  symbol: string;
}
interface Call {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
}
type Step = { title: string; call: Call } | { title: string; transfer: { to: Address; value: bigint } };

export interface Relayed {
  title: string;
  hash: Hex;
  hashes: Hex[];
  status: "success" | "reverted" | "pending";
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The revert a simulation hit, as the contract named it: "SupportBroken(277, 4000)". */
function reason(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (r?.data?.errorName) return `${r.data.errorName}(${(r.data.args ?? []).map(String).join(", ")})`;
    return e.shortMessage;
  }
  return e instanceof Error ? e.message.split("\n")[0] : String(e);
}

export class Relayer {
  private readonly o: RelayOptions;
  private readonly pub: PublicClient | null = null;
  private readonly wallet: WalletClient | null = null;
  readonly address: Address | null = null;
  private readonly manifest: { swapRouter?: Address; lens: Address };
  private readonly launches: Launch[];
  private readonly defaultVault: Address;
  private readonly perIp: Buckets;
  private readonly dripped = new Map<string, number>();
  /** Sends go one at a time: one key, one nonce sequence. */
  private queue: Promise<unknown> = Promise.resolve();
  private spent = { day: "", wei: 0n };

  constructor(o: RelayOptions) {
    this.o = o;
    const manifest = JSON.parse(readFileSync(join(o.records, "84532.json"), "utf8")) as { swapRouter?: Address; lens: Address };
    const runtime = JSON.parse(readFileSync(join(o.records, "84532.runtime.json"), "utf8")) as { defaultVault: Address; launches: Launch[] };
    this.manifest = manifest;
    this.launches = runtime.launches;
    this.defaultVault = runtime.defaultVault;
    this.perIp = new Buckets(10 / 3600, 10, o.now);
    if (o.clients) {
      this.pub = o.clients.pub;
      this.wallet = o.clients.wallet;
      this.address = o.clients.wallet.account?.address ?? null;
    } else if (o.key) {
      const account = privateKeyToAccount(o.key);
      this.address = account.address;
      this.pub = createPublicClient({ chain: baseSepolia, transport: http(o.rpc, { retryCount: 3 }) }) as PublicClient;
      this.wallet = createWalletClient({ chain: baseSepolia, transport: http(o.rpc, { retryCount: 3 }), account });
    }
  }

  get enabled(): boolean {
    return !!this.pub && !!this.wallet && !!this.address;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** What the app shows: whether the relayer runs, from which address, and what is left of today's budget. */
  async status() {
    if (!this.enabled) return { enabled: false };
    const balance = await this.pub!.getBalance({ address: this.address! }).catch(() => null);
    this.rollDay();
    return {
      enabled: true,
      address: this.address,
      balanceEth: balance === null ? null : Number(formatEther(balance)),
      spentTodayEth: Number(formatEther(this.spent.wei)),
      dailyBudgetEth: this.o.dailyEth,
      actions: RELAY_ACTIONS,
    };
  }

  private rollDay() {
    const today = day(this.now());
    if (this.spent.day !== today) this.spent = { day: today, wei: 0n };
  }

  private launchOf(vault: unknown): Launch {
    const v = typeof vault === "string" && isAddress(vault) ? vault.toLowerCase() : vault === undefined ? this.defaultVault.toLowerCase() : null;
    const launch = v ? this.launches.find((l) => l.vault.toLowerCase() === v) : undefined;
    if (!launch) throw new HttpError(400, "Name one of Base Sepolia's recorded vaults.");
    return launch;
  }

  /** Validate, rate-limit and budget a request, build its steps, simulate each, then send them in order. */
  async handle(action: string, raw: string, ip: string): Promise<Relayed> {
    if (!this.enabled) throw new HttpError(503, "The relayer is not set up on this backend.");
    if (!(RELAY_ACTIONS as readonly string[]).includes(action)) throw new HttpError(404, `No relay action ${action}.`);
    let body: { vault?: unknown; to?: unknown; indices?: unknown };
    try {
      body = raw ? (JSON.parse(raw) as typeof body) : {};
    } catch {
      throw new HttpError(400, "The body is not JSON.");
    }
    if (!body || typeof body !== "object") throw new HttpError(400, "The body must be a JSON object.");
    const launch = this.launchOf(body.vault);

    if (action === "drip") {
      const to = typeof body.to === "string" && isAddress(body.to) ? (body.to as Address) : null;
      if (!to) throw new HttpError(400, "Name the address to send test funds to.");
      const t = this.now();
      for (const k of [`a:${to.toLowerCase()}`, `i:${ip}`]) {
        const last = this.dripped.get(k);
        if (last !== undefined && t - last < 24 * 3600_000) throw new HttpError(429, "Test funds go once a day per address. Try again tomorrow.", { "retry-after": "3600" });
      }
    }
    if (!this.perIp.take(ip)) throw new HttpError(429, "Ten relayed actions an hour per address. Try again later, or connect a wallet.", { "retry-after": "600" });

    const steps = await this.steps(action as RelayAction, launch, body);
    this.rollDay();
    const outlay = steps.reduce((s, x) => s + ("transfer" in x ? x.transfer.value : (x.call.value ?? 0n)), 0n) + parseEther("0.0002") * BigInt(steps.length);
    if (this.spent.wei + outlay > parseEther(String(this.o.dailyEth))) throw new HttpError(503, "The relayer has spent today's budget. Connect a wallet, or try the Playground.");

    const run = this.queue.then(() => this.send(steps));
    this.queue = run.catch(() => undefined);
    const out = await run;
    if (action === "drip") {
      const t = this.now();
      this.dripped.set(`a:${String(body.to).toLowerCase()}`, t);
      this.dripped.set(`i:${ip}`, t);
    }
    return out;
  }

  /**
   * Each step is simulated just before it is sent, on the chain as the earlier steps left it: a swap after its approval
   * is checked once the approval has landed. If the first step would revert, nothing is sent; if a later one would, the
   * earlier ones (an approval, say) have landed, and the answer says which.
   */
  private async send(steps: Step[]): Promise<Relayed> {
    const hashes: Hex[] = [];
    let status: Relayed["status"] = "success";
    for (const s of steps) {
      if ("call" in s) {
        try {
          await this.pub!.simulateContract({ ...s.call, account: this.address! } as never);
        } catch (e) {
          const sent = hashes.length ? ` Already sent: ${hashes.join(", ")}.` : " Nothing was sent.";
          throw new HttpError(409, `${s.title} would revert: ${reason(e)}.${sent}`);
        }
      }
      const hash =
        "call" in s
          ? await this.wallet!.writeContract({ ...s.call, account: this.wallet!.account!, chain: baseSepolia } as never)
          : await this.wallet!.sendTransaction({ to: s.transfer.to, value: s.transfer.value, account: this.wallet!.account!, chain: baseSepolia });
      hashes.push(hash);
      const receipt = await this.pub!.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 1_000 }).catch(() => null);
      if (!receipt) {
        status = "pending";
        break;
      }
      const value = "call" in s ? (s.call.value ?? 0n) : s.transfer.value;
      this.spent.wei += value + receipt.gasUsed * receipt.effectiveGasPrice;
      if (receipt.status !== "success") {
        status = "reverted";
        break;
      }
    }
    return { title: steps.map((s) => s.title).join(", then "), hash: hashes[hashes.length - 1], hashes, status };
  }

  private async steps(action: RelayAction, l: Launch, body: { to?: unknown; indices?: unknown }): Promise<Step[]> {
    const vault = (functionName: string, args: readonly unknown[]): Call => ({ address: l.vault, abi: covenantVaultAbi as Abi, functionName, args });
    switch (action) {
      case "poke":
        return [{ title: "Sync the Anchor (poke)", call: vault("poke", []) }];
      case "collectFees":
        return [{ title: "Collect the swap fees", call: vault("collectFees", []) }];
      case "restore": {
        const ix = body.indices;
        if (!Array.isArray(ix) || ix.length === 0 || ix.length > 16 || !ix.every((i) => Number.isInteger(i) && i >= 0 && i < 64) || new Set(ix).size !== ix.length) {
          throw new HttpError(400, "Name the ranges to restore: distinct indices.");
        }
        return [{ title: "Restore support, for the bounty", call: vault("restore", [ix.map((i: number) => BigInt(i)), NEVER]) }];
      }
      case "sell":
      case "buy": {
        const router = this.manifest.swapRouter;
        if (!router) throw new HttpError(503, "This deployment has no swap router on record.");
        const s = (await this.pub!.readContract({ address: this.manifest.lens, abi: covenantLensAbi, functionName: "snapshot", args: [l.vault] })) as {
          key: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
          quoteIsCurrency0: boolean;
          spotPrice: number;
        };
        const q0 = s.quoteIsCurrency0;
        if (action === "sell") {
          // One token in, as the market account: the price limit is the pool's bound, and one token moves it a hair.
          const amount = parseEther("1");
          const zeroForOne = !q0;
          const steps: Step[] = [];
          const allowance = (await this.pub!.readContract({ address: l.token, abi: testTokenAbi, functionName: "allowance", args: [this.address!, router] })) as bigint;
          if (allowance < amount) steps.push({ title: `Approve the router for ${l.symbol}`, call: { address: l.token, abi: testTokenAbi as Abi, functionName: "approve", args: [router, maxUint256] } });
          steps.push({
            title: `Sell 1 ${l.symbol}`,
            call: {
              address: router,
              abi: poolSwapTestAbi as Abi,
              functionName: "swap",
              args: [s.key, { zeroForOne, amountSpecified: -amount, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n }, { takeClaims: false, settleUsingBurn: false }, "0x"],
            },
          });
          return steps;
        }
        // Buy until the price is about 1% higher, paying in native ETH (always currency0); the router refunds what the
        // limit leaves unspent.
        if (!q0) throw new HttpError(503, "This pool's quote is not native ETH.");
        const limit = sqrtPriceLimitAt(toPool(q0, s.spotPrice + ONE_PCT_TICKS));
        const budget = parseEther("0.003");
        return [
          {
            title: `Buy ${l.symbol}, price +1%`,
            call: { address: router, abi: poolSwapTestAbi as Abi, functionName: "swap", args: [s.key, { zeroForOne: true, amountSpecified: -budget, sqrtPriceLimitX96: limit }, { takeClaims: false, settleUsingBurn: false }, "0x"], value: budget },
          },
        ];
      }
      case "drip": {
        const to = body.to as Address;
        return [
          { title: `Send ${this.o.dripEth} ETH`, transfer: { to, value: parseEther(String(this.o.dripEth)) } },
          { title: `Send ${this.o.dripTokens} ${l.symbol}`, call: { address: l.token, abi: testTokenAbi as Abi, functionName: "transfer", args: [to, parseEther(String(this.o.dripTokens))] } },
        ];
      }
    }
  }
}
