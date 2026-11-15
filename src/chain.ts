import { createPublicClient, createWalletClient, defineChain, erc20Abi, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { escrowAbi, feedAbi, v3PoolAbi } from "./abi.ts";
import type { PriceReader } from "./prices.ts";

export type EventRef = { blockNumber: bigint; txHash: Hex; logIndex: number };
export type EscrowEvent =
  | (EventRef & { name: "TabOpened"; tabId: Hex; owner: Address; token: Address; amount: bigint })
  | (EventRef & { name: "TabCharged"; tabId: Hex; cumulativeCharged: bigint })
  | (EventRef & { name: "TabCloseRequested"; tabId: Hex })
  | (EventRef & { name: "TabFinalized"; tabId: Hex; charged: bigint; refunded: bigint; forced: boolean });

export type OnChainTab = { owner: Address; token: Address; closeRequestedAt: bigint; finalized: boolean; locked: bigint; charged: bigint };

/** Everything the server reads from and writes to the chain. Tests use a fake. */
export interface Chain extends PriceReader {
  latestBlock(): Promise<bigint>;
  /** Escrow events in log order, both ends inclusive. */
  events(fromBlock: bigint, toBlock: bigint): Promise<EscrowEvent[]>;
  readTab(tabId: Hex): Promise<OnChainTab>;
  symbol(token: Address): Promise<string>;
  /** Accepts EOA, ERC-1271 and ERC-6492 signatures. */
  verifyMessage(signer: Address, message: string, signature: Hex): Promise<boolean>;
  /** Operator transactions. Each resolves once mined successfully. */
  charge(entries: { tabId: Hex; cumulativeCharged: bigint }[]): Promise<Hex>;
  finalize(tabId: Hex, finalCumulativeCharged: bigint): Promise<Hex>;
}

const lower = <T extends string>(value: string) => value.toLowerCase() as T;

export class ViemChain implements Chain {
  private readonly escrow: Address;
  private readonly client;
  private readonly wallet;

  constructor(options: { rpcUrl: string; chainId: number; escrow: Address; operatorPrivateKey: Hex }) {
    const chain = defineChain({
      id: options.chainId,
      name: `Chain ${options.chainId}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [options.rpcUrl] } },
    });
    const transport = http(options.rpcUrl);
    this.escrow = options.escrow;
    this.client = createPublicClient({ chain, transport, pollingInterval: 1_000 });
    this.wallet = createWalletClient({ account: privateKeyToAccount(options.operatorPrivateKey), chain, transport });
  }

  get operator(): Address {
    return this.wallet.account.address;
  }

  latestBlock() {
    return this.client.getBlockNumber({ cacheTime: 0 });
  }

  async events(fromBlock: bigint, toBlock: bigint): Promise<EscrowEvent[]> {
    const logs = await this.client.getContractEvents({ address: this.escrow, abi: escrowAbi, fromBlock, toBlock, strict: true });
    const events: EscrowEvent[] = [];
    for (const log of logs) {
      const ref = { blockNumber: log.blockNumber, txHash: log.transactionHash, logIndex: log.logIndex };
      const args = log.args as Record<string, any>;
      const tabId = lower<Hex>(args.tabId);
      if (log.eventName === "TabOpened") events.push({ ...ref, name: "TabOpened", tabId, owner: lower(args.owner), token: lower(args.token), amount: args.amount });
      else if (log.eventName === "TabCharged") events.push({ ...ref, name: "TabCharged", tabId, cumulativeCharged: args.cumulativeCharged });
      else if (log.eventName === "TabCloseRequested") events.push({ ...ref, name: "TabCloseRequested", tabId });
      else if (log.eventName === "TabFinalized") events.push({ ...ref, name: "TabFinalized", tabId, charged: args.charged, refunded: args.refunded, forced: args.forced });
    }
    return events.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
  }

  async readTab(tabId: Hex): Promise<OnChainTab> {
    const [owner, token, closeRequestedAt, finalized, locked, charged] = await this.client.readContract({
      address: this.escrow, abi: escrowAbi, functionName: "tabs", args: [tabId],
    });
    return { owner: lower(owner), token: lower(token), closeRequestedAt, finalized, locked, charged };
  }

  async decimals(token: Address) {
    return Number(await this.client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }));
  }

  symbol(token: Address) {
    return this.client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" });
  }

  async feed(feed: Address) {
    const [decimals, round] = await Promise.all([
      this.client.readContract({ address: feed, abi: feedAbi, functionName: "decimals" }),
      this.client.readContract({ address: feed, abi: feedAbi, functionName: "latestRoundData" }),
    ]);
    return { answer: round[1], decimals: Number(decimals), updatedAt: round[3] };
  }

  async pool(pool: Address, secondsAgo: number) {
    const [token0, token1, observed] = await Promise.all([
      this.client.readContract({ address: pool, abi: v3PoolAbi, functionName: "token0" }),
      this.client.readContract({ address: pool, abi: v3PoolAbi, functionName: "token1" }),
      this.client.readContract({ address: pool, abi: v3PoolAbi, functionName: "observe", args: [[secondsAgo, 0]] }),
    ]);
    const [older, newer] = observed[0];
    return { token0: lower<Address>(token0), token1: lower<Address>(token1), tickCumulatives: [older, newer] as [bigint, bigint] };
  }

  verifyMessage(signer: Address, message: string, signature: Hex) {
    return this.client.verifyMessage({ address: signer, message, signature });
  }

  async charge(entries: { tabId: Hex; cumulativeCharged: bigint }[]) {
    return this.send("charge", [entries.map((e) => e.tabId), entries.map((e) => e.cumulativeCharged)]);
  }

  async finalize(tabId: Hex, finalCumulativeCharged: bigint) {
    return this.send("finalize", [tabId, finalCumulativeCharged]);
  }

  private async send(functionName: "charge" | "finalize", args: readonly unknown[]): Promise<Hex> {
    const hash = await this.wallet.writeContract({ address: this.escrow, abi: escrowAbi, functionName, args } as any);
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} transaction ${hash} reverted`);
    return hash;
  }
}
