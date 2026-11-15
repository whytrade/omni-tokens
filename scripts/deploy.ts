/**
 * Deploys TabEscrow and accepts tokens. Run `forge build` first.
 *
 *   RPC_URL=… DEPLOYER_PRIVATE_KEY=0x… OPERATOR_ADDRESS=0x… SINK=burn|0xTreasury \
 *   ACCEPT_TOKENS=0xToken,0xToken npm run deploy
 *
 * SINK=burn sends charged tokens to 0x…dEaD. CLOSE_TIMEOUT_SECONDS defaults to 3 days.
 * The deployer becomes the admin: hand it to a multisig with transferAdmin.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { escrowAbi } from "../src/abi.ts";

export const DEAD: Address = "0x000000000000000000000000000000000000dEaD";

export function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const path = new URL(`../out/${name}.sol/${name}.json`, import.meta.url);
  try {
    const json = JSON.parse(readFileSync(path, "utf8"));
    return { abi: json.abi, bytecode: json.bytecode.object };
  } catch {
    throw new Error(`missing ${name} build output: run \`forge build\` first`);
  }
}

export async function deployEscrow(options: { rpcUrl: string; deployer: Hex; operator: Address; sink: Address; closeTimeoutSeconds: bigint; accept: Address[] }) {
  const account = privateKeyToAccount(options.deployer);
  const client = createPublicClient({ transport: http(options.rpcUrl) });
  const chain = { id: await client.getChainId() } as any;
  const wallet = createWalletClient({ account, chain, transport: http(options.rpcUrl) });
  const { abi, bytecode } = artifact("TabEscrow");
  const hash = await wallet.deployContract({ abi, bytecode, args: [options.operator, options.sink, options.closeTimeoutSeconds], chain });
  const receipt = await client.waitForTransactionReceipt({ hash });
  const escrow = receipt.contractAddress!;
  for (const token of options.accept) {
    const tx = await wallet.writeContract({ address: escrow, abi: escrowAbi, functionName: "setAccepted", args: [token, true], chain });
    await client.waitForTransactionReceipt({ hash: tx });
  }
  return { escrow, startBlock: receipt.blockNumber };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = (name: string, fallback?: string) => {
    const value = process.env[name]?.trim() || fallback;
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const operatorKey = process.env.OPERATOR_PRIVATE_KEY?.trim() as Hex | undefined;
  const operator = (process.env.OPERATOR_ADDRESS?.trim() || (operatorKey && privateKeyToAccount(operatorKey).address)) as Address;
  if (!operator) throw new Error("OPERATOR_ADDRESS or OPERATOR_PRIVATE_KEY is required");
  const sinkSetting = env("SINK");
  const { escrow, startBlock } = await deployEscrow({
    rpcUrl: env("RPC_URL"),
    deployer: env("DEPLOYER_PRIVATE_KEY") as Hex,
    operator,
    sink: (sinkSetting === "burn" ? DEAD : sinkSetting) as Address,
    closeTimeoutSeconds: BigInt(env("CLOSE_TIMEOUT_SECONDS", "259200")),
    accept: (process.env.ACCEPT_TOKENS ?? "").split(",").map((t) => t.trim()).filter(Boolean) as Address[],
  });
  console.log(`ESCROW_ADDRESS=${escrow}\nESCROW_START_BLOCK=${startBlock}`);
}
