import type { Address } from "viem";
import { E18, parseDecimal, scaleByFloat } from "./units.ts";

/**
 * Where a token's USD price comes from. A pool price is quoted in the pool's
 * other token, so it names how to price that token in turn:
 *
 *   "1.00"                                               fixed
 *   { "chainlink": "0xFeed", "maxAgeSeconds": 3600 }     Chainlink-compatible USD feed
 *   { "uniswapV3": "0xPool", "twapSeconds": 1800,         time-weighted pool price,
 *     "quote": "1.00" | { "chainlink": "0x…" } | … }      times the other token's price
 */
export type PriceSpec =
  | { kind: "fixed"; usdE18: bigint }
  | { kind: "chainlink"; feed: Address; maxAgeSeconds: number }
  | { kind: "uniswapV3"; pool: Address; twapSeconds: number; quote: PriceSpec };

export type PriceGuard = { floorE18: bigint | null; ceilingE18: bigint | null };

/** Chain reads that price sources need. */
export interface PriceReader {
  decimals(token: Address): Promise<number>;
  feed(feed: Address): Promise<{ answer: bigint; decimals: number; updatedAt: bigint }>;
  pool(pool: Address, secondsAgo: number): Promise<{ token0: Address; token1: Address; tickCumulatives: [bigint, bigint] }>;
}

const isAddress = (value: unknown): value is Address => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);

export function parsePriceSpec(value: unknown, where = "price"): PriceSpec {
  if (typeof value === "string" || typeof value === "number") {
    const usdE18 = parseDecimal(String(value), 18, where);
    if (usdE18 === 0n) throw new Error(`${where} must be positive`);
    return { kind: "fixed", usdE18 };
  }
  if (value && typeof value === "object") {
    const spec = value as Record<string, unknown>;
    if ("chainlink" in spec) {
      if (!isAddress(spec.chainlink)) throw new Error(`${where}.chainlink must be an address`);
      return { kind: "chainlink", feed: spec.chainlink.toLowerCase() as Address, maxAgeSeconds: positive(spec.maxAgeSeconds ?? 3600, `${where}.maxAgeSeconds`) };
    }
    if ("uniswapV3" in spec) {
      if (!isAddress(spec.uniswapV3)) throw new Error(`${where}.uniswapV3 must be a pool address`);
      if (spec.quote === undefined) throw new Error(`${where}.quote must price the pool's other token`);
      const twapSeconds = positive(spec.twapSeconds ?? 1800, `${where}.twapSeconds`);
      if (twapSeconds > 2 ** 32 - 1) throw new Error(`${where}.twapSeconds is too long`);
      return { kind: "uniswapV3", pool: spec.uniswapV3.toLowerCase() as Address, twapSeconds, quote: parsePriceSpec(spec.quote, `${where}.quote`) };
    }
  }
  throw new Error(`${where} must be a USD amount, { "chainlink": … } or { "uniswapV3": …, "quote": … }`);
}

function positive(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive whole number`);
  return value;
}

/** Uniswap's average tick over a window, rounded toward negative infinity as its oracle library does. */
export function averageTick(tickCumulatives: [bigint, bigint], seconds: number): number {
  const delta = tickCumulatives[1] - tickCumulatives[0];
  const span = BigInt(seconds);
  let tick = delta / span;
  if (delta < 0n && delta % span !== 0n) tick -= 1n;
  return Number(tick);
}

export class Prices {
  private readonly reader: PriceReader;
  private readonly now: () => number;

  constructor(reader: PriceReader, now: () => number = Date.now) {
    this.reader = reader;
    this.now = now;
  }

  /** USD per whole `token`, scaled by 10^18. Throws rather than guess. */
  async usdE18(token: Address, spec: PriceSpec, guard?: PriceGuard): Promise<bigint> {
    const price = await this.read(token, spec, 0);
    if (price <= 0n) throw new Error(`price for ${token} is not positive`);
    if (guard?.floorE18 != null && price < guard.floorE18) throw new Error(`price for ${token} is below its configured floor`);
    if (guard?.ceilingE18 != null && price > guard.ceilingE18) throw new Error(`price for ${token} is above its configured ceiling`);
    return price;
  }

  private async read(token: Address, spec: PriceSpec, depth: number): Promise<bigint> {
    if (depth > 4) throw new Error("price specs nest too deeply");
    switch (spec.kind) {
      case "fixed":
        return spec.usdE18;
      case "chainlink": {
        const { answer, decimals, updatedAt } = await this.reader.feed(spec.feed);
        if (answer <= 0n) throw new Error(`feed ${spec.feed} returned a non-positive answer`);
        if (BigInt(Math.floor(this.now() / 1000)) - updatedAt > BigInt(spec.maxAgeSeconds)) throw new Error(`feed ${spec.feed} is stale`);
        return (answer * E18) / 10n ** BigInt(decimals);
      }
      case "uniswapV3": {
        const { token0, token1, tickCumulatives } = await this.reader.pool(spec.pool, spec.twapSeconds);
        const base = token.toLowerCase();
        if (base !== token0.toLowerCase() && base !== token1.toLowerCase()) throw new Error(`pool ${spec.pool} does not trade ${token}`);
        const quoteToken = (base === token0.toLowerCase() ? token1 : token0).toLowerCase() as Address;
        const [baseDecimals, quoteDecimals, quoteUsdE18] = await Promise.all([
          this.reader.decimals(token),
          this.reader.decimals(quoteToken),
          this.read(quoteToken, spec.quote, depth + 1),
        ]);
        // 1.0001^tick is token1 atoms per token0 atom.
        const tick = averageTick(tickCumulatives, spec.twapSeconds);
        const quoteAtomsPerBaseAtom = Math.pow(1.0001, base === token0.toLowerCase() ? tick : -tick);
        // USD per whole base = quote atoms per base atom × 10^baseDec / 10^quoteDec × USD per whole quote.
        const scaled = scaleByFloat(quoteUsdE18 * 10n ** BigInt(baseDecimals), quoteAtomsPerBaseAtom);
        return scaled / 10n ** BigInt(quoteDecimals);
      }
    }
  }
}
