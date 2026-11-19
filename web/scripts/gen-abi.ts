// Generates src/chain/abi.generated.ts from the Foundry artifacts in ../out (run `forge build` in the repo root first).
//
//   npm run abi
//
// Each contract export keeps only the functions and events the app uses. Every custom error from every contract and
// library a call can reach (Covenant, Uniswap v4, the CCA, the launcher, OpenZeppelin) goes into one merged
// `errorAbi`, so a revert from anywhere in a call decodes to its name and arguments.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type AbiItem = { type: string; name?: string; inputs?: AbiParam[]; [k: string]: unknown };
type AbiParam = { type: string; components?: AbiParam[]; [k: string]: unknown };

const OUT = resolve(process.cwd(), process.env.COVENANT_OUT_DIR ?? "../out");
const TARGET = resolve(process.cwd(), "src/chain/abi.generated.ts");

interface Spec {
  exportName: string;
  artifact: string;
  functions: string[] | "*";
  events: string[] | "*";
  bytecode?: boolean;
}

const CONTRACTS: Spec[] = [
  { exportName: "covenantVaultAbi", artifact: "CovenantVault.sol/CovenantVault.json", functions: "*", events: "*" },
  { exportName: "covenantFactoryAbi", artifact: "CovenantFactory.sol/CovenantFactory.json", functions: "*", events: "*" },
  {
    exportName: "covenantHookAbi",
    artifact: "CovenantHook.sol/CovenantHook.json",
    functions: ["consult", "recordedTick", "poolInfo", "MAX_WINDOW", "maxTickRate", "authorized"],
    events: [],
  },
  { exportName: "covenantLensAbi", artifact: "CovenantLens.sol/CovenantLens.json", functions: "*", events: [] },
  { exportName: "seedPlannerAbi", artifact: "SeedPlanner.sol/SeedPlanner.json", functions: "*", events: [] },
  {
    exportName: "lbpStrategyAbi",
    artifact: "LBPStrategy.sol/LBPStrategy.json",
    functions: ["initializeDistribution", "migrate", "registeredPoolIds", "initializers", "initializerFactory"],
    events: "*",
  },
  {
    exportName: "ccaAbi",
    artifact: "ContinuousClearingAuction.sol/ContinuousClearingAuction.json",
    functions: [
      "submitBid",
      "checkpoint",
      "clearingPrice",
      "floorPrice",
      "tickSpacing",
      "startBlock",
      "endBlock",
      "claimBlock",
      "currencyRaised",
      "totalCleared",
      "totalSupply",
      "isGraduated",
      "ticks",
      "nextActiveTickPrice",
      "nextBidId",
      "bids",
      "token",
      "currency",
      "remainingSupply",
      // after the auction: refunds, token claims and sweeps (a public launch recovers its outbid bids' ETH)
      "checkpoints",
      "lastCheckpointedBlock",
      "exitBid",
      "exitPartiallyFilledBid",
      "claimTokens",
      "sweepUnsoldTokens",
      // the treasury's sweep: who may send it, and whether it has been
      "sweepUnsoldTokensBlock",
      "tokensRecipient",
    ],
    events: "*",
  },
  { exportName: "poolSwapTestAbi", artifact: "PoolSwapTest.sol/PoolSwapTest.json", functions: ["swap"], events: [] },
  {
    exportName: "liquidityRouterAbi",
    artifact: "PoolModifyLiquidityTestNoChecks.sol/PoolModifyLiquidityTestNoChecks.json",
    functions: ["modifyLiquidity"],
    events: [],
  },
  {
    exportName: "poolManagerAbi",
    artifact: "PoolManager.sol/PoolManager.json",
    functions: ["extsload"],
    events: ["Initialize", "Swap", "ModifyLiquidity"],
  },
  {
    exportName: "positionManagerAbi",
    artifact: "PositionManager.sol/PositionManager.json",
    functions: ["nextTokenId", "ownerOf", "getPositionLiquidity"],
    // the NFTs a migration minted to a vault, read from its receipt (on a shared chain others mint in between)
    events: ["Transfer"],
  },
  { exportName: "testTokenAbi", artifact: "TestToken.sol/TestToken.json", functions: "*", events: "*", bytecode: true },
  // the fixed-supply token a public launch sells (script/tokens/LaunchToken.sol)
  { exportName: "launchTokenAbi", artifact: "LaunchToken.sol/LaunchToken.json", functions: "*", events: [], bytecode: true },
];

// Contracts and libraries whose errors can surface inside a call the app makes.
const ERROR_SOURCES = [
  "VaultOps.sol/VaultOps.json",
  "CovenantLogic.sol/CovenantLogic.json",
  "TermsLib.sol/TermsLib.json",
  "TwapOracle.sol/TwapOracle.json",
  "CustomRevert.sol/CustomRevert.json",
  "Hooks.sol/Hooks.json",
  "Pool.sol/Pool.json",
  "Currency.sol/CurrencyLibrary.json",
  "TickMath.sol/TickMath.json",
  "SafeCast.sol/SafeCast.json",
  "DeltaResolver.sol/DeltaResolver.json",
  "TokenPricing.sol/TokenPricing.json",
  "MigratorParams.sol/MigratorParams.json",
  "PositionPlanner.sol/PositionPlanner.json",
  "BidLib.sol/BidLib.json",
  "TickStorage.sol/TickStorage.json",
  "StepStorage.sol/StepStorage.json",
  "draft-IERC6093.sol/IERC20Errors.json",
];

function load(artifact: string): { abi: AbiItem[]; bytecode?: { object: string } } {
  const p = join(OUT, artifact);
  if (!existsSync(p)) throw new Error(`missing artifact ${p}: run \`forge build\` in the repository root first`);
  return JSON.parse(readFileSync(p, "utf8"));
}

const typeOf = (p: AbiParam): string => (p.components ? `(${p.components.map(typeOf).join(",")})${p.type.slice(5)}` : p.type);
const signature = (e: AbiItem) => `${e.name}(${(e.inputs ?? []).map(typeOf).join(",")})`;

const pick = (abi: AbiItem[], kind: "function" | "event", which: string[] | "*") =>
  abi.filter((e) => e.type === kind && (which === "*" || which.includes(e.name ?? "")));

const errors = new Map<string, AbiItem>();
const addErrors = (abi: AbiItem[]) => {
  for (const e of abi) if (e.type === "error" && !errors.has(signature(e))) errors.set(signature(e), e);
};

const line = (e: AbiItem) => `  ${JSON.stringify(e)},`;
const chunks: string[] = [
  "// Generated by scripts/gen-abi.ts from the Foundry artifacts in ../out. Do not edit: run `npm run abi`.",
  "",
];

for (const spec of CONTRACTS) {
  const art = load(spec.artifact);
  addErrors(art.abi);
  const items = [
    // contracts the app deploys need their constructor to encode deploy data
    ...(spec.bytecode ? art.abi.filter((e) => e.type === "constructor") : []),
    ...pick(art.abi, "function", spec.functions),
    ...pick(art.abi, "event", spec.events),
  ];
  if (spec.functions !== "*") {
    for (const name of spec.functions) {
      if (!items.some((e) => e.type === "function" && e.name === name)) throw new Error(`${spec.artifact}: no function ${name}`);
    }
  }
  chunks.push(`export const ${spec.exportName} = [`, ...items.map(line), "] as const;", "");
  if (spec.bytecode) {
    const code = art.bytecode?.object;
    if (!code || !code.startsWith("0x")) throw new Error(`${spec.artifact}: no bytecode`);
    chunks.push(`export const ${spec.exportName.replace(/Abi$/, "Bytecode")} = "${code}" as const;`, "");
  }
}

for (const source of ERROR_SOURCES) {
  if (!existsSync(join(OUT, source))) {
    console.warn(`gen-abi: skipping missing error source ${source}`);
    continue;
  }
  addErrors(load(source).abi);
}
const merged = [...errors.values()].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
chunks.push("/** Every custom error a call made by the app can revert with. */", "export const errorAbi = [", ...merged.map(line), "] as const;", "");

writeFileSync(TARGET, chunks.join("\n"));
console.log(`gen-abi: wrote ${CONTRACTS.length} contract ABIs and ${merged.length} errors to ${TARGET}`);
