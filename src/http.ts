import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { HttpError } from "./errors.ts";
import type { Log } from "./log.ts";
import { CLAIM_WINDOW_MS, type TabService } from "./tabs.ts";
import { formatDecimal } from "./units.ts";

export type HttpOptions = {
  tabs: TabService;
  info: { chainId: number; escrow: string; sink: string; closeTimeoutSeconds: number; markupBps: bigint; minTabMicros: bigint; maxTabMicros: bigint; publicUrl: string };
  /** Static files served at their path, such as the web page at "/". */
  files: Record<string, { path: string; type: string }>;
  corsOrigins: string[];
  log: Log;
  now?: () => number;
};

const ID = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function createHttpServer(o: HttpOptions): Server {
  const now = o.now ?? Date.now;

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = request.method ?? "GET";

    if (method === "GET" && o.files[path]) {
      const file = o.files[path];
      response.writeHead(200, { "content-type": file.type, "cache-control": "no-cache" });
      response.end(await readFile(file.path));
      return;
    }
    if (method === "GET" && path === "/health") return send(response, 200, { ok: true });

    if (method === "GET" && path === "/api/config") {
      const tokens = await Promise.all(o.tabs.tokenList().map(async (t) => {
        const price = await o.tabs.currentPrice(t.address);
        return { ...t, priceUsd: price === null ? null : formatDecimal(price, 18) };
      }));
      return send(response, 200, {
        chainId: o.info.chainId,
        escrow: o.info.escrow,
        sink: o.info.sink,
        closeTimeoutSeconds: o.info.closeTimeoutSeconds,
        markupBps: Number(o.info.markupBps),
        minTabUsd: formatDecimal(o.info.minTabMicros, 6),
        maxTabUsd: formatDecimal(o.info.maxTabMicros, 6),
        publicUrl: o.info.publicUrl,
        openrouterBaseUrl: "https://openrouter.ai/api/v1",
        tokens,
      });
    }

    if (method === "GET" && path === "/api/quote") {
      const token = url.searchParams.get("token") ?? "";
      const amount = url.searchParams.get("amount") ?? "";
      if (!ADDRESS.test(token) || !/^\d{1,78}$/.test(amount)) throw new HttpError(400, "invalid_request", "token must be an address and amount a whole number of token units.");
      return send(response, 200, await o.tabs.quote(token.toLowerCase() as `0x${string}`, BigInt(amount)));
    }

    if (method === "GET" && path === "/api/tabs") {
      const owner = url.searchParams.get("owner") ?? "";
      if (!ADDRESS.test(owner)) throw new HttpError(400, "invalid_request", "owner must be an address.");
      return send(response, 200, { tabs: o.tabs.list(owner) });
    }

    const tabMatch = /^\/api\/tabs\/(0x[0-9a-fA-F]{64})(\/claim|\/claim-message)?$/.exec(path);
    if (tabMatch && ID.test(tabMatch[1])) {
      const [, id, action] = tabMatch;
      if (method === "GET" && !action) return send(response, 200, o.tabs.view(id));
      if (method === "GET" && action === "/claim-message") {
        const expiresAt = now() + CLAIM_WINDOW_MS / 2;
        return send(response, 200, { message: o.tabs.claimMessage(id, expiresAt), expiresAt });
      }
      if (method === "POST" && action === "/claim") {
        const body = await readJson(request);
        if (typeof body.signature !== "string" || typeof body.expiresAt !== "number") {
          throw new HttpError(400, "invalid_request", "Send { signature, expiresAt } from /claim-message.");
        }
        return send(response, 200, await o.tabs.claim(id, body.signature as `0x${string}`, body.expiresAt));
      }
    }
    throw new HttpError(404, "not_found", "No such route.");
  }

  return createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (origin && o.corsOrigins.includes(origin)) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "origin");
      response.setHeader("access-control-allow-headers", "content-type");
      response.setHeader("access-control-allow-methods", "GET, POST");
    }
    if (request.method === "OPTIONS") return void response.writeHead(204).end();
    try {
      await route(request, response);
    } catch (error) {
      if (error instanceof HttpError) return send(response, error.status, { error: { code: error.code, message: error.message } });
      o.log.error(`${request.method} ${request.url} failed`, error);
      send(response, 500, { error: { code: "internal", message: "Something went wrong." } });
    }
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return void response.end();
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw new HttpError(413, "too_large", "Request body is too large.");
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {}
  throw new HttpError(400, "invalid_request", "Expected a JSON object.");
}
