import type { Address, Hex } from "viem";
import type { Chain, EscrowEvent } from "./chain.ts";
import type { Config, TokenConfig } from "./config.ts";
import { getTab, moveTab, tabsInState, transaction, updateTab, type Database, type TabRow } from "./db.ts";
import { HttpError } from "./errors.ts";
import type { Log } from "./log.ts";
import type { KeyProvider } from "./openrouter.ts";
import type { Prices } from "./prices.ts";
import { BPS, ceilDiv, E18, formatDecimal, maxBigInt, MICRO, minBigInt } from "./units.ts";

export type Settings = Pick<
  Config,
  | "chainId" | "escrow" | "startBlock" | "confirmations" | "maxBlockRange" | "markupBps" | "minTabMicros" | "maxTabMicros"
  | "creditBufferMicros" | "settleDelayMs" | "chargeIntervalMs" | "usagePollMs" | "publicUrl" | "keyNamePrefix"
>;

export type TabServiceOptions = {
  db: Database;
  chain: Chain;
  provider: KeyProvider;
  prices: Prices;
  tokens: TokenConfig[];
  settings: Settings;
  log: Log;
  now?: () => number;
};

type Token = TokenConfig & { symbol: string; decimals: number };

/** How long a signed claim stays valid. */
export const CLAIM_WINDOW_MS = 10 * 60_000;
const CHARGE_BATCH = 50;
/** A key with less than a cent left cannot pay for a request, so it is treated as spent. */
const DUST_MICROS = 10_000n;
/** The most one token unit may be worth: one cent, scaled by 10^18. */
const MAX_UNIT_PRICE_E18 = 10n ** 16n;

/** USD a lock buys at a price, after markup and the per-tab cap, in micro-dollars. */
export function allowanceFor(locked: bigint, decimals: number, priceE18: bigint, markupBps: bigint, maxTabMicros: bigint): bigint {
  const valueMicros = (locked * priceE18) / (10n ** BigInt(decimals) * (E18 / MICRO));
  return minBigInt(maxTabMicros, (valueMicros * BPS) / markupBps);
}

/** Tokens owed for `usageMicros` of inference at the tab's frozen rate, rounded up and never above the lock. */
export function chargeFor(usageMicros: bigint, tab: { locked: bigint; decimals: number; priceE18: bigint; markupBps: bigint }): bigint {
  const owed = ceilDiv(usageMicros * (E18 / MICRO) * 10n ** BigInt(tab.decimals) * tab.markupBps, tab.priceE18 * BPS);
  return minBigInt(tab.locked, owed);
}

const usd = (micros: bigint | string) => formatDecimal(BigInt(micros), 6);

/**
 * The whole lifecycle of a tab: mirrors the escrow, mints a capped OpenRouter
 * key for its owner, follows the key's usage, posts charges, and finalizes the
 * tab on chain once the key is stopped.
 */
export class TabService {
  private readonly o: TabServiceOptions;
  private readonly now: () => number;
  private tokens = new Map<string, Token>();
  private claiming: Promise<unknown> = Promise.resolve();
  private priceCache = new Map<string, { at: number; e18: bigint | null }>();

  constructor(options: TabServiceOptions) {
    this.o = options;
    this.now = options.now ?? Date.now;
  }

  /** Reads token metadata and recovers claims a crash interrupted. */
  async init(): Promise<void> {
    for (const token of this.o.tokens) {
      const [symbol, decimals] = await Promise.all([this.o.chain.symbol(token.address), this.o.chain.decimals(token.address)]);
      this.tokens.set(token.address, { ...token, symbol, decimals });
    }
    // A claim that never stored its key hash can only have orphaned a zero-limit key.
    this.o.db.prepare("UPDATE tabs SET state = 'open', allowance_micros = '0', claimed_at = NULL WHERE state = 'claiming' AND key_hash IS NULL").run();
    this.o.db.prepare("UPDATE tabs SET state = 'activating' WHERE state = 'claiming'").run();
  }

  // --- reading ---

  tokenList() {
    return [...this.tokens.values()].map((t) => ({ address: t.address, symbol: t.symbol, decimals: t.decimals }));
  }

  async currentPrice(token: Address): Promise<bigint | null> {
    const cached = this.priceCache.get(token);
    if (cached && this.now() - cached.at < 30_000) return cached.e18;
    const config = this.tokens.get(token);
    let e18: bigint | null = null;
    if (config) {
      try { e18 = await this.o.prices.usdE18(token, config.price, config.guard); }
      catch (error) { this.o.log.error(`pricing ${config.symbol} failed`, error); }
    }
    this.priceCache.set(token, { at: this.now(), e18 });
    return e18;
  }

  async quote(token: Address, amount: bigint) {
    const config = this.tokens.get(token.toLowerCase());
    if (!config) throw new HttpError(404, "unknown_token", "This server does not accept that token.");
    const price = await this.currentPrice(config.address);
    if (price === null) throw new HttpError(503, "price_unavailable", "The token's price is unavailable right now.");
    const limit = allowanceFor(amount, config.decimals, price, this.o.settings.markupBps, this.o.settings.maxTabMicros);
    return {
      token: config.address,
      priceUsd: formatDecimal(price, 18),
      limitUsd: usd(limit),
      capped: limit === this.o.settings.maxTabMicros,
      belowMinimum: limit < this.o.settings.minTabMicros,
    };
  }

  view(id: string) {
    const tab = getTab(this.o.db, id.toLowerCase());
    if (!tab) throw new HttpError(404, "not_found", "No tab with that id yet. New tabs appear once their block is confirmed.");
    return this.present(tab);
  }

  list(owner: string) {
    const rows = this.o.db.prepare("SELECT * FROM tabs WHERE owner = ? ORDER BY opened_at DESC LIMIT 100").all(owner.toLowerCase()) as TabRow[];
    return rows.map((row) => this.present(row));
  }

  private present(tab: TabRow) {
    const token = this.tokens.get(tab.token);
    const allowance = BigInt(tab.allowance_micros);
    const usage = BigInt(tab.usage_micros);
    return {
      id: tab.id,
      owner: tab.owner,
      token: { address: tab.token, symbol: token?.symbol ?? null, decimals: tab.decimals ?? token?.decimals ?? null },
      state: tab.state,
      closeRequested: tab.close_requested === 1,
      claimed: tab.key_hash !== null,
      keyHint: tab.key_hint,
      locked: tab.locked,
      charged: tab.charged,
      chargePosted: tab.charge_posted,
      refunded: tab.refunded,
      forced: tab.forced === null ? null : tab.forced === 1,
      priceUsd: tab.price_e18 === null ? null : formatDecimal(BigInt(tab.price_e18), 18),
      limitUsd: usd(allowance),
      usageUsd: usd(usage),
      remainingUsd: usd(maxBigInt(0n, allowance - usage)),
      openedTx: tab.opened_tx,
      openedAt: new Date(tab.opened_at).toISOString(),
      claimedAt: tab.claimed_at === null ? null : new Date(tab.claimed_at).toISOString(),
      closedAt: tab.closed_at === null ? null : new Date(tab.closed_at).toISOString(),
      note: tab.error,
    };
  }

  // --- claiming a key ---

  claimMessage(id: string, expiresAt: number): string {
    const { publicUrl, escrow, chainId } = this.o.settings;
    return [
      `Claim the inference key for tab ${id.toLowerCase()}`,
      "",
      `Server: ${publicUrl}`,
      `Escrow: ${escrow}`,
      `Chain: ${chainId}`,
      `Expires: ${new Date(expiresAt).toISOString()}`,
    ].join("\n");
  }

  /**
   * Mints the tab's OpenRouter key and returns its secret, once. The owner
   * proves control by signing `claimMessage`. The price is frozen here: the
   * key's USD limit is what the lock was worth at this moment.
   */
  async claim(id: string, signature: Hex, expiresAt: number): Promise<{ key: string; tab: ReturnType<TabService["present"]> }> {
    id = id.toLowerCase();
    const tab = getTab(this.o.db, id);
    if (!tab) throw new HttpError(404, "not_found", "No tab with that id yet. New tabs appear once their block is confirmed.");
    const now = this.now();
    if (!Number.isSafeInteger(expiresAt) || expiresAt < now || expiresAt > now + CLAIM_WINDOW_MS + 30_000) {
      throw new HttpError(400, "expired", "The claim signature is expired or too far in the future. Sign a fresh claim message.");
    }
    if (!/^0x[0-9a-fA-F]+$/.test(signature)) throw new HttpError(400, "invalid_request", "signature must be hex.");
    this.assertClaimable(tab);
    const valid = await this.o.chain.verifyMessage(tab.owner as Address, this.claimMessage(id, expiresAt), signature).catch(() => false);
    if (!valid) throw new HttpError(401, "bad_signature", "The signature is not from this tab's owner.");
    const token = this.tokens.get(tab.token);
    if (!token) throw new HttpError(422, "unknown_token", "This server does not price this tab's token. Close the tab to get it back.");

    await this.serialize(() => this.reserve(id, token));

    let remote: { secret: string; hash: string };
    try {
      remote = await this.o.provider.create(`${this.o.settings.keyNamePrefix} ${id}`);
    } catch (error) {
      this.o.log.error(`creating the key for ${id} failed`, error);
      moveTab(this.o.db, id, "claiming", { state: "open", allowance_micros: "0", claimed_at: null, price_e18: null, markup_bps: null });
      throw new HttpError(502, "provider_unavailable", "OpenRouter did not create the key. Try again shortly.");
    }
    const hint = remote.secret.slice(-4);
    if (!moveTab(this.o.db, id, "claiming", { key_hash: remote.hash, key_hint: hint, state: "activating", next_check_at: 0 })) {
      // The tab closed meanwhile. Record the zero-limit key so the worker disables it.
      updateTab(this.o.db, id, { key_hash: remote.hash, key_hint: hint });
      throw new HttpError(409, "closed", "This tab closed while its key was being made.");
    }
    try {
      await this.activate(getTab(this.o.db, id)!);
    } catch (error) {
      this.o.log.error(`activating ${id} failed; the worker will retry`, error);
    }
    return { key: remote.secret, tab: this.present(getTab(this.o.db, id)!) };
  }

  private assertClaimable(tab: TabRow) {
    if (tab.key_hash !== null || tab.state === "claiming") {
      throw new HttpError(409, "already_claimed", "This tab's key was already issued. If it is lost, close the tab and open a new one.");
    }
    if (tab.state !== "open" || tab.close_requested) throw new HttpError(409, "closed", "This tab is closing or closed.");
  }

  /** Checks backing, price and credit, then books the allowance against the operator's credit. */
  private async reserve(id: string, token: Token): Promise<void> {
    const { db, chain, provider, settings } = this.o;
    const tab = getTab(db, id)!;
    this.assertClaimable(tab);
    const onChain = await chain.readTab(id as Hex);
    if (onChain.finalized || onChain.closeRequestedAt !== 0n || onChain.locked !== BigInt(tab.locked) || onChain.owner !== tab.owner) {
      throw new HttpError(409, "closed", "This tab is closing or closed on chain.");
    }
    let price: bigint;
    try {
      price = await this.o.prices.usdE18(token.address, token.price, token.guard);
    } catch (error) {
      this.o.log.error(`pricing ${token.symbol} for a claim failed`, error);
      throw new HttpError(503, "price_unavailable", "The token's price is unavailable right now. Try again later or close the tab.");
    }
    // Charges round up to a whole token unit, so a unit worth more than a cent would overcharge.
    if (price > MAX_UNIT_PRICE_E18 * 10n ** BigInt(token.decimals)) {
      throw new HttpError(422, "token_too_coarse", "This token's smallest unit is worth more than a cent, so usage cannot be charged fairly. Close the tab.");
    }
    const allowance = allowanceFor(BigInt(tab.locked), token.decimals, price, settings.markupBps, settings.maxTabMicros);
    if (allowance < settings.minTabMicros) {
      throw new HttpError(422, "tab_too_small", `This tab is worth less than the $${usd(settings.minTabMicros)} minimum. Close it to get it back.`);
    }
    let credit: bigint;
    try {
      credit = await provider.remainingCreditMicros();
    } catch (error) {
      this.o.log.error("reading OpenRouter credit failed", error);
      throw new HttpError(502, "provider_unavailable", "OpenRouter is unavailable. Try again shortly.");
    }
    if (credit - this.outstandingMicros() - settings.creditBufferMicros < allowance) {
      throw new HttpError(503, "out_of_credit", "The operator does not have enough OpenRouter credit for this tab right now. Try later or close the tab.");
    }
    const reserved = moveTab(db, id, "open", {
      state: "claiming",
      decimals: token.decimals,
      price_e18: price.toString(),
      markup_bps: settings.markupBps.toString(),
      allowance_micros: allowance.toString(),
      claimed_at: this.now(),
    });
    if (!reserved) throw new HttpError(409, "closed", "This tab changed while claiming. Check its state and try again.");
  }

  /** Credit already promised to keys that can still spend. */
  private outstandingMicros(): bigint {
    return tabsInState(this.o.db, "claiming", "activating", "active", "settling")
      .reduce((sum, tab) => sum + maxBigInt(0n, BigInt(tab.allowance_micros) - BigInt(tab.usage_micros)), 0n);
  }

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.claiming.then(run, run);
    this.claiming = next.catch(() => undefined);
    return next;
  }

  // --- indexing ---

  async index(): Promise<void> {
    const { db, chain, settings } = this.o;
    const latest = await chain.latestBlock();
    if (latest < settings.confirmations) return;
    const safe = latest - settings.confirmations;
    const cursor = db.prepare("SELECT block FROM cursors WHERE name = 'escrow'").get() as { block: string } | undefined;
    let from = cursor ? BigInt(cursor.block) + 1n : settings.startBlock;
    while (from <= safe) {
      const to = minBigInt(from + settings.maxBlockRange - 1n, safe);
      const events = await chain.events(from, to);
      transaction(db, () => {
        for (const event of events) this.apply(event);
        db.prepare("INSERT INTO cursors (name, block) VALUES ('escrow', ?) ON CONFLICT (name) DO UPDATE SET block = excluded.block").run(to.toString());
      });
      from = to + 1n;
    }
  }

  private apply(event: EscrowEvent): void {
    const { db } = this.o;
    const fresh = db.prepare("INSERT OR IGNORE INTO seen_logs (tx, log_index) VALUES (?, ?)").run(event.txHash, event.logIndex);
    if (fresh.changes === 0) return;
    const tab = getTab(db, event.tabId);
    switch (event.name) {
      case "TabOpened":
        db.prepare("INSERT OR IGNORE INTO tabs (id, owner, token, locked, opened_tx, opened_at, state) VALUES (?, ?, ?, ?, ?, ?, 'open')")
          .run(event.tabId, event.owner, event.token, event.amount.toString(), event.txHash, this.now());
        return;
      case "TabCharged":
        if (tab) updateTab(db, tab.id, { charge_posted: maxBigInt(BigInt(tab.charge_posted), event.cumulativeCharged).toString() });
        return;
      case "TabCloseRequested":
        if (tab) updateTab(db, tab.id, { close_requested: 1, next_check_at: 0 });
        return;
      case "TabFinalized":
        if (!tab) return;
        // The escrow no longer backs this tab, so its key must stop, whoever finalized it.
        updateTab(db, tab.id, {
          state: "closed",
          charge_posted: event.charged.toString(),
          refunded: event.refunded.toString(),
          forced: event.forced ? 1 : 0,
          closed_at: tab.closed_at ?? this.now(),
          error: event.forced ? "The owner force-released this tab." : tab.state === "closed" ? tab.error : null,
        });
        return;
    }
  }

  // --- the worker ---

  /** One pass of background work. Each step and each tab fails on its own. */
  async tick(): Promise<void> {
    try { await this.index(); } catch (error) { this.o.log.error("indexing the escrow failed", error); }
    const now = this.now();
    const steps: [TabRow[], (tab: TabRow) => Promise<void>][] = [
      [tabsInState(this.o.db, "activating"), (tab) => (tab.close_requested ? this.stop(tab) : this.activate(tab))],
      [tabsInState(this.o.db, "active").filter((t) => t.next_check_at <= now), (tab) => this.poll(tab)],
      [tabsInState(this.o.db, "settling").filter((t) => t.next_check_at <= now), (tab) => this.settle(tab)],
      [tabsInState(this.o.db, "open").filter((t) => t.close_requested), (tab) => this.settle(tab)],
      [tabsInState(this.o.db, "closed").filter((t) => t.key_hash !== null && t.disabled_at === null), (tab) => this.disable(tab)],
    ];
    for (const [tabs, run] of steps) {
      for (const tab of tabs) {
        try {
          await run(tab);
        } catch (error) {
          this.o.log.error(`tab ${tab.id} failed`, error);
          updateTab(this.o.db, tab.id, { error: "Waiting on OpenRouter or the chain; retrying.", next_check_at: now + this.o.settings.usagePollMs });
        }
      }
    }
    try { await this.postCharges(); } catch (error) { this.o.log.error("posting charges failed", error); }
  }

  /** Raises the key's limit from zero to the tab's allowance. */
  private async activate(tab: TabRow): Promise<void> {
    if (tab.state !== "activating" || !tab.key_hash) return;
    const onChain = await this.o.chain.readTab(tab.id as Hex);
    if (onChain.finalized || onChain.closeRequestedAt !== 0n) return this.stop(tab);
    await this.o.provider.update(tab.key_hash, { disabled: false, limitMicros: BigInt(tab.allowance_micros) });
    const activated = moveTab(this.o.db, tab.id, "activating", { state: "active", next_check_at: this.now() + this.o.settings.usagePollMs, error: null });
    // Another step stopped this tab while the key was being enabled: stop it again.
    if (!activated) await this.o.provider.update(tab.key_hash, { disabled: true, limitMicros: BigInt(tab.allowance_micros) });
  }

  /**
   * Reads usage and stops the key once it is spent or its owner asked to
   * close. It also reads the escrow itself, so a missed log cannot leave a
   * key running after its tokens were released.
   */
  private async poll(tab: TabRow): Promise<void> {
    const [snapshot, onChain] = await Promise.all([this.o.provider.get(tab.key_hash!), this.o.chain.readTab(tab.id as Hex)]);
    const usage = this.recordUsage(tab, snapshot.usageMicros);
    const released = onChain.finalized || onChain.closeRequestedAt !== 0n;
    if (tab.close_requested || released || snapshot.disabled || usage + DUST_MICROS > BigInt(tab.allowance_micros)) return this.stop(getTab(this.o.db, tab.id)!);
    updateTab(this.o.db, tab.id, { next_check_at: this.now() + this.o.settings.usagePollMs, error: null });
  }

  private recordUsage(tab: TabRow, reported: bigint): bigint {
    // Usage never goes down; a lower reading is a stale replica, not a refund.
    const usage = maxBigInt(reported, BigInt(tab.usage_micros));
    updateTab(this.o.db, tab.id, { usage_micros: usage.toString(), charged: chargeFor(usage, this.rate(tab)).toString() });
    return usage;
  }

  private rate(tab: TabRow) {
    return { locked: BigInt(tab.locked), decimals: tab.decimals!, priceE18: BigInt(tab.price_e18!), markupBps: BigInt(tab.markup_bps!) };
  }

  /** Disables the key, then waits for in-flight requests to bill before settling. */
  private async stop(tab: TabRow): Promise<void> {
    await this.o.provider.update(tab.key_hash!, { disabled: true, limitMicros: BigInt(tab.allowance_micros) });
    const now = this.now();
    if (getTab(this.o.db, tab.id)!.state === "closed") return updateTab(this.o.db, tab.id, { disabled_at: now });
    updateTab(this.o.db, tab.id, { state: "settling", disabled_at: now, next_check_at: now + this.o.settings.settleDelayMs, error: null });
  }

  /** Charges final usage and returns the rest of the lock to its owner. */
  private async settle(tab: TabRow): Promise<void> {
    const { chain, provider, db } = this.o;
    let charged = 0n;
    if (tab.key_hash) {
      const snapshot = await provider.get(tab.key_hash);
      if (!snapshot.disabled) return this.stop(tab);
      this.recordUsage(tab, snapshot.usageMicros);
      charged = BigInt(getTab(db, tab.id)!.charged);
    }
    const onChain = await chain.readTab(tab.id as Hex);
    // A finalized tab is closed by the indexer when it sees the event.
    if (!onChain.finalized) {
      // Charge first, on its own: if the refund leg of `finalize` keeps failing (a token
      // the owner can make reject transfers), a force-release still cannot take back usage.
      if (charged > onChain.charged) {
        await chain.charge([{ tabId: tab.id as Hex, cumulativeCharged: charged }]);
        updateTab(db, tab.id, { charge_posted: charged.toString(), charge_posted_at: this.now() });
      }
      await chain.finalize(tab.id as Hex, charged);
    }
    const total = maxBigInt(charged, onChain.charged);
    updateTab(db, tab.id, {
      state: "closed",
      charge_posted: total.toString(),
      refunded: onChain.finalized ? tab.refunded : (BigInt(tab.locked) - total).toString(),
      closed_at: this.now(),
      error: null,
    });
  }

  private async disable(tab: TabRow): Promise<void> {
    await this.o.provider.update(tab.key_hash!, { disabled: true, limitMicros: BigInt(tab.allowance_micros) });
    updateTab(this.o.db, tab.id, { disabled_at: this.now() });
  }

  /** Posts open tabs' cumulative charges, so the operator is paid even if an owner force-releases. */
  private async postCharges(): Promise<void> {
    const now = this.now();
    const due = tabsInState(this.o.db, "active")
      .filter((t) => BigInt(t.charged) > BigInt(t.charge_posted) && now - (t.charge_posted_at ?? t.claimed_at ?? 0) >= this.o.settings.chargeIntervalMs)
      .slice(0, CHARGE_BATCH);
    if (due.length === 0) return;
    const entry = (t: TabRow) => ({ tabId: t.id as Hex, cumulativeCharged: BigInt(t.charged) });
    try {
      await this.o.chain.charge(due.map(entry));
      for (const tab of due) updateTab(this.o.db, tab.id, { charge_posted: tab.charged, charge_posted_at: now });
      return;
    } catch (error) {
      if (due.length === 1) throw error;
      this.o.log.error(`a charge batch of ${due.length} tabs failed; posting them one at a time`, error);
    }
    // One bad tab (a paused or blocklisting token) must not hold up everyone else's charges.
    for (const tab of due) {
      try {
        await this.o.chain.charge([entry(tab)]);
        updateTab(this.o.db, tab.id, { charge_posted: tab.charged, charge_posted_at: now });
      } catch (error) {
        this.o.log.error(`charging tab ${tab.id} failed`, error);
        updateTab(this.o.db, tab.id, { charge_posted_at: now });
      }
    }
  }
}
