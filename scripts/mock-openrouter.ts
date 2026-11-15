/**
 * A local stand-in for OpenRouter: the key-provisioning API the server uses,
 * plus `/key`, `/models` and `/chat/completions` for the keys it issues, so the
 * whole flow runs offline. Each completion bills a flat $0.01.
 *
 *   node scripts/mock-openrouter.ts            # http://127.0.0.1:8788/api/v1
 */
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";

type Key = { hash: string; secret: string; name: string; disabled: boolean; usage: number; limit: number | null };

export const MOCK_PROVISIONING_KEY = "sk-or-v1-mock-provisioning";
const COST_PER_CALL = 0.01;

export function startMockOpenRouter(port = 8788, credits = 1_000): Promise<Server> {
  const keys = new Map<string, Key>();
  const bySecret = new Map<string, Key>();

  const server = createServer(async (request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const token = (request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    let body: any = {};
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    if (chunks.length) try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return send(400, { error: { message: "bad json" } }); }

    // Provisioning API.
    if (path === "/keys" || path.startsWith("/keys/") || path === "/credits") {
      if (token !== MOCK_PROVISIONING_KEY) return send(401, { error: { message: "provisioning key required" } });
      if (path === "/credits") {
        const used = [...keys.values()].reduce((sum, k) => sum + k.usage, 0);
        return send(200, { data: { total_credits: credits, total_usage: used } });
      }
      if (path === "/keys" && request.method === "POST") {
        const secret = `sk-or-v1-${randomBytes(24).toString("hex")}`;
        const key: Key = { hash: randomBytes(16).toString("hex"), secret, name: body.name, disabled: false, usage: 0, limit: body.limit ?? null };
        keys.set(key.hash, key);
        bySecret.set(secret, key);
        return send(201, { key: secret, data: snapshot(key) });
      }
      const key = keys.get(decodeURIComponent(path.slice("/keys/".length)));
      if (!key) return send(404, { error: { message: "no such key" } });
      if (request.method === "PATCH") {
        if (typeof body.disabled === "boolean") key.disabled = body.disabled;
        if (body.limit !== undefined) key.limit = body.limit;
      }
      return send(200, { data: snapshot(key) });
    }

    // Inference API, for issued keys.
    if (path === "/models") return send(200, { data: [{ id: "mock/echo", name: "Mock echo", pricing: { request: String(COST_PER_CALL) } }] });
    const key = bySecret.get(token);
    if (!key) return send(401, { error: { message: "unknown key" } });
    const remaining = key.limit === null ? null : Math.max(0, key.limit - key.usage);
    if (path === "/key") return send(200, { data: { label: key.name, limit: key.limit, usage: key.usage, limit_remaining: remaining, disabled: key.disabled } });
    if (path === "/chat/completions" && request.method === "POST") {
      if (key.disabled) return send(403, { error: { message: "key disabled" } });
      if (remaining !== null && remaining < COST_PER_CALL) return send(402, { error: { message: "key limit reached" } });
      key.usage = Math.round((key.usage + COST_PER_CALL) * 1e6) / 1e6;
      const last = Array.isArray(body.messages) ? body.messages.at(-1)?.content : "";
      return send(200, {
        id: `gen-${randomBytes(8).toString("hex")}`,
        model: body.model ?? "mock/echo",
        choices: [{ index: 0, message: { role: "assistant", content: `echo: ${last}` }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: COST_PER_CALL },
      });
    }
    return send(404, { error: { message: "not found" } });
  });

  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

function snapshot(key: Key) {
  return { hash: key.hash, name: key.name, disabled: key.disabled, usage: key.usage, limit: key.limit, limit_reset: null, byok_usage: 0 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8788);
  await startMockOpenRouter(port);
  console.log(`mock OpenRouter on http://127.0.0.1:${port}/api/v1 · provisioning key ${MOCK_PROVISIONING_KEY}`);
}
