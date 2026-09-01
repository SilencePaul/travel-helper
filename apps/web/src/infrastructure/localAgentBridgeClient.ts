import {
  CandidateCategorySchema,
  ResearchErrorCodeSchema,
  ResearchResumeActionSchema,
  ResearchStatusSchema,
  type CandidateCategory,
  type ResearchErrorCode,
  type ResearchResumeAction,
  type ResearchStatus,
} from "@travel/contracts";
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
const ResearchStatusResponseSchema = z.object({
  ok: z.literal(true),
  data: ResearchStatusSchema,
}).strict();
const ErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: ResearchErrorCodeSchema,
}).strict();
const OpaqueIdentifierSchema = z.string().min(1).max(1_024);
const ExecuteTravelResearchInputSchema = z.object({
  agentRunId: OpaqueIdentifierSchema,
  targetCategory: CandidateCategorySchema,
  targetScopeId: z.string().regex(/^scope_[a-f0-9]{64}$/u),
  disclosureFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
const ResumeTravelResearchInputSchema = z.object({
  agentRunId: OpaqueIdentifierSchema,
  researchTaskId: OpaqueIdentifierSchema,
  resumeAction: ResearchResumeActionSchema,
}).strict();
const CancelResearchInputSchema = z.object({
  researchTaskId: OpaqueIdentifierSchema,
}).strict();

export type PreparedAgentRun = z.infer<typeof PreparedAgentRunSchema>;
export type LocalAgentClaim = z.infer<typeof ClaimResponseSchema>["data"];
export type RequestOptions = { signal?: AbortSignal };
export type ExecuteTravelResearchInput = {
  agentRunId: string;
  targetCategory: CandidateCategory;
  targetScopeId: string;
  disclosureFingerprint: string;
};
export type ResumeTravelResearchInput = {
  agentRunId: string;
  researchTaskId: string;
  resumeAction: ResearchResumeAction;
};
export type CancelResearchInput = { researchTaskId: string };
export type LocalAgentBridgeErrorCode = ResearchErrorCode | "BRIDGE_UNAVAILABLE" | "INVALID_BRIDGE_RESPONSE";

export class LocalAgentBridgeError extends Error {
  readonly code: LocalAgentBridgeErrorCode;

  constructor(code: LocalAgentBridgeErrorCode) {
    super(code);
    this.name = "LocalAgentBridgeError";
    this.code = code;
  }
}

export interface LocalAgentBridge {
  prepare(options?: RequestOptions): Promise<PreparedAgentRun>;
  claim(agentRunId: string, options?: RequestOptions): Promise<LocalAgentClaim>;
  executeTravelResearch(input: ExecuteTravelResearchInput, options?: RequestOptions): Promise<ResearchStatus>;
  getResearchStatus(options?: RequestOptions): Promise<ResearchStatus>;
  resumeTravelResearch(input: ResumeTravelResearchInput, options?: RequestOptions): Promise<ResearchStatus>;
  cancelResearch(input: CancelResearchInput, options?: RequestOptions): Promise<ResearchStatus>;
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

  private async request(
    method: "GET" | "POST",
    path: string,
    body: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timeout = globalThis.setTimeout(() => controller.abort(new Error("BRIDGE_TIMEOUT")), this.timeoutMs);
    try {
      const init: RequestInit = {
        method,
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        signal: controller.signal,
      };
      if (method === "POST") {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify(body);
      }
      let response: Response;
      try {
        response = await this.fetch(`${this.origin}${path}`, init);
      } catch {
        throw new LocalAgentBridgeError("BRIDGE_UNAVAILABLE");
      }
      let responseBody: unknown;
      try {
        responseBody = await response.json();
      } catch {
        throw new LocalAgentBridgeError(controller.signal.aborted
          ? "BRIDGE_UNAVAILABLE"
          : "INVALID_BRIDGE_RESPONSE");
      }
      if (!response.ok) {
        const errorResponse = ErrorResponseSchema.safeParse(responseBody);
        if (!errorResponse.success) throw new LocalAgentBridgeError("INVALID_BRIDGE_RESPONSE");
        throw new LocalAgentBridgeError(errorResponse.data.error);
      }
      return responseBody;
    } finally {
      globalThis.clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  async prepare(options: RequestOptions = {}): Promise<PreparedAgentRun> {
    const response = await this.request("POST", "/v1/agent-runs/prepare", {}, options.signal);
    const parsed = PrepareResponseSchema.safeParse(response);
    if (!parsed.success) throw new LocalAgentBridgeError("INVALID_BRIDGE_RESPONSE");
    return parsed.data.data;
  }

  async claim(agentRunId: string, options: RequestOptions = {}): Promise<LocalAgentClaim> {
    const response = await this.request(
      "POST",
      "/v1/agent-runs/claim",
      { agentRunId: OpaqueIdentifierSchema.parse(agentRunId) },
      options.signal,
    );
    const parsed = ClaimResponseSchema.safeParse(response);
    if (!parsed.success || parsed.data.data.agentRunId !== agentRunId) {
      throw new LocalAgentBridgeError("INVALID_BRIDGE_RESPONSE");
    }
    return parsed.data.data;
  }

  async executeTravelResearch(
    input: ExecuteTravelResearchInput,
    options: RequestOptions = {},
  ): Promise<ResearchStatus> {
    return this.researchPost("/v1/agent-runs/execute-travel-research", ExecuteTravelResearchInputSchema.parse(input), options);
  }

  async getResearchStatus(options: RequestOptions = {}): Promise<ResearchStatus> {
    const response = await this.request("GET", "/v1/agent-runs/research-status", undefined, options.signal);
    return this.parseResearchStatus(response);
  }

  async resumeTravelResearch(
    input: ResumeTravelResearchInput,
    options: RequestOptions = {},
  ): Promise<ResearchStatus> {
    return this.researchPost("/v1/agent-runs/resume-travel-research", ResumeTravelResearchInputSchema.parse(input), options);
  }

  async cancelResearch(input: CancelResearchInput, options: RequestOptions = {}): Promise<ResearchStatus> {
    return this.researchPost("/v1/agent-runs/cancel-research", CancelResearchInputSchema.parse(input), options);
  }

  private async researchPost(path: string, body: Record<string, unknown>, options: RequestOptions) {
    const response = await this.request("POST", path, body, options.signal);
    return this.parseResearchStatus(response);
  }

  private parseResearchStatus(response: unknown) {
    const parsed = ResearchStatusResponseSchema.safeParse(response);
    if (!parsed.success) throw new LocalAgentBridgeError("INVALID_BRIDGE_RESPONSE");
    return parsed.data.data;
  }
}

type FragmentLocation = { href: string; hash?: string };
type FragmentHistory = { state: unknown; replaceState(state: unknown, unused: string, url?: string | URL | null): void };

export function consumeLocalAgentBridgeFromFragment(location: FragmentLocation, history: FragmentHistory): LocalAgentBridgeClient | undefined {
  let url: URL;
  try {
    url = new URL(location.href);
  } catch {
    return undefined;
  }
  const params = new URLSearchParams(url.hash.slice(1));
  const bridgeOrigin = params.get("agentBridge");
  if (bridgeOrigin === null) return undefined;
  url.hash = "";
  try {
    history.replaceState(history.state, "", url.toString());
  } catch {
    try { location.hash = ""; } catch { /* best-effort removal */ }
  }
  try {
    return new LocalAgentBridgeClient(bridgeOrigin);
  } catch {
    return undefined;
  }
}
