import { AgentScopeSchema, type AgentScope } from "@travel/contracts";
import { z } from "zod";

const PublicKeySchema = z.object({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().min(1),
  y: z.string().min(1),
}).strict();

const PreparedAgentRunSchema = z.object({
  publicKeyJwk: PublicKeySchema,
  pairingCodeHash: z.string().length(43),
  pairingCodeFingerprint: z.string().min(1).max(128),
}).strict();

const PrepareResponseSchema = z.object({ ok: z.literal(true), data: PreparedAgentRunSchema }).strict();
const ClaimResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({ agentRunId: z.string().min(1), status: z.literal("claimed") }).strict(),
}).strict();

export type PreparedAgentRun = z.infer<typeof PreparedAgentRunSchema>;
export type LocalAgentClaim = z.infer<typeof ClaimResponseSchema>["data"];

export interface LocalAgentBridge {
  prepare(scope: AgentScope[], options?: { signal?: AbortSignal }): Promise<PreparedAgentRun>;
  claim(agentRunId: string, options?: { signal?: AbortSignal }): Promise<LocalAgentClaim>;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function strictLoopbackOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("INVALID_BRIDGE_URL");
  }
  const port = Number(url.port);
  if (url.protocol !== "http:"
    || url.hostname !== "127.0.0.1"
    || !url.port
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash) {
    throw new Error("INVALID_BRIDGE_URL");
  }
  return url.origin;
}

export class LocalAgentBridgeClient implements LocalAgentBridge {
  private readonly origin: string;
  private readonly fetch: FetchLike;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, options: { fetch?: FetchLike; timeoutMs?: number } = {}) {
    this.origin = strictLoopbackOrigin(baseUrl);
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  private async post(path: string, body: Record<string, unknown>, signal?: AbortSignal) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timeout = globalThis.setTimeout(() => controller.abort(new Error("BRIDGE_TIMEOUT")), this.timeoutMs);
    try {
      const response = await this.fetch(`${this.origin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        credentials: "omit",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("BRIDGE_UNAVAILABLE");
      try {
        return await response.json();
      } catch {
        if (controller.signal.aborted) throw new Error("BRIDGE_UNAVAILABLE");
        throw new Error("INVALID_BRIDGE_RESPONSE");
      }
    } catch (error) {
      if (error instanceof Error && (error.message === "BRIDGE_UNAVAILABLE" || error.message === "INVALID_BRIDGE_RESPONSE")) throw error;
      throw new Error("BRIDGE_UNAVAILABLE");
    } finally {
      globalThis.clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  async prepare(scope: AgentScope[], options: { signal?: AbortSignal } = {}): Promise<PreparedAgentRun> {
    const parsedScope = AgentScopeSchema.array().min(1).max(4).refine((value) => new Set(value).size === value.length).parse(scope);
    const response = await this.post("/v1/agent-runs/prepare", { scope: parsedScope }, options.signal);
    const parsed = PrepareResponseSchema.safeParse(response);
    if (!parsed.success) throw new Error("INVALID_BRIDGE_RESPONSE");
    return parsed.data.data;
  }

  async claim(agentRunId: string, options: { signal?: AbortSignal } = {}): Promise<LocalAgentClaim> {
    const response = await this.post("/v1/agent-runs/claim", { agentRunId: z.string().min(1).parse(agentRunId) }, options.signal);
    const parsed = ClaimResponseSchema.safeParse(response);
    if (!parsed.success || parsed.data.data.agentRunId !== agentRunId) throw new Error("INVALID_BRIDGE_RESPONSE");
    return parsed.data.data;
  }
}
