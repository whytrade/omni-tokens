import { keccak256, encodeAbiParameters, recoverMessageAddress, type Address, type Hex } from "viem";
import type { Chain, EscrowEvent, OnChainTab } from "../src/chain.ts";
import type { KeyProvider, KeySnapshot } from "../src/openrouter.ts";

type Unplaced<E> = E extends EscrowEvent ? Omit<E, "blockNumber" | "txHash" | "logIndex"> : never;

/** An in-memory escrow with the contract's rules, emitting the events the indexer reads. */
export class FakeChain implements Chain {
  block = 1n;
  tabs = new Map<Hex, OnChainTab>();
  log: EscrowEvent[] = [];
  balances = new Map<string, bigint>();
  tokenMeta = new Map<string, { symbol: string; decimals: number }>();
  feeds = new Map<string, { answer: bigint; decimals: number; updatedAt: bigint }>();
  pools = new Map<string, { token0: Address; token1: Address; tickCumulatives: [bigint, bigint] }>();
  sink: Address = "0x000000000000000000000000000000000000dead";
  failNext: string | null = null;
  /** Owners whose refunds revert, as a token with receive hooks or a blocklist can make them. */
  refuseRefundsTo = new Set<string>();
  /** Tabs whose token reverts every transfer, such as a paused token. */
  frozenTabs = new Set<Hex>();
  /** Emitted events the indexer will not see, as a flaky RPC can lose them. */
  hideNextEvent = false;
  private logIndex = 0;

  private emit(event: Unplaced<EscrowEvent>): Hex {
    this.block += 1n;
    const txHash = keccak256(encodeAbiParameters([{ type: "uint256" }], [BigInt(++this.logIndex)]));
    if (this.hideNextEvent) this.hideNextEvent = false;
    else this.log.push({ ...event, blockNumber: this.block, txHash, logIndex: 0 } as EscrowEvent);
    return txHash;
  }

  private move(token: Address, to: string, amount: bigint) {
    const key = `${token}:${to}`;
    this.balances.set(key, (this.balances.get(key) ?? 0n) + amount);
  }

  balance(token: Address, who: string) {
    return this.balances.get(`${token}:${who.toLowerCase()}`) ?? 0n;
  }

  // --- user actions ---

  open(owner: Address, token: Address, amount: bigint, salt: Hex = "0x01"): Hex {
    const tabId = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [owner, salt.padEnd(66, "0") as Hex]));
    this.tabs.set(tabId, { owner: owner.toLowerCase() as Address, token, closeRequestedAt: 0n, finalized: false, locked: amount, charged: 0n });
    this.emit({ name: "TabOpened", tabId, owner: owner.toLowerCase() as Address, token, amount });
    return tabId;
  }

  requestClose(tabId: Hex) {
    const tab = this.tabs.get(tabId)!;
    tab.closeRequestedAt = 1n;
    this.emit({ name: "TabCloseRequested", tabId });
  }

  forceRelease(tabId: Hex) {
    const tab = this.tabs.get(tabId)!;
    tab.finalized = true;
    const refund = tab.locked - tab.charged;
    this.move(tab.token, tab.owner, refund);
    this.emit({ name: "TabFinalized", tabId, charged: tab.charged, refunded: refund, forced: true });
  }

  // --- Chain ---

  async latestBlock() { return this.block; }

  async events(from: bigint, to: bigint) {
    return this.log.filter((e) => e.blockNumber >= from && e.blockNumber <= to);
  }

  async readTab(tabId: Hex) {
    const tab = this.tabs.get(tabId);
    return tab ? { ...tab } : { owner: "0x0000000000000000000000000000000000000000" as Address, token: "0x0000000000000000000000000000000000000000" as Address, closeRequestedAt: 0n, finalized: false, locked: 0n, charged: 0n };
  }

  async symbol(token: Address) { return this.tokenMeta.get(token)!.symbol; }
  async decimals(token: Address) { return this.tokenMeta.get(token)!.decimals; }
  async feed(feed: Address) { return this.feeds.get(feed)!; }
  async pool(pool: Address) { return this.pools.get(pool)!; }

  async verifyMessage(signer: Address, message: string, signature: Hex) {
    return (await recoverMessageAddress({ message, signature })).toLowerCase() === signer.toLowerCase();
  }

  async charge(entries: { tabId: Hex; cumulativeCharged: bigint }[]) {
    if (this.failNext === "charge") { this.failNext = null; throw new Error("charge reverted"); }
    // Like the contract, one failing entry reverts the whole batch.
    for (const { tabId, cumulativeCharged } of entries) {
      const tab = this.tabs.get(tabId)!;
      if (tab.finalized || cumulativeCharged <= tab.charged) continue;
      if (cumulativeCharged > tab.locked) throw new Error("ChargeExceedsLock");
      if (this.frozenTabs.has(tabId)) throw new Error("TransferFailed");
    }
    for (const { tabId, cumulativeCharged } of entries) {
      const tab = this.tabs.get(tabId)!;
      if (tab.finalized || cumulativeCharged <= tab.charged) continue;
      this.move(tab.token, this.sink, cumulativeCharged - tab.charged);
      tab.charged = cumulativeCharged;
      this.emit({ name: "TabCharged", tabId, cumulativeCharged });
    }
    return "0x" as Hex;
  }

  async finalize(tabId: Hex, finalCumulativeCharged: bigint) {
    if (this.failNext === "finalize") { this.failNext = null; throw new Error("finalize reverted"); }
    const tab = this.tabs.get(tabId)!;
    if (tab.finalized) throw new Error("AlreadyFinalized");
    if (finalCumulativeCharged > tab.locked) throw new Error("ChargeExceedsLock");
    const total = finalCumulativeCharged > tab.charged ? finalCumulativeCharged : tab.charged;
    if (this.frozenTabs.has(tabId) || (tab.locked > total && this.refuseRefundsTo.has(tab.owner))) throw new Error("TransferFailed");
    if (finalCumulativeCharged > tab.charged) {
      this.move(tab.token, this.sink, finalCumulativeCharged - tab.charged);
      tab.charged = finalCumulativeCharged;
    }
    tab.finalized = true;
    const refund = tab.locked - tab.charged;
    this.move(tab.token, tab.owner, refund);
    this.emit({ name: "TabFinalized", tabId, charged: tab.charged, refunded: refund, forced: false });
    return "0x" as Hex;
  }
}

type FakeKey = { secret: string; name: string; disabled: boolean; usage: bigint; limit: bigint };

/** OpenRouter's provisioning API, in memory. */
export class FakeProvider implements KeyProvider {
  keys = new Map<string, FakeKey>();
  creditMicros = 1_000_000_000n;
  failCreate = false;
  failUpdate = false;
  private count = 0;

  async create(name: string) {
    if (this.failCreate) throw new Error("create failed");
    const hash = `hash${++this.count}`;
    const secret = `sk-or-v1-fake${this.count}${"x".repeat(20)}`;
    this.keys.set(hash, { secret, name, disabled: false, usage: 0n, limit: 0n });
    return { secret, hash };
  }

  async get(hash: string): Promise<KeySnapshot> {
    const key = this.keys.get(hash)!;
    return { hash, disabled: key.disabled, usageMicros: key.usage, limitMicros: key.limit };
  }

  async update(hash: string, settings: { disabled: boolean; limitMicros: bigint }) {
    if (this.failUpdate) throw new Error("update failed");
    const key = this.keys.get(hash)!;
    key.disabled = settings.disabled;
    key.limit = settings.limitMicros;
  }

  async remainingCreditMicros() {
    let used = 0n;
    for (const key of this.keys.values()) used += key.usage;
    return this.creditMicros - used;
  }

  /** Simulates inference on a key, as OpenRouter would bill it. */
  spend(secret: string, micros: bigint) {
    const key = [...this.keys.values()].find((k) => k.secret === secret)!;
    if (key.disabled) throw new Error("key disabled");
    key.usage += micros;
  }
}
