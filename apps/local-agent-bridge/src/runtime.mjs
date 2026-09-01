import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { canonicalJson } from "@travel/contracts/decision-research";

const FIXED_AGENT_SCOPE = ["submitProposalBatch"];
const CONTROL_ACTIONS = new Set(["getDecisionContext", "revokeAgentRunSelf"]);
const PUBLIC_AGENT_ERRORS = new Set([
  "AUTH_REQUIRED",
  "MEMBERSHIP_REQUIRED",
  "ADMIN_REQUIRED",
  "FORBIDDEN",
  "INVALID_REQUEST",
  "VERSION_CONFLICT",
  "IDEMPOTENCY_KEY_REUSED",
  "SUMMARY_NOT_READY",
  "AGENT_RUN_EXPIRED",
  "AGENT_SCOPE_FORBIDDEN",
  "INVALID_AGENT_CLAIM",
  "INVALID_CONFIRMATION_STATE",
  "INVALID_PLACEMENT",
  "INVALID_PLACEMENT_STATE",
  "VERIFICATION_INCOMPLETE",
  "CURSOR_EXPIRED",
]);
const UNCERTAIN_HTTP_STATUSES = new Set([408, 425, 429]);
const BRIDGE_ERROR = Symbol("bridgeError");

export { canonicalJson };

function codedError(code, uncertain = false) {
  return Object.assign(new Error(code), { code, uncertain, [BRIDGE_ERROR]: true });
}

function validAgentEndpoint(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/api/agent") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function signature(privateKey, value) {
  return sign(
    "sha256",
    Buffer.from(canonicalJson(value)),
    { key: privateKey, dsaEncoding: "ieee-p1363" },
  ).toString("base64url");
}

function utcDateTimeMilliseconds(value) {
  const match = typeof value === "string"
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value)
    : undefined;
  if (!match) return Number.NaN;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return Number.NaN;
  const parsed = new Date(time);
  return parsed.getUTCFullYear() === Number(match[1])
    && parsed.getUTCMonth() + 1 === Number(match[2])
    && parsed.getUTCDate() === Number(match[3])
    && parsed.getUTCHours() === Number(match[4])
    && parsed.getUTCMinutes() === Number(match[5])
    && parsed.getUTCSeconds() === Number(match[6])
    ? time
    : Number.NaN;
}

function currentTime(now, uncertain = false) {
  try {
    const value = now();
    const time = value instanceof Date ? value.getTime() : Number.NaN;
    if (Number.isFinite(time)) return time;
  } catch {
    // Sanitized below.
  }
  throw codedError("INVALID_CLOCK", uncertain);
}

function activeAgentRun(expiresAt, time) {
  const expiry = utcDateTimeMilliseconds(expiresAt);
  return Number.isFinite(expiry) && expiry > time;
}

function publicMaterial(prepared) {
  return {
    publicKeyJwk: { ...prepared.publicKeyJwk },
    pairingCodeHash: prepared.pairingCodeHash,
    pairingCodeFingerprint: prepared.pairingCodeFingerprint,
  };
}

function requestSnapshot(action, payload) {
  try {
    const payloadJson = canonicalJson(payload);
    const safePayload = JSON.parse(payloadJson);
    return {
      payload: safePayload,
      requested: canonicalJson({ action, payload: safePayload }),
    };
  } catch {
    throw codedError("INVALID_REQUEST");
  }
}

function safeRemoteError(value) {
  return PUBLIC_AGENT_ERRORS.has(value) ? value : "INVALID_AGENT_RESPONSE";
}

export class LocalAgentBridgeRuntime {
  #agentEndpoint;
  #fetch;
  #now;
  #timeoutMs;
  #prepared;
  #claimed;
  #pendingClaim;
  #pendingCommand;
  #busy;

  constructor({ agentEndpoint, fetch: fetchImpl = globalThis.fetch, timeoutMs = 15_000, now = () => new Date() } = {}) {
    const endpoint = validAgentEndpoint(agentEndpoint);
    if (!endpoint) throw codedError("INVALID_AGENT_ENDPOINT");
    if (typeof fetchImpl !== "function") throw codedError("INVALID_AGENT_ENDPOINT");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw codedError("INVALID_TIMEOUT");
    if (typeof now !== "function") throw codedError("INVALID_CLOCK");
    this.#agentEndpoint = endpoint;
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
    this.#now = now;
  }

  get nextSequence() {
    return this.#claimed?.nextSequence;
  }

  get claimedRun() {
    return this.#claimed && {
      agentRunId: this.#claimed.agentRunId,
      expiresAt: this.#claimed.expiresAt,
      nextSequence: this.#claimed.nextSequence,
    };
  }

  prepare() {
    if (this.#busy || this.#pendingClaim || this.#pendingCommand || this.#claimed) throw codedError("BRIDGE_BUSY");
    if (this.#prepared) return publicMaterial(this.#prepared);
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pairingCode = randomBytes(32).toString("base64url");
    const pairingCodeHash = createHash("sha256").update(pairingCode).digest("base64url");
    const fingerprintHex = createHash("sha256").update(pairingCode).digest("hex").slice(0, 8).toUpperCase();
    const publicKeyJwk = publicKey.export({ format: "jwk" });
    this.#prepared = {
      privateKey,
      publicKeyJwk: { ...publicKeyJwk },
      pairingCode,
      pairingCodeHash,
      pairingCodeFingerprint: `${fingerprintHex.slice(0, 4)} · ${fingerprintHex.slice(4)}`,
      scope: [...FIXED_AGENT_SCOPE],
    };
    return publicMaterial(this.#prepared);
  }

  async #post(body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(this.#agentEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        redirect: "error",
        signal: controller.signal,
      });
      let value;
      try {
        value = await response.json();
      } catch {
        const definiteClientFailure = response.status >= 400
          && response.status < 500
          && !UNCERTAIN_HTTP_STATUSES.has(response.status);
        if (definiteClientFailure) throw codedError("INVALID_AGENT_RESPONSE");
        const unavailable = UNCERTAIN_HTTP_STATUSES.has(response.status) || response.status >= 500;
        throw codedError(unavailable ? "AGENT_TRANSPORT_UNAVAILABLE" : "INVALID_AGENT_RESPONSE", true);
      }
      const explicitFailure = value
        && typeof value === "object"
        && value.ok === false
        && typeof value.error === "string";
      if (!response.ok) {
        const unavailable = UNCERTAIN_HTTP_STATUSES.has(response.status) || response.status >= 500;
        if (unavailable) throw codedError("AGENT_TRANSPORT_UNAVAILABLE", true);
        const definiteClientFailure = response.status >= 400 && response.status < 500;
        if (definiteClientFailure) {
          throw codedError(explicitFailure ? safeRemoteError(value.error) : "INVALID_AGENT_RESPONSE");
        }
        throw codedError("INVALID_AGENT_RESPONSE", true);
      }
      if (explicitFailure) throw codedError(safeRemoteError(value.error));
      if (!value || typeof value !== "object" || value.ok !== true) throw codedError("INVALID_AGENT_RESPONSE", true);
      return value;
    } catch (error) {
      if (error?.[BRIDGE_ERROR]) throw error;
      throw codedError("AGENT_TRANSPORT_UNAVAILABLE", true);
    } finally {
      clearTimeout(timeout);
    }
  }

  async claim(agentRunId) {
    if (!this.#prepared || typeof agentRunId !== "string" || !agentRunId) throw codedError("BRIDGE_NOT_PREPARED");
    if (this.#busy) throw codedError("BRIDGE_BUSY");
    if (this.#claimed) {
      if (this.#claimed.agentRunId !== agentRunId) throw codedError("AGENT_RUN_MISMATCH");
      if (!activeAgentRun(this.#claimed.expiresAt, currentTime(this.#now))) throw codedError("AGENT_RUN_EXPIRED");
      return { agentRunId, status: "claimed" };
    }
    if (!this.#pendingClaim) {
      const firstSentAt = currentTime(this.#now);
      const signed = {
        agentRunId,
        pairingCode: this.#prepared.pairingCode,
        clientNonce: randomBytes(32).toString("base64url"),
      };
      const envelope = { ...signed, action: "claimAgentRun", signature: signature(this.#prepared.privateKey, signed) };
      this.#pendingClaim = { agentRunId, firstSentAt, body: JSON.stringify(envelope) };
    } else if (this.#pendingClaim.agentRunId !== agentRunId) {
      throw codedError("AGENT_RUN_MISMATCH");
    }
    this.#busy = "claim";
    try {
      const pending = this.#pendingClaim;
      const response = await this.#post(pending.body);
      const responseAt = currentTime(this.#now, true);
      const data = response.data;
      const claimedAt = utcDateTimeMilliseconds(data?.claimedAt);
      const expiresAt = utcDateTimeMilliseconds(data?.expiresAt);
      if (
        !data
        || typeof data !== "object"
        || data.agentRunId !== agentRunId
        || !Number.isFinite(claimedAt)
        || !Number.isFinite(expiresAt)
        || expiresAt <= pending.firstSentAt
        || claimedAt >= expiresAt
        || claimedAt > responseAt
        || !Number.isSafeInteger(data.nextSequence)
        || data.nextSequence < 1
      ) {
        throw codedError("INVALID_AGENT_RESPONSE", true);
      }
      this.#claimed = { agentRunId, expiresAt: data.expiresAt, nextSequence: data.nextSequence };
      this.#pendingClaim = undefined;
      return { agentRunId, status: "claimed" };
    } catch (error) {
      if (!error?.uncertain) this.#pendingClaim = undefined;
      throw error;
    } finally {
      this.#busy = undefined;
    }
  }

  async command(action, payload) {
    if (CONTROL_ACTIONS.has(action)) throw codedError("ACTION_NOT_ALLOWED");
    return this.#executeCommand(action, payload);
  }

  async #executeCommand(action, payload) {
    if (!this.#prepared || !this.#claimed) throw codedError("BRIDGE_NOT_CLAIMED");
    if (this.#busy) throw codedError("BRIDGE_BUSY");
    if (!CONTROL_ACTIONS.has(action) && !this.#prepared.scope.includes(action)) throw codedError("ACTION_NOT_ALLOWED");
    const { payload: safePayload, requested } = requestSnapshot(action, payload);
    if (!this.#pendingCommand) {
      const firstSentAt = currentTime(this.#now);
      if (!activeAgentRun(this.#claimed.expiresAt, firstSentAt)) throw codedError("AGENT_RUN_EXPIRED");
      if (!Number.isSafeInteger(this.#claimed.nextSequence) || this.#claimed.nextSequence >= Number.MAX_SAFE_INTEGER) {
        throw codedError("SEQUENCE_EXHAUSTED");
      }
      const signed = {
        agentRunId: this.#claimed.agentRunId,
        sequence: this.#claimed.nextSequence,
        idempotencyKey: randomUUID(),
        action,
        payload: safePayload,
      };
      const envelope = { ...signed, signature: signature(this.#prepared.privateKey, signed) };
      this.#pendingCommand = { requested, firstSentAt, body: JSON.stringify(envelope) };
    } else if (this.#pendingCommand.requested !== requested) {
      throw codedError("COMMAND_RETRY_REQUIRED");
    }
    this.#busy = "command";
    try {
      const response = await this.#post(this.#pendingCommand.body);
      currentTime(this.#now, true);
      if (
        response.action !== action
        || !Object.hasOwn(response, "data")
        || (Object.hasOwn(response, "replayed") && typeof response.replayed !== "boolean")
      ) {
        throw codedError("INVALID_AGENT_RESPONSE", true);
      }
      if (action === "revokeAgentRunSelf") {
        const data = response.data;
        if (!data
          || typeof data !== "object"
          || data.agentRunId !== this.#claimed.agentRunId
          || !Number.isFinite(utcDateTimeMilliseconds(data.revokedAt))) {
          throw codedError("INVALID_AGENT_RESPONSE", true);
        }
      }
      this.#claimed.nextSequence += 1;
      this.#pendingCommand = undefined;
      if (action === "revokeAgentRunSelf") {
        this.#prepared = undefined;
        this.#claimed = undefined;
        this.#pendingClaim = undefined;
      }
      return response;
    } catch (error) {
      if (!error?.uncertain) this.#pendingCommand = undefined;
      throw error;
    } finally {
      this.#busy = undefined;
    }
  }

  async getDecisionContext() {
    const response = await this.#executeCommand("getDecisionContext", {});
    return response.data;
  }

  async revokeSelf() {
    return this.#executeCommand("revokeAgentRunSelf", {});
  }
}
