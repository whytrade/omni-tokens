#!/usr/bin/env node
/**
 * tab: open, check and close inference tabs from a terminal or an agent.
 *
 *   tab tokens                      what the server accepts, and prices
 *   tab quote <token> <amount>      what a lock would buy
 *   tab open <token> <amount>       lock tokens and print the OpenRouter key
 *   tab claim <tabId>               print the key for a tab that is open but unclaimed
 *   tab status [tabId]              your tabs, or one tab
 *   tab close <tabId>               stop the key and get the rest back
 *   tab release <tabId>             take the rest back if the server never settles
 *
 * Environment: TAB_SERVER (default http://localhost:8787), RPC_URL, PRIVATE_KEY.
 * <token> is a symbol from `tab tokens` or an address. Add --json for machine output.
 */
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http, parseEventLogs, parseUnits, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";
import { escrowAbi } from "../src/abi.ts";

const args = process.argv.slice(2).filter((a) => a !== "--json");
const json = process.argv.includes("--json");
const server = (process.env.TAB_SERVER ?? "http://localhost:8787").replace(/\/+$/, "");

type Token = { address: Address; symbol: string; decimals: number; priceUsd: string | null };
type ServerConfig = { chainId: number; escrow: Address; tokens: Token[]; minTabUsd: string; maxTabUsd: string; markupBps: number; closeTimeoutSeconds: number };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${server}${path}`, { ...init, headers: { "content-type": "application/json" } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body?.error?.message ?? `${path} failed (${response.status})`), { code: body?.error?.code });
  return body as T;
}

function out(human: string, data: unknown) {
  console.log(json ? JSON.stringify(data, null, 2) : human);
}

function wallet(config: ServerConfig) {
  const key = process.env.PRIVATE_KEY?.trim() as Hex | undefined;
  const rpc = process.env.RPC_URL?.trim();
  if (!key || !rpc) throw new Error("PRIVATE_KEY and RPC_URL are required to send transactions");
  const account = privateKeyToAccount(key);
  const chain = { id: config.chainId } as any;
  return {
    account,
    client: createPublicClient({ transport: http(rpc) }),
    wallet: createWalletClient({ account, chain, transport: http(rpc) }),
    chain,
  };
}

function findToken(config: ServerConfig, query: string): Token {
  const token = config.tokens.find((t) => t.symbol.toLowerCase() === query.toLowerCase() || t.address.toLowerCase() === query.toLowerCase());
  if (!token) throw new Error(`unknown token ${query}; try \`tab tokens\``);
  return token;
}

async function claim(tabId: Hex, sign: (message: string) => Promise<Hex>) {
  const { message, expiresAt } = await api<{ message: string; expiresAt: number }>(`/api/tabs/${tabId}/claim-message`);
  const signature = await sign(message);
  return api<{ key: string; tab: any }>(`/api/tabs/${tabId}/claim`, { method: "POST", body: JSON.stringify({ signature, expiresAt }) });
}

async function waitForTab(tabId: Hex) {
  for (let i = 0; i < 120; i++) {
    try { return await api<any>(`/api/tabs/${tabId}`); } catch (error: any) { if (error.code !== "not_found") throw error; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`the server has not seen tab ${tabId} yet; run \`tab claim ${tabId}\` later`);
}

function describe(tab: any) {
  const d = tab.token.decimals ?? 18;
  const sym = tab.token.symbol ?? tab.token.address;
  const lines = [
    `${tab.id}  ${tab.state}${tab.closeRequested && tab.state !== "closed" ? " (closing)" : ""}`,
    `  locked   ${formatUnits(BigInt(tab.locked), d)} ${sym}`,
    `  limit    $${tab.limitUsd}   used $${tab.usageUsd}   left $${tab.remainingUsd}`,
    `  charged  ${formatUnits(BigInt(tab.charged), d)} ${sym}`,
  ];
  if (tab.refunded !== null) lines.push(`  refunded ${formatUnits(BigInt(tab.refunded), d)} ${sym}${tab.forced ? " (force-released)" : ""}`);
  if (tab.keyHint) lines.push(`  key      sk-or-…${tab.keyHint}`);
  if (tab.note) lines.push(`  note     ${tab.note}`);
  return lines.join("\n");
}

const [command, ...rest] = args;
const config = await api<ServerConfig>("/api/config");

switch (command) {
  case "tokens": {
    out(config.tokens.map((t) => `${t.symbol.padEnd(8)} ${t.address}  $${t.priceUsd ?? "?"}`).join("\n") +
      `\n\ntabs buy $${config.minTabUsd}–$${config.maxTabUsd} of inference · markup ${(config.markupBps / 100 - 100).toFixed(1)}%` +
      ` · release works ${config.closeTimeoutSeconds / 3600}h after a close request`, config);
    break;
  }
  case "quote": {
    const token = findToken(config, rest[0] ?? "");
    const amount = parseUnits(rest[1] ?? "", token.decimals);
    const quote = await api<any>(`/api/quote?token=${token.address}&amount=${amount}`);
    out(`${rest[1]} ${token.symbol} buys a $${quote.limitUsd} OpenRouter key${quote.capped ? " (capped)" : ""}${quote.belowMinimum ? ` — below the $${config.minTabUsd} minimum` : ""}`, quote);
    break;
  }
  case "open": {
    const token = findToken(config, rest[0] ?? "");
    const amount = parseUnits(rest[1] ?? "", token.decimals);
    const quote = await api<any>(`/api/quote?token=${token.address}&amount=${amount}`);
    if (quote.belowMinimum) throw new Error(`that buys $${quote.limitUsd}, below the $${config.minTabUsd} minimum`);
    const { account, client, wallet: w, chain } = wallet(config);
    const allowance = await client.readContract({ address: token.address, abi: erc20Abi, functionName: "allowance", args: [account.address, config.escrow] });
    if (allowance < amount) {
      const hash = await w.writeContract({ address: token.address, abi: erc20Abi, functionName: "approve", args: [config.escrow, amount], chain });
      await client.waitForTransactionReceipt({ hash });
    }
    const hash = await w.writeContract({ address: config.escrow, abi: escrowAbi, functionName: "open", args: [token.address, toHex(randomBytes(32)), amount], chain });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`open transaction ${hash} reverted`);
    const [opened] = parseEventLogs({ abi: escrowAbi, logs: receipt.logs, eventName: "TabOpened" });
    const tabId = opened.args.tabId;
    if (!json) console.error(`opened tab ${tabId}; waiting for the server…`);
    await waitForTab(tabId);
    const { key, tab } = await claim(tabId, (message) => account.signMessage({ message }));
    out(`${describe(tab)}\n\nOPENROUTER_API_KEY=${key}\n\nUse it with any OpenRouter-compatible app (base URL https://openrouter.ai/api/v1). It is shown once.`, { key, tab });
    break;
  }
  case "claim": {
    const { account } = wallet(config);
    const { key, tab } = await claim(rest[0] as Hex, (message) => account.signMessage({ message }));
    out(`${describe(tab)}\n\nOPENROUTER_API_KEY=${key}`, { key, tab });
    break;
  }
  case "status": {
    if (rest[0]) {
      const tab = await api<any>(`/api/tabs/${rest[0]}`);
      out(describe(tab), tab);
    } else {
      const owner = process.env.OWNER ?? privateKeyToAccount(process.env.PRIVATE_KEY as Hex).address;
      const { tabs } = await api<{ tabs: any[] }>(`/api/tabs?owner=${owner}`);
      out(tabs.length ? tabs.map(describe).join("\n\n") : "no tabs", tabs);
    }
    break;
  }
  case "close":
  case "release": {
    const { client, wallet: w, chain } = wallet(config);
    const functionName = command === "close" ? "requestClose" : "forceRelease";
    const hash = await w.writeContract({ address: config.escrow, abi: escrowAbi, functionName, args: [rest[0] as Hex], chain });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} transaction ${hash} reverted`);
    out(command === "close"
      ? `close requested; the server stops the key and refunds the rest. If it never does, run \`tab release ${rest[0]}\` after ${config.closeTimeoutSeconds / 3600}h.`
      : "released: everything not yet charged is back in your wallet.", { hash });
    break;
  }
  default:
    console.log(`usage: tab tokens | quote <token> <amount> | open <token> <amount> | claim <tabId> | status [tabId] | close <tabId> | release <tabId>`);
    process.exit(command ? 1 : 0);
}
