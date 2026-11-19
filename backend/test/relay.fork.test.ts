// The relayer against the real deployed contracts, on a local fork of Base Sepolia, with a fresh key: Anvil's
// well-known keys carry live sweepers on Base Sepolia. Skipped when Anvil is not installed or RELAY_FORK_TEST is unset,
// since it needs Base Sepolia's RPC to fork from.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Address, encodeFunctionData, erc20Abi, parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePort, rpc } from "../src/playground/anvil";
import { Relayer } from "../src/relay/relayer";

const RECORDS = resolve(import.meta.dirname, "..", "..", "deployments");
const hasAnvil = (() => {
  try {
    execFileSync("anvil", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasAnvil || !process.env.RELAY_FORK_TEST)("the relayer on a fork of Base Sepolia", () => {
  let anvil: ChildProcess;
  let url = "";
  const key = generatePrivateKey();
  const runtime = JSON.parse(readFileSync(resolve(RECORDS, "84532.runtime.json"), "utf8")) as { launches: { token: Address; symbol: string }[] };
  const manifest = JSON.parse(readFileSync(resolve(RECORDS, "84532.json"), "utf8")) as { deployer: Address };
  const token = runtime.launches[0].token;

  beforeAll(async () => {
    const port = await freePort();
    url = `http://127.0.0.1:${port}`;
    anvil = spawn("anvil", ["--fork-url", process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org", "--port", String(port), "--silent", "--max-persisted-states", "0"], { stdio: "ignore" });
    for (let i = 0; i < 120; i++) {
      if (await rpc(url, "eth_chainId", [], 1_000).then(() => true, () => false)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const me = privateKeyToAccount(key).address;
    await rpc(url, "anvil_setBalance", [me, toHex(parseEther("1"))]);
    // Tokens to sell and drip: the deployer hands some over, impersonated on the fork only.
    await rpc(url, "anvil_impersonateAccount", [manifest.deployer]);
    await rpc(url, "eth_sendTransaction", [{ from: manifest.deployer, to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [me, parseEther("10")] }) }]);
  }, 120_000);
  afterAll(() => {
    anvil?.kill("SIGTERM");
  });

  it("pokes, sells, buys and drips for real, and refuses a restore the vault does not need", async () => {
    const r = new Relayer({ key, rpc: url, records: RECORDS, dailyEth: 0.05, dripEth: 0.002, dripTokens: 2 });
    expect((await r.handle("poke", "", "1")).status).toBe("success");
    expect((await r.handle("sell", "", "2")).status).toBe("success");
    expect((await r.handle("buy", "", "3")).status).toBe("success");
    const to = privateKeyToAccount(generatePrivateKey()).address;
    expect((await r.handle("drip", JSON.stringify({ to }), "4")).status).toBe("success");
    expect(BigInt(await rpc<string>(url, "eth_getBalance", [to, "latest"]))).toBe(parseEther("0.002"));
    await expect(r.handle("restore", JSON.stringify({ indices: [0] }), "5")).rejects.toMatchObject({ status: 409 });
  }, 240_000);
});
