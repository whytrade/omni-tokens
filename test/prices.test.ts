import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Address } from "viem";
import { parseTokens } from "../src/config.ts";
import { averageTick, parsePriceSpec, Prices } from "../src/prices.ts";
import { formatDecimal, parseDecimal, scaleByFloat } from "../src/units.ts";
import { FakeChain } from "./fakes.ts";

const WETH = "0x0000000000000000000000000000000000000e7f" as Address;
const USDC = "0x0000000000000000000000000000000000000001" as Address;
const MEME = "0x00000000000000000000000000000000000000ff" as Address;
const FEED = "0x000000000000000000000000000000000000feed" as Address;
const POOL = "0x0000000000000000000000000000000000000b01" as Address;
const NOW = Date.parse("2026-11-15T12:00:00Z");

function chainWith() {
  const chain = new FakeChain();
  chain.tokenMeta.set(WETH, { symbol: "WETH", decimals: 18 });
  chain.tokenMeta.set(USDC, { symbol: "USDC", decimals: 6 });
  chain.tokenMeta.set(MEME, { symbol: "MEME", decimals: 18 });
  chain.feeds.set(FEED, { answer: 3000_00000000n, decimals: 8, updatedAt: BigInt(NOW / 1000 - 60) });
  return chain;
}

/** Cumulatives for a pool that sat at `tick` for the whole window. */
const steady = (tick: number, seconds: number): [bigint, bigint] => [1_000_000n, 1_000_000n + BigInt(tick) * BigInt(seconds)];

const near = (actual: bigint, expected: bigint) =>
  assert.ok(actual * 1000n >= expected * 999n && actual * 1000n <= expected * 1001n, `${formatDecimal(actual, 18)} is not about ${formatDecimal(expected, 18)}`);

describe("units", () => {
  it("parses and formats decimals exactly", () => {
    assert.equal(parseDecimal("1.5", 6, "x"), 1_500_000n);
    assert.equal(parseDecimal("0.0000015", 6, "x"), 2n, "extra digits round up");
    assert.equal(formatDecimal(1_500_000n, 6), "1.5");
    assert.equal(formatDecimal(10n ** 18n, 18), "1");
    assert.throws(() => parseDecimal("-1", 6, "x"));
  });

  it("scales by floats without losing tiny prices", () => {
    assert.equal(scaleByFloat(10n ** 18n, 1.5e-9), 1_500_000_000n);
    assert.equal(scaleByFloat(10n ** 18n, 2500), 2500n * 10n ** 18n);
  });

  it("rounds average ticks toward negative infinity", () => {
    assert.equal(averageTick([0n, 10n], 3), 3);
    assert.equal(averageTick([0n, -10n], 3), -4);
    assert.equal(averageTick([0n, -9n], 3), -3);
  });
});

describe("prices", () => {
  it("reads fixed prices and Chainlink feeds", async () => {
    const prices = new Prices(chainWith(), () => NOW);
    assert.equal(await prices.usdE18(USDC, parsePriceSpec("1")), 10n ** 18n);
    assert.equal(await prices.usdE18(WETH, parsePriceSpec({ chainlink: FEED })), 3000n * 10n ** 18n);
  });

  it("refuses stale feeds", async () => {
    const chain = chainWith();
    chain.feeds.get(FEED)!.updatedAt = BigInt(NOW / 1000 - 7200);
    await assert.rejects(new Prices(chain, () => NOW).usdE18(WETH, parsePriceSpec({ chainlink: FEED })), /stale/);
  });

  it("prices a token through a pool against a token with a different decimals", async () => {
    // MEME is token1 of a USDC/MEME pool. 1 MEME = 0.0001 USDC, so 1 USDC atom buys 10^-6 × 10^4 × 10^18 MEME atoms.
    const chain = chainWith();
    const tick = Math.round(Math.log(1e16) / Math.log(1.0001)); // MEME atoms per USDC atom
    chain.pools.set(POOL, { token0: USDC, token1: MEME, tickCumulatives: steady(tick, 1800) });
    const price = await new Prices(chain, () => NOW).usdE18(MEME, parsePriceSpec({ uniswapV3: POOL, quote: "1" }));
    near(price, 10n ** 14n);
  });

  it("chains a pool price through a feed", async () => {
    // MEME is token0 of a MEME/WETH pool at 10^-8 WETH per MEME, with WETH at $3000.
    const chain = chainWith();
    const tick = Math.round(Math.log(1e-8) / Math.log(1.0001));
    chain.pools.set(POOL, { token0: MEME, token1: WETH, tickCumulatives: steady(tick, 600) });
    const spec = parsePriceSpec({ uniswapV3: POOL, twapSeconds: 600, quote: { chainlink: FEED } });
    near(await new Prices(chain, () => NOW).usdE18(MEME, spec), 3n * 10n ** 13n);
  });

  it("refuses pools that do not trade the token and prices outside the guard", async () => {
    const chain = chainWith();
    chain.pools.set(POOL, { token0: USDC, token1: WETH, tickCumulatives: steady(0, 1800) });
    const prices = new Prices(chain, () => NOW);
    await assert.rejects(prices.usdE18(MEME, parsePriceSpec({ uniswapV3: POOL, quote: "1" })), /does not trade/);
    await assert.rejects(prices.usdE18(USDC, parsePriceSpec("1"), { floorE18: 2n * 10n ** 18n, ceilingE18: null }), /floor/);
    await assert.rejects(prices.usdE18(USDC, parsePriceSpec("1"), { floorE18: null, ceilingE18: 10n ** 17n }), /ceiling/);
  });
});

describe("TOKENS", () => {
  it("parses a list of tokens and their price specs", () => {
    const tokens = parseTokens(JSON.stringify([
      { address: USDC, price: "1" },
      { address: MEME, price: { uniswapV3: POOL, quote: { chainlink: FEED } }, floor: "0.00001", ceiling: "1" },
    ]));
    assert.equal(tokens.length, 2);
    assert.equal(tokens[1].price.kind, "uniswapV3");
    assert.equal(tokens[1].guard.floorE18, 10n ** 13n);
  });

  it("rejects mistakes", () => {
    assert.throws(() => parseTokens("[]"), /at least one/);
    assert.throws(() => parseTokens(JSON.stringify([{ address: USDC, price: "1" }, { address: USDC, price: "1" }])), /repeats/);
    assert.throws(() => parseTokens(JSON.stringify([{ address: USDC, price: { uniswapV3: POOL } }])), /quote/);
    assert.throws(() => parseTokens(JSON.stringify([{ address: USDC, price: "0" }])), /positive/);
    assert.throws(() => parseTokens(JSON.stringify([{ address: MEME, price: { uniswapV3: POOL, quote: "1" } }])), /floor and ceiling/);
  });
});
