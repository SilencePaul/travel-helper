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

function currentTime(now) {
  const value = now();
  const time = value instanceof Date ? value.getTime() : Number.NaN;
  return Number.isFinite(time) ? time : Number.NaN;
}

function activeAgentRun(expiresAt, now) {
  const expiry = utcDateTimeMilliseconds(expiresAt);
  const current = currentTime(now);
  return Number.isFinite(expiry) && Number.isFinite(current) && expiry > current;
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
    if (this.#busy) throw codedError("BRIDGE_BUSY");
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pairingCode = randomBytes(32).toString("base64url");
    const pairingCodeHash = createHash("sha256").update(pairingCode).digest("base64url");
    const fingerprintHex = createHash("sha256").update(pairingCode).digest("hex").slice(0, 8).toUpperCase();
    const publicKeyJwk = publicKey.export({ format: "jwk" });
    this.#prepared = { privateKey, publicKeyJwk, pairingCode, scope: [...FIXED_AGENT_SCOPE] };
    this.#claimed = undefined;
    this.#pendingClaim = undefined;
    this.#pendingCommand = undefined;
    return {
      publicKeyJwk,
      pairingCodeHash,
      pairingCodeFingerprint: `${fingerprintHex.slice(0, 4)} · ${fingerprintHex.slice(4)}`,
    };
  }

  async #post(envelope) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(this.#agentEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
        redirect: "error",
        signal: controller.signal,
      });
      let value;
      try {
        value = await response.json();
      } catch {
        throw codedError(
          response.status >= 500 ? "AGENT_TRANSPORT_UNAVAILABLE" : "INVALID_AGENT_RESPONSE",
          true,
        );
      }
      const explicitFailure = value
        && typeof value === "object"
        && value.ok === false
        && typeof value.error === "string";
      if (!response.ok) {
        const unavailable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
        if (unavailable) throw codedError("AGENT_TRANSPORT_UNAVAILABLE", true);
        if (explicitFailure) throw codedError(value.error);
        throw codedError("INVALID_AGENT_RESPONSE", true);
      }
      if (explicitFailure) throw codedError(value.error);
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
      if (!activeAgentRun(this.#claimed.expiresAt, this.#now)) throw codedError("AGENT_RUN_EXPIRED");
      return { agentRunId, status: "claimed" };
    }
    if (!this.#pendingClaim) {
      const signed = {
        agentRunId,
        pairingCode: this.#prepared.pairingCode,
        clientNonce: randomBytes(32).toString("base64url"),
      };
      this.#pendingClaim = { ...signed, action: "claimAgentRun", signature: signature(this.#prepared.privateKey, signed) };
    } else if (this.#pendingClaim.agentRunId !== agentRunId) {
      throw codedError("AGENT_RUN_MISMATCH");
    }
    this.#busy = "claim";
    try {
      const response = await this.#post(this.#pendingClaim);
      const data = response.data;
      if (
        !data
        || typeof data !== "object"
        || data.agentRunId !== agentRunId
        || typeof data.claimedAt !== "string"
        || !Number.isFinite(utcDateTimeMilliseconds(data.claimedAt))
        || !activeAgentRun(data.expiresAt, this.#now)
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
    if (!this.#prepared || !this.#claimed) throw codedError("BRIDGE_NOT_CLAIMED");
    if (this.#busy) throw codedError("BRIDGE_BUSY");
    if (!activeAgentRun(this.#claimed.expiresAt, this.#now)) throw codedError("AGENT_RUN_EXPIRED");
    if (!CONTROL_ACTIONS.has(action) && !this.#prepared.scope.includes(action)) throw codedError("ACTION_NOT_ALLOWED");
    if (!Number.isSafeInteger(this.#claimed.nextSequence) || this.#claimed.nextSequence >= Number.MAX_SAFE_INTEGER) {
      throw codedError("SEQUENCE_EXHAUSTED");
    }
    const requested = canonicalJson({ action, payload });
    if (!this.#pendingCommand) {
      const signed = {
        agentRunId: this.#claimed.agentRunId,
        sequence: this.#claimed.nextSequence,
        idempotencyKey: randomUUID(),
        action,
        payload,
      };
      this.#pendingCommand = { requested, envelope: { ...signed, signature: signature(this.#prepared.privateKey, signed) } };
    } else if (this.#pendingCommand.requested !== requested) {
      throw codedError("COMMAND_RETRY_REQUIRED");
    }
    this.#busy = "command";
    try {
      const response = await this.#post(this.#pendingCommand.envelope);
      if (
        response.action !== action
        || !Object.hasOwn(response, "data")
        || (Object.hasOwn(response, "replayed") && typeof response.replayed !== "boolean")
      ) {
        throw codedError("INVALID_AGENT_RESPONSE", true);
      }
      this.#claimed.nextSequence += 1;
      this.#pendingCommand = undefined;
      return response;
    } catch (error) {
      if (!error?.uncertain) this.#pendingCommand = undefined;
      throw error;
    } finally {
      this.#busy = undefined;
    }
  }

  async getDecisionContext() {
    const response = await this.command("getDecisionContext", {});
    return response.data;
  }

  async revokeSelf() {
    return this.command("revokeAgentRunSelf", {});
  }
}
