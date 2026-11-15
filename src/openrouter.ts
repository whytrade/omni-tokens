import { usdToMicros } from "./units.ts";

export type KeySnapshot = { hash: string; disabled: boolean; usageMicros: bigint; limitMicros: bigint | null };

/** The provider operations a tab needs. OpenRouter is the only implementation, but tests swap in a fake. */
export interface KeyProvider {
  /** Creates a disabled-by-limit key: its limit is zero until `update` raises it. */
  create(name: string): Promise<{ secret: string; hash: string }>;
  get(hash: string): Promise<KeySnapshot>;
  update(hash: string, settings: { disabled: boolean; limitMicros: bigint }): Promise<void>;
  /** Credit left on the operator's account. */
  remainingCreditMicros(): Promise<bigint>;
}

/**
 * OpenRouter's key-provisioning API. The provisioning key can only manage
 * keys; it never makes inference requests and never leaves the server.
 */
export class OpenRouterKeys implements KeyProvider {
  private readonly token: string;
  private readonly base: string;
  private readonly fetcher: typeof fetch;

  constructor(token: string, base = "https://openrouter.ai/api/v1", fetcher: typeof fetch = fetch) {
    this.token = token;
    this.base = base.replace(/\/+$/, "");
    this.fetcher = fetcher;
  }

  private async call(path: string, method = "GET", body?: unknown): Promise<any> {
    const response = await this.fetcher(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    // Never echo an upstream body: it can carry key material.
    if (!response.ok) throw new Error(`OpenRouter ${method} ${path.split("/")[1]} failed (${response.status})`);
    return response.json();
  }

  async create(name: string) {
    const result = await this.call("/keys", "POST", { name, limit: 0, limit_reset: null, include_byok_in_limit: true });
    if (typeof result?.key !== "string" || typeof result?.data?.hash !== "string") throw new Error("OpenRouter returned an invalid key");
    return { secret: result.key, hash: result.data.hash };
  }

  async get(hash: string): Promise<KeySnapshot> {
    const { data } = await this.call(`/keys/${encodeURIComponent(hash)}`);
    if (data?.hash !== hash || typeof data.disabled !== "boolean") throw new Error("OpenRouter returned an invalid key snapshot");
    return {
      hash,
      disabled: data.disabled,
      usageMicros: usdToMicros(data.usage, "key usage"),
      limitMicros: data.limit === null || data.limit === undefined ? null : usdToMicros(data.limit, "key limit"),
    };
  }

  async update(hash: string, settings: { disabled: boolean; limitMicros: bigint }) {
    if (settings.limitMicros < 0n || settings.limitMicros > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("invalid key limit");
    await this.call(`/keys/${encodeURIComponent(hash)}`, "PATCH", {
      disabled: settings.disabled,
      limit: Number(settings.limitMicros) / 1e6,
      limit_reset: null,
      include_byok_in_limit: true,
    });
  }

  async remainingCreditMicros() {
    const { data } = await this.call("/credits");
    return usdToMicros(data?.total_credits, "credits") - usdToMicros(data?.total_usage, "credit usage");
  }
}
