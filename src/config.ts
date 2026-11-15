import type { Address, Hex } from "viem";
import { parsePriceSpec, type PriceGuard, type PriceSpec } from "./prices.ts";
import { BPS, MICRO, parseDecimal } from "./units.ts";

export type TokenConfig = { address: Address; price: PriceSpec; guard: PriceGuard };

export type Config = {
  chainId: number;
  rpcUrl: string;
  escrow: Address;
  startBlock: bigint;
  confirmations: bigint;
  maxBlockRange: bigint;
  operatorPrivateKey: Hex;
  openrouter: { provisioningKey: string; baseUrl: string };
  tokens: TokenConfig[];
  /** What a user pays over provider cost, in basis points. 10000 is cost price; 12000 adds 20%. */
  markupBps: bigint;
  minTabMicros: bigint;
  maxTabMicros: bigint;
  /** OpenRouter credit the server never hands out, as headroom for late bills. */
  creditBufferMicros: bigint;
  /** How long a disabled key waits before its usage is final: in-flight requests can still bill. */
  settleDelayMs: number;
  /** How often charges for open tabs are posted on chain, so a forced exit still pays for usage. */
  chargeIntervalMs: number;
  usagePollMs: number;
  workerIntervalMs: number;
  /** Shown in claim messages, so a wallet shows which server a signature is for. */
  publicUrl: string;
  keyNamePrefix: string;
  databasePath: string;
  host: string;
  port: number;
  corsOrigins: string[];
};

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env): Config {
  const read = (name: string, fallback?: string): string => {
    const value = env[name]?.trim();
    if (value) return value;
    if (fallback !== undefined) return fallback;
    throw new Error(`${name} is required`);
  };
  const whole = (name: string, fallback?: number): number => {
    const value = Number(read(name, fallback?.toString()));
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative whole number`);
    return value;
  };
  const address = (name: string): Address => {
    const value = read(name);
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${name} must be an address`);
    return value.toLowerCase() as Address;
  };
  const usd = (name: string, fallback: string) => parseDecimal(read(name, fallback), 6, name);

  const chainId = whole("CHAIN_ID");
  const local = chainId === 31337;
  const startBlock = BigInt(whole("ESCROW_START_BLOCK", local ? 0 : undefined));

  const operatorPrivateKey = read("OPERATOR_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(operatorPrivateKey)) throw new Error("OPERATOR_PRIVATE_KEY must be a 32-byte hex key");

  const config: Config = {
    chainId,
    rpcUrl: read("RPC_URL"),
    escrow: address("ESCROW_ADDRESS"),
    startBlock,
    confirmations: BigInt(whole("CONFIRMATIONS", local ? 0 : 3)),
    maxBlockRange: BigInt(whole("MAX_BLOCK_RANGE", 2000)),
    operatorPrivateKey: operatorPrivateKey as Hex,
    openrouter: {
      provisioningKey: read("OPENROUTER_PROVISIONING_KEY"),
      baseUrl: read("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
    },
    tokens: parseTokens(read("TOKENS")),
    markupBps: BigInt(whole("MARKUP_BPS", 10_000)),
    minTabMicros: usd("MIN_TAB_USD", "1"),
    maxTabMicros: usd("MAX_TAB_USD", "100"),
    creditBufferMicros: usd("CREDIT_BUFFER_USD", "0"),
    settleDelayMs: whole("SETTLE_DELAY_SECONDS", 120) * 1000,
    chargeIntervalMs: whole("CHARGE_INTERVAL_SECONDS", 600) * 1000,
    usagePollMs: whole("USAGE_POLL_SECONDS", 30) * 1000,
    workerIntervalMs: whole("WORKER_INTERVAL_MS", 5000),
    publicUrl: read("PUBLIC_URL", `http://localhost:${read("PORT", "8787")}`).replace(/\/+$/, ""),
    keyNamePrefix: read("KEY_NAME_PREFIX", "tab"),
    databasePath: read("DATABASE_PATH", "data/tab.db"),
    host: read("HOST", "127.0.0.1"),
    port: whole("PORT", 8787),
    corsOrigins: read("CORS_ORIGINS", "").split(",").map((o) => o.trim()).filter(Boolean),
  };
  if (config.markupBps < BPS) throw new Error("MARKUP_BPS below 10000 would sell inference below cost");
  if (config.minTabMicros === 0n || config.maxTabMicros < config.minTabMicros) throw new Error("MIN_TAB_USD must be positive and at most MAX_TAB_USD");
  if (config.maxTabMicros > 1_000_000n * MICRO) throw new Error("MAX_TAB_USD is unreasonably large");
  if (config.maxBlockRange === 0n) throw new Error("MAX_BLOCK_RANGE must be positive");
  return config;
}

/**
 * TOKENS is a JSON list of the tokens this server prices:
 *   [{ "address": "0x…", "price": <price spec>, "floor": "0.5", "ceiling": "2" }]
 * See src/prices.ts for price specs. Floor and ceiling are optional USD bounds.
 */
export function parseTokens(json: string): TokenConfig[] {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw new Error("TOKENS must be JSON"); }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("TOKENS must list at least one token");
  const seen = new Set<string>();
  return parsed.map((entry, i) => {
    const where = `TOKENS[${i}]`;
    if (!entry || typeof entry !== "object" || typeof entry.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(entry.address)) {
      throw new Error(`${where} needs an address`);
    }
    const address = entry.address.toLowerCase() as Address;
    if (seen.has(address)) throw new Error(`${where} repeats ${address}`);
    seen.add(address);
    const bound = (key: "floor" | "ceiling") => (entry[key] === undefined ? null : parseDecimal(String(entry[key]), 18, `${where}.${key}`));
    const guard = { floorE18: bound("floor"), ceilingE18: bound("ceiling") };
    if (guard.floorE18 !== null && guard.ceilingE18 !== null && guard.ceilingE18 < guard.floorE18) throw new Error(`${where}.ceiling is below its floor`);
    const price = parsePriceSpec(entry.price, `${where}.price`);
    // A thin pool can be pushed for a whole TWAP window, and a user picks when to claim.
    if (price.kind === "uniswapV3" && (guard.floorE18 === null || guard.ceilingE18 === null)) {
      throw new Error(`${where} is priced from a pool, so it needs a USD floor and ceiling`);
    }
    return { address, price, guard };
  });
}
