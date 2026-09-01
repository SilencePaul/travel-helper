import {
  CandidateCategorySchema,
  ResearchErrorCodeSchema,
  ResearchResumeActionSchema,
  ResearchStatusSchema,
  type AgentScope,
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
const MAX_RESPONSE_BYTES = 64 * 1_024;
const MAX_RESPONSE_CHUNKS = 1_024;
const RESPONSE_YIELD_INTERVAL = 64;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

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
  /** @deprecated Temporary Task 10 migration overload. Scope is ignored and never sent; remove in Task 10. */
  prepare(scope: AgentScope[], options?: RequestOptions): Promise<PreparedAgentRun>;
  claim(agentRunId: string, options?: RequestOptions): Promise<LocalAgentClaim>;
  executeTravelResearch(input: ExecuteTravelResearchInput, options?: RequestOptions): Promise<ResearchStatus>;
  getResearchStatus(options?: RequestOptions): Promise<ResearchStatus>;
  resumeTravelResearch(input: ResumeTravelResearchInput, options?: RequestOptions): Promise<ResearchStatus>;
  cancelResearch(input: CancelResearchInput, options?: RequestOptions): Promise<ResearchStatus>;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function invalidBridgeResponse(): LocalAgentBridgeError {
  return new LocalAgentBridgeError("INVALID_BRIDGE_RESPONSE");
}

function hasPrototypeKey(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const pending: object[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const key of Object.keys(current)) {
      if (PROTOTYPE_KEYS.has(key)) return true;
      const nested = (current as Record<string, unknown>)[key];
      if (nested !== null && typeof nested === "object") pending.push(nested);
    }
  }
  return false;
}

async function cancelResponseBody(response: unknown): Promise<void> {
  try {
    const body = (response as { body?: { cancel?: () => Promise<unknown> | unknown } } | null)?.body;
    if (body && typeof body.cancel === "function") await body.cancel();
  } catch {
    // Cleanup failures must not replace the stable request error.
  }
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Cleanup failures must not replace the stable request error.
  }
}

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
    if (signal?.aborted) throw new LocalAgentBridgeError("BRIDGE_UNAVAILABLE");
    const controller = new AbortController();
    let abortRequest!: () => void;
    let aborted = false;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      abortRequest = () => {
        if (aborted) return;
        aborted = true;
        controller.abort();
        reject(new LocalAgentBridgeError("BRIDGE_UNAVAILABLE"));
      };
    });
    signal?.addEventListener("abort", abortRequest, { once: true });
    const timeout = globalThis.setTimeout(abortRequest, this.timeoutMs);
    try {
      const init: RequestInit = {
        method,
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      };
      if (method === "POST") {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify(body);
      }
      let response: Response;
      try {
        const fetchPromise = Promise.resolve(this.fetch(`${this.origin}${path}`, init)).then(
          async (lateResponse) => {
            if (aborted) {
              await cancelResponseBody(lateResponse);
              throw new LocalAgentBridgeError("BRIDGE_UNAVAILABLE");
            }
            return lateResponse;
          },
          () => { throw new LocalAgentBridgeError("BRIDGE_UNAVAILABLE"); },
        );
        response = await Promise.race([fetchPromise, abortPromise]);
      } catch {
        throw new LocalAgentBridgeError("BRIDGE_UNAVAILABLE");
      }
      let responseBody: unknown;
      try {
        responseBody = await this.readResponse(response, abortPromise);
      } catch (error) {
        if (aborted) throw new LocalAgentBridgeError("BRIDGE_UNAVAILABLE");
        throw error;
      }
      if (response.status >= 200 && response.status < 300 && response.status !== 200) {
        throw invalidBridgeResponse();
      }
      if (response.status !== 200) {
        const errorResponse = ErrorResponseSchema.safeParse(responseBody);
        if (!errorResponse.success) throw invalidBridgeResponse();
        throw new LocalAgentBridgeError(errorResponse.data.error);
      }
      return responseBody;
    } finally {
      globalThis.clearTimeout(timeout);
      signal?.removeEventListener("abort", abortRequest);
    }
  }

  private async readResponse(response: Response, abortPromise: Promise<never>): Promise<unknown> {
    let contentType: string | null;
    let declaredLength: string | null;
    try {
      contentType = response.headers?.get("content-type") ?? null;
      declaredLength = response.headers?.get("content-length") ?? null;
    } catch {
      await cancelResponseBody(response);
      throw invalidBridgeResponse();
    }
    if (contentType === null || !JSON_CONTENT_TYPE.test(contentType)) {
      await cancelResponseBody(response);
      throw invalidBridgeResponse();
    }
    if (declaredLength !== null) {
      if (!/^\d+$/u.test(declaredLength)) {
        await cancelResponseBody(response);
        throw invalidBridgeResponse();
      }
      const parsedLength = Number(declaredLength);
      if (!Number.isSafeInteger(parsedLength) || parsedLength > MAX_RESPONSE_BYTES) {
        await cancelResponseBody(response);
        throw invalidBridgeResponse();
      }
    }
    if (!response.body) throw invalidBridgeResponse();

    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      reader = response.body.getReader();
    } catch {
      await cancelResponseBody(response);
      throw invalidBridgeResponse();
    }
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let source = "";
    let receivedBytes = 0;
    let receivedChunks = 0;
    let completed = false;
    try {
      while (true) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          const readPromise = Promise.resolve(reader.read())
            .catch(() => { throw new LocalAgentBridgeError("BRIDGE_UNAVAILABLE"); });
          chunk = await Promise.race([readPromise, abortPromise]);
        } catch (error) {
          if (error instanceof LocalAgentBridgeError) throw error;
          throw new LocalAgentBridgeError("BRIDGE_UNAVAILABLE");
        }
        if (chunk.done) {
          completed = true;
          break;
        }
        receivedChunks += 1;
        if (receivedChunks > MAX_RESPONSE_CHUNKS) throw invalidBridgeResponse();
        if (!ArrayBuffer.isView(chunk.value) || chunk.value.BYTES_PER_ELEMENT !== 1) {
          throw invalidBridgeResponse();
        }
        const bytes = new Uint8Array(chunk.value.buffer, chunk.value.byteOffset, chunk.value.byteLength);
        if (bytes.byteLength === 0) throw invalidBridgeResponse();
        receivedBytes += bytes.byteLength;
        if (receivedBytes > MAX_RESPONSE_BYTES) throw invalidBridgeResponse();
        try {
          source += decoder.decode(bytes, { stream: true });
        } catch {
          throw invalidBridgeResponse();
        }
        if (receivedChunks % RESPONSE_YIELD_INTERVAL === 0) {
          await Promise.race([
            new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0)),
            abortPromise,
          ]);
        }
      }
      try {
        source += decoder.decode();
      } catch {
        throw invalidBridgeResponse();
      }
    } finally {
      if (!completed) {
        await cancelReader(reader);
      }
      try { reader.releaseLock(); } catch { /* a non-cooperative pending reader stays isolated */ }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      throw invalidBridgeResponse();
    }
    if (hasPrototypeKey(parsed)) throw invalidBridgeResponse();
    return parsed;
  }

  async prepare(options?: RequestOptions): Promise<PreparedAgentRun>;
  /** @deprecated Temporary Task 10 migration overload. Scope is ignored and never sent; remove in Task 10. */
  async prepare(scope: AgentScope[], options?: RequestOptions): Promise<PreparedAgentRun>;
  async prepare(
    optionsOrScope: RequestOptions | AgentScope[] = {},
    legacyOptions: RequestOptions = {},
  ): Promise<PreparedAgentRun> {
    const options = Array.isArray(optionsOrScope) ? legacyOptions : optionsOrScope;
    const response = await this.request("POST", "/v1/agent-runs/prepare", {}, options.signal);
    const parsed = PrepareResponseSchema.safeParse(response);
    if (!parsed.success) throw invalidBridgeResponse();
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
      throw invalidBridgeResponse();
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
    const parsedInput = ResumeTravelResearchInputSchema.parse(input);
    return this.researchPost(
      "/v1/agent-runs/resume-travel-research",
      parsedInput,
      options,
      parsedInput.researchTaskId,
    );
  }

  async cancelResearch(input: CancelResearchInput, options: RequestOptions = {}): Promise<ResearchStatus> {
    const parsedInput = CancelResearchInputSchema.parse(input);
    return this.researchPost("/v1/agent-runs/cancel-research", parsedInput, options, parsedInput.researchTaskId);
  }

  private async researchPost(
    path: string,
    body: Record<string, unknown>,
    options: RequestOptions,
    expectedResearchTaskId?: string,
  ) {
    const response = await this.request("POST", path, body, options.signal);
    return this.parseResearchStatus(response, expectedResearchTaskId);
  }

  private parseResearchStatus(response: unknown, expectedResearchTaskId?: string) {
    const parsed = ResearchStatusResponseSchema.safeParse(response);
    if (!parsed.success) throw invalidBridgeResponse();
    if (expectedResearchTaskId !== undefined
      && (parsed.data.data.phase === "idle"
        || parsed.data.data.researchTaskId !== expectedResearchTaskId)) {
      throw invalidBridgeResponse();
    }
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
