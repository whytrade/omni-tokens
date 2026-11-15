import { createPublicClient, http } from "viem";
import { fileURLToPath } from "node:url";
import { escrowAbi } from "./abi.ts";
import { ViemChain } from "./chain.ts";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db.ts";
import { createHttpServer } from "./http.ts";
import { consoleLog as log } from "./log.ts";
import { OpenRouterKeys } from "./openrouter.ts";
import { Prices } from "./prices.ts";
import { TabService } from "./tabs.ts";

const config = loadConfig(process.env);
const chain = new ViemChain(config);
const client = createPublicClient({ transport: http(config.rpcUrl) });
const [onChainOperator, sink, closeTimeout, chainId] = await Promise.all([
  client.readContract({ address: config.escrow, abi: escrowAbi, functionName: "operator" }),
  client.readContract({ address: config.escrow, abi: escrowAbi, functionName: "sink" }),
  client.readContract({ address: config.escrow, abi: escrowAbi, functionName: "closeTimeout" }),
  client.getChainId(),
]);
if (chainId !== config.chainId) throw new Error(`RPC_URL serves chain ${chainId}, not CHAIN_ID ${config.chainId}`);
if (onChainOperator.toLowerCase() !== chain.operator.toLowerCase()) {
  throw new Error(`OPERATOR_PRIVATE_KEY is ${chain.operator}, but the escrow's operator is ${onChainOperator}`);
}
for (const token of config.tokens) {
  const ok = await client.readContract({ address: config.escrow, abi: escrowAbi, functionName: "accepted", args: [token.address] });
  if (!ok) log.error(`${token.address} is in TOKENS but the escrow does not accept it; run setAccepted as the escrow admin`);
}

const db = openDatabase(config.databasePath);
const tabs = new TabService({
  db,
  chain,
  provider: new OpenRouterKeys(config.openrouter.provisioningKey, config.openrouter.baseUrl),
  prices: new Prices(chain),
  tokens: config.tokens,
  settings: config,
  log,
});
await tabs.init();

const web = (name: string) => fileURLToPath(new URL(`../web/${name}`, import.meta.url));
const server = createHttpServer({
  tabs,
  info: { ...config, sink: sink.toLowerCase(), closeTimeoutSeconds: Number(closeTimeout) },
  files: {
    "/": { path: web("index.html"), type: "text/html; charset=utf-8" },
    "/skill.md": { path: fileURLToPath(new URL("../skill/SKILL.md", import.meta.url)), type: "text/markdown; charset=utf-8" },
  },
  corsOrigins: config.corsOrigins,
  log,
});
server.listen(config.port, config.host, () => log.info(`listening on http://${config.host}:${config.port} · escrow ${config.escrow} on chain ${config.chainId}`));

let running: Promise<void> | null = null;
const timer = setInterval(() => {
  running ??= tabs.tick().catch((error) => log.error("worker failed", error)).finally(() => { running = null; });
}, config.workerIntervalMs);

async function shutdown() {
  clearInterval(timer);
  server.close();
  await running;
  db.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
