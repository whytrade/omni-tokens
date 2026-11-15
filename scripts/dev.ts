/**
 * The whole stack on your machine, with nothing real at stake: a local chain,
 * two test tokens, the escrow, a mock OpenRouter and the server.
 *
 *   forge build && npm run dev
 *
 * Needs `anvil` and `forge` on PATH (https://getfoundry.sh), or ANVIL / FORGE set to their paths.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createPublicClient, createWalletClient, http, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { artifact, deployEscrow } from "./deploy.ts";
import { MOCK_PROVISIONING_KEY, startMockOpenRouter } from "./mock-openrouter.ts";

const RPC_PORT = Number(process.env.RPC_PORT ?? 8545);
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;
const SERVER_PORT = Number(process.env.PORT ?? 8787);
const MOCK_PORT = Number(process.env.MOCK_PORT ?? 8788);

// Anvil's well-known development accounts. Never use these anywhere real.
const ADMIN: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const OPERATOR: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const TREASURY: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const USER: Hex = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";

const children: ChildProcess[] = [];
const stop = () => { for (const child of children) child.kill(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

if (spawnSync(process.env.FORGE ?? "forge", ["build"], { stdio: "inherit" }).status !== 0) throw new Error("forge build failed");

const anvil = spawn(process.env.ANVIL ?? "anvil", ["--port", String(RPC_PORT), "--silent"], { stdio: "inherit" });
children.push(anvil);
const client = createPublicClient({ transport: http(RPC_URL) });
for (let i = 0; ; i++) {
  try { await client.getBlockNumber(); break; } catch { if (i > 50) throw new Error("anvil did not start"); await new Promise((r) => setTimeout(r, 200)); }
}

const admin = createWalletClient({ account: privateKeyToAccount(ADMIN), chain: { id: 31337 } as any, transport: http(RPC_URL) });
const user = privateKeyToAccount(USER);
const mock = artifact("MockToken");
async function token(name: string, symbol: string, decimals: number, mint: string): Promise<Address> {
  const hash = await admin.deployContract({ abi: mock.abi, bytecode: mock.bytecode, args: [name, symbol, decimals], chain: admin.chain });
  const address = (await client.waitForTransactionReceipt({ hash })).contractAddress!;
  const minted = await admin.writeContract({ address, abi: mock.abi, functionName: "mint", args: [user.address, parseUnits(mint, decimals)], chain: admin.chain });
  await client.waitForTransactionReceipt({ hash: minted });
  return address;
}
const tusd = await token("Test USD", "tUSD", 6, "1000");
const comm = await token("Community Token", "COMM", 18, "100000");
const { escrow } = await deployEscrow({
  rpcUrl: RPC_URL, deployer: ADMIN, operator: privateKeyToAccount(OPERATOR).address, sink: TREASURY, closeTimeoutSeconds: 3600n, accept: [tusd, comm],
});

const mockServer = await startMockOpenRouter(MOCK_PORT);
process.on("exit", () => mockServer.close());

const server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/main.ts"], {
  stdio: "inherit",
  env: {
    ...process.env,
    CHAIN_ID: "31337",
    RPC_URL,
    ESCROW_ADDRESS: escrow,
    OPERATOR_PRIVATE_KEY: OPERATOR,
    OPENROUTER_PROVISIONING_KEY: MOCK_PROVISIONING_KEY,
    OPENROUTER_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/api/v1`,
    TOKENS: JSON.stringify([{ address: tusd, price: "1" }, { address: comm, price: "0.01" }]),
    MARKUP_BPS: "11000",
    SETTLE_DELAY_SECONDS: "5",
    CHARGE_INTERVAL_SECONDS: "30",
    USAGE_POLL_SECONDS: "3",
    WORKER_INTERVAL_MS: "1000",
    DATABASE_PATH: ":memory:",
    PORT: String(SERVER_PORT),
  },
});
children.push(server);

console.log(`
  chain      ${RPC_URL} (chain id 31337)
  escrow     ${escrow}
  tokens     tUSD ${tusd} ($1) · COMM ${comm} ($0.01)
  openrouter http://127.0.0.1:${MOCK_PORT}/api/v1 (mock: every call costs $0.01)
  app        http://localhost:${SERVER_PORT}

  Test wallet ${user.address} holds 1000 tUSD and 100000 COMM.
  Import its key into a browser wallet on the local network, or use the CLI:

    TAB_SERVER=http://localhost:${SERVER_PORT} RPC_URL=${RPC_URL} PRIVATE_KEY=${USER} npm run tab -- open tUSD 12
`);
