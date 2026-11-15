import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { openDatabase, updateTab } from "../src/db.ts";
import { HttpError } from "../src/errors.ts";
import { silentLog } from "../src/log.ts";
import { Prices } from "../src/prices.ts";
import { allowanceFor, chargeFor, TabService, type Settings } from "../src/tabs.ts";
import { FakeChain, FakeProvider } from "./fakes.ts";

const USDC = "0x00000000000000000000000000000000000000c1" as Address;
const COMM = "0x00000000000000000000000000000000000000c2" as Address;
const OTHER = "0x00000000000000000000000000000000000000c3" as Address;
const usdc = (n: number) => BigInt(Math.round(n * 1e6));
const micros = usdc;

const settings: Settings = {
  chainId: 31337,
  escrow: "0x00000000000000000000000000000000000000e5",
  startBlock: 0n,
  confirmations: 0n,
  maxBlockRange: 1000n,
  markupBps: 12_000n,
  minTabMicros: micros(1),
  maxTabMicros: micros(100),
  creditBufferMicros: 0n,
  settleDelayMs: 60_000,
  chargeIntervalMs: 600_000,
  usagePollMs: 30_000,
  publicUrl: "http://localhost:8787",
  keyNamePrefix: "tab",
};

let chain: FakeChain;
let provider: FakeProvider;
let service: TabService;
let clock: number;
const owner = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());

async function setup(overrides: Partial<Settings> = {}) {
  clock = Date.parse("2026-11-15T12:00:00Z");
  chain = new FakeChain();
  chain.tokenMeta.set(USDC, { symbol: "USDC", decimals: 6 });
  chain.tokenMeta.set(COMM, { symbol: "COMM", decimals: 18 });
  provider = new FakeProvider();
  service = new TabService({
    db: openDatabase(":memory:"),
    chain,
    provider,
    prices: new Prices(chain, () => clock),
    tokens: [
      { address: USDC, price: { kind: "fixed", usdE18: 10n ** 18n }, guard: { floorE18: null, ceilingE18: null } },
      { address: COMM, price: { kind: "fixed", usdE18: 10n ** 16n }, guard: { floorE18: null, ceilingE18: null } },
    ],
    settings: { ...settings, ...overrides },
    log: silentLog,
    now: () => clock,
  });
  await service.init();
}

async function claim(tabId: Hex, signer = owner) {
  const expiresAt = clock + 60_000;
  const signature = await signer.signMessage({ message: service.claimMessage(tabId, expiresAt) });
  return service.claim(tabId, signature, expiresAt);
}

async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof HttpError && error.code === code);
}

async function advance(ms: number) {
  clock += ms;
  await service.tick();
}

describe("pricing math", () => {
  it("converts a lock into a USD limit after markup", () => {
    assert.equal(allowanceFor(usdc(12), 6, 10n ** 18n, 12_000n, micros(100)), micros(10));
    assert.equal(allowanceFor(10n ** 21n, 18, 10n ** 16n, 10_000n, micros(100)), micros(10), "1000 tokens at $0.01");
    assert.equal(allowanceFor(usdc(500), 6, 10n ** 18n, 10_000n, micros(100)), micros(100), "capped");
  });

  it("charges the whole lock for exactly the full limit, never more", () => {
    for (const [locked, decimals, price, markup] of [
      [usdc(12), 6, 10n ** 18n, 12_000n],
      [123456789123456789123n, 18, 31415926535n, 13_337n],
      [7n, 0, 3n * 10n ** 18n, 10_000n],
    ] as const) {
      const limit = allowanceFor(locked, decimals, price, markup, 10n ** 30n);
      const rate = { locked, decimals, priceE18: price, markupBps: markup };
      assert.ok(chargeFor(limit, rate) <= locked);
      assert.equal(chargeFor(limit * 10n, rate), locked);
      assert.equal(chargeFor(0n, rate), 0n);
    }
  });
});

describe("a tab", () => {
  beforeEach(() => setup());

  it("issues a capped key, charges usage and refunds the rest", async () => {
    const tabId = chain.open(owner.address, USDC, usdc(12));
    await service.tick();
    assert.equal(service.view(tabId).state, "open");

    const { key, tab } = await claim(tabId);
    assert.match(key, /^sk-or-/);
    assert.equal(tab.state, "active");
    assert.equal(tab.limitUsd, "10", "12 USDC at $1 with a 20% markup buys $10");
    const remote = [...provider.keys.values()][0];
    assert.equal(remote.limit, micros(10));
    assert.equal(remote.name, `tab ${tabId}`);

    provider.spend(key, micros(4));
    await advance(30_000);
    assert.equal(service.view(tabId).usageUsd, "4");
    assert.equal(service.view(tabId).charged, usdc(4.8).toString());
    assert.equal(chain.tabs.get(tabId)!.charged, 0n, "charges wait for the posting interval");

    await advance(600_000);
    assert.equal(chain.tabs.get(tabId)!.charged, usdc(4.8), "posted so a forced exit still pays the operator");

    chain.requestClose(tabId);
    await advance(1_000);
    assert.equal(service.view(tabId).state, "settling");
    assert.equal(remote.disabled, true);
    provider.keys.get("hash1")!.usage += micros(0.5); // a request that was in flight
    await advance(60_000);

    const closed = service.view(tabId);
    assert.equal(closed.state, "closed");
    assert.equal(closed.usageUsd, "4.5");
    assert.equal(chain.balance(USDC, chain.sink), usdc(5.4));
    assert.equal(chain.balance(USDC, owner.address), usdc(6.6));
    await advance(1_000);
    assert.equal(service.view(tabId).refunded, usdc(6.6).toString());
  });

  it("closes itself when the limit is spent", async () => {
    const tabId = chain.open(owner.address, COMM, 10n ** 21n); // 1000 COMM at $0.01, $8.33 after markup
    await service.tick();
    const { key, tab } = await claim(tabId);
    assert.equal(tab.limitUsd, "8.333333");
    provider.spend(key, micros(8.4)); // OpenRouter limits are not exact
    await advance(30_000);
    assert.equal(service.view(tabId).state, "settling");
    await advance(60_000);
    assert.equal(chain.tabs.get(tabId)!.charged, 10n ** 21n, "never more than the lock");
    assert.equal(chain.balance(COMM, owner.address), 0n);
  });

  it("caps a large tab and refunds what the cap leaves", async () => {
    const tabId = chain.open(owner.address, USDC, usdc(1000));
    await service.tick();
    const { key, tab } = await claim(tabId);
    assert.equal(tab.limitUsd, "100");
    provider.spend(key, micros(100));
    await advance(30_000);
    await advance(60_000);
    assert.equal(chain.balance(USDC, chain.sink), usdc(120));
    assert.equal(chain.balance(USDC, owner.address), usdc(880));
  });

  it("refunds a tab that never claimed a key", async () => {
    const tabId = chain.open(owner.address, USDC, usdc(5));
    await service.tick();
    chain.requestClose(tabId);
    await advance(1_000);
    assert.equal(service.view(tabId).state, "closed");
    assert.equal(chain.balance(USDC, owner.address), usdc(5));
    assert.equal(provider.keys.size, 0);
  });

  it("refunds a token the server does not price", async () => {
    const tabId = chain.open(owner.address, OTHER, 10n ** 18n);
    await service.tick();
    await rejects(claim(tabId), "unknown_token");
    chain.requestClose(tabId);
    await advance(1_000);
    assert.equal(chain.balance(OTHER, owner.address), 10n ** 18n);
  });

  it("freezes the price at claim", async () => {
    const tabId = chain.open(owner.address, USDC, usdc(12));
    await service.tick();
    const { key } = await claim(tabId);
    (service as any).tokens.get(USDC).price = { kind: "fixed", usdE18: 2n * 10n ** 18n };
    provider.spend(key, micros(5));
    await advance(30_000);
    assert.equal((await service.quote(USDC, usdc(12))).priceUsd, "2", "new tabs see the new price");
    assert.equal(service.view(tabId).charged, usdc(6).toString(), "this tab keeps its claim price");
  });

  it("stops the key when the owner force-releases", async () => {
    const tabId = chain.open(owner.address, USDC, usdc(12));
    await service.tick();
    const { key } = await claim(tabId);
    chain.forceRelease(tabId);
    await advance(1_000);
    const tab = service.view(tabId);
    assert.equal(tab.state, "closed");
    assert.equal(tab.forced, true);
    assert.equal(provider.keys.get("hash1")!.disabled, true);
    assert.throws(() => provider.spend(key, 1n));
  });

  it("retries activation and settlement after provider and chain errors", async () => {
    const tabId = chain.open(owner.address, USDC, usdc(12));
    await service.tick();
    provider.failUpdate = true;
    const { tab } = await claim(tabId);
    assert.equal(tab.state, "activating", "the key is returned even if raising its limit failed");
    await advance(1_000);
    assert.equal(service.view(tabId).state, "activating");
    provider.failUpdate = false;
    await advance(30_000);
    assert.equal(service.view(tabId).state, "active");

    chain.requestClose(tabId);
    await advance(1_000);
    chain.failNext = "finalize";
    await advance(60_000);
    assert.equal(service.view(tabId).state, "settling");
    await advance(30_000);
    assert.equal(service.view(tabId).state, "closed");
  });
});

describe("hostile conditions", () => {
  beforeEach(() => setup());

  it("collects the final charge even when the owner blocks the refund", async () => {
    const tabId = chain.open(owner.address, USDC, usdc(12));
    await service.tick();
    const { key } = await claim(tabId);
    provider.spend(key, micros(9.995));
    chain.refuseRefundsTo.add(owner.address.toLowerCase());
    await advance(30_000); // spent before any periodic charge was due
    await advance(60_000);
    assert.equal(service.view(tabId).state, "settling", "finalize keeps failing");
    assert.equal(chain.tabs.get(tabId)!.charged, usdc(11.994), "but the charge is on chain");
    chain.forceRelease(tabId);
    assert.equal(chain.balance(USDC, owner.address), usdc(0.006), "a force-release returns only what was unused");
  });

  it("posts healthy charges when one tab's token is frozen", async () => {
    const frozen = chain.open(owner.address, USDC, usdc(12), "0x01");
    const healthy = chain.open(owner.address, USDC, usdc(12), "0x02");
    await service.tick();
    const a = await claim(frozen);
    const b = await claim(healthy);
    provider.spend(a.key, micros(5));
    provider.spend(b.key, micros(5));
    chain.frozenTabs.add(frozen);
    await advance(30_000);
    await advance(600_000);
    assert.equal(chain.tabs.get(healthy)!.charged, usdc(6));
    assert.equal(chain.tabs.get(frozen)!.charged, 0n);
  });

  it("stops a key whose release the indexer never saw", async () => {
    const tabId = chain.open(owner.address, USDC, usdc(12));
    await service.tick();
    await claim(tabId);
    chain.hideNextEvent = true;
    chain.requestClose(tabId);
    chain.hideNextEvent = true;
    chain.forceRelease(tabId);
    await advance(30_000);
    assert.equal(provider.keys.get("hash1")!.disabled, true);
  });

  it("refuses tokens whose smallest unit is worth more than a cent", async () => {
    const COARSE = "0x00000000000000000000000000000000000000c4" as Address;
    chain.tokenMeta.set(COARSE, { symbol: "GOLD", decimals: 0 });
    (service as any).tokens.set(COARSE, { address: COARSE, symbol: "GOLD", decimals: 0, price: { kind: "fixed", usdE18: 3n * 10n ** 18n }, guard: { floorE18: null, ceilingE18: null } });
    const tabId = chain.open(owner.address, COARSE, 10n);
    await service.tick();
    await rejects(claim(tabId), "token_too_coarse");
  });
});

describe("claiming", () => {
  beforeEach(() => setup());

  it("only accepts the owner's fresh signature, once", async () => {
    const tabId = chain.open(owner.address, USDC, usdc(12));
    await service.tick();
    await rejects(claim(tabId, stranger), "bad_signature");

    const expiresAt = clock - 1;
    const signature = await owner.signMessage({ message: service.claimMessage(tabId, expiresAt) });
    await rejects(service.claim(tabId, signature, expiresAt), "expired");

    const late = clock + 60 * 60_000;
    await rejects(service.claim(tabId, await owner.signMessage({ message: service.claimMessage(tabId, late) }), late), "expired");

    await claim(tabId);
    await rejects(claim(tabId), "already_claimed");
  });

  it("refuses unknown and closing tabs", async () => {
    await rejects(claim(`0x${"ab".repeat(32)}`), "not_found");
    const tabId = chain.open(owner.address, USDC, usdc(12));
    chain.requestClose(tabId);
    await service.tick();
    await rejects(claim(tabId), "closed");
  });

  it("refuses tabs below the minimum", async () => {
    const tabId = chain.open(owner.address, USDC, usdc(1));
    await service.tick();
    await rejects(claim(tabId), "tab_too_small");
    assert.equal(service.view(tabId).state, "open");
  });

  it("never promises more credit than the operator has", async () => {
    provider.creditMicros = micros(15);
    const first = chain.open(owner.address, USDC, usdc(12), "0x01");
    const second = chain.open(owner.address, USDC, usdc(12), "0x02");
    await service.tick();
    await claim(first);
    await rejects(claim(second), "out_of_credit");
    assert.equal(service.view(second).state, "open", "the owner can retry or close");
    provider.creditMicros = micros(25);
    await claim(second);
  });

  it("returns the tab to open when OpenRouter fails", async () => {
    const tabId = chain.open(owner.address, USDC, usdc(12));
    await service.tick();
    provider.failCreate = true;
    await rejects(claim(tabId), "provider_unavailable");
    assert.equal(service.view(tabId).state, "open");
    provider.failCreate = false;
    await claim(tabId);
  });

  it("recovers claims interrupted by a restart", async () => {
    const tabId = chain.open(owner.address, USDC, usdc(12));
    await service.tick();
    const db = (service as any).o.db;
    updateTab(db, tabId, { state: "claiming", allowance_micros: "10000000" });
    await service.init();
    assert.equal(service.view(tabId).state, "open");
    await claim(tabId);
  });
});

describe("indexing", () => {
  beforeEach(() => setup({ confirmations: 2n, maxBlockRange: 1n }));

  it("waits for confirmations and applies each log once", async () => {
    const tabId = chain.open(owner.address, USDC, usdc(12));
    await service.tick();
    assert.throws(() => service.view(tabId), HttpError);
    chain.block += 2n;
    await service.tick();
    await service.tick();
    assert.equal(service.view(tabId).locked, usdc(12).toString());
    assert.equal(service.list(owner.address).length, 1);
  });
});
