import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";

const AGENT_SCOPES = new Set([
  "submitProposalBatch",
  "appendEvidenceSnapshot",
  "reportVerificationBlocked",
  "generatePreferenceSummary",
]);

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function codedError(code, transient = false) {
  return Object.assign(new Error(code), { code, transient });
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

export class LocalAgentBridgeRuntime {
  #agentEndpoint;
  #fetch;
  #timeoutMs;
  #prepared;
  #claimed;
  #pendingClaim;
  #pendingCommand;
  #busy;

  constructor({ agentEndpoint, fetch: fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
    const endpoint = validAgentEndpoint(agentEndpoint);
    if (!endpoint) throw codedError("INVALID_AGENT_ENDPOINT");
    if (typeof fetchImpl !== "function") throw codedError("INVALID_AGENT_ENDPOINT");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw codedError("INVALID_TIMEOUT");
    this.#agentEndpoint = endpoint;
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
  }

  get nextSequence() {
    return this.#claimed?.nextSequence;
  }

  prepare(scope) {
    if (this.#busy) throw codedError("BRIDGE_BUSY");
    if (!Array.isArray(scope) || scope.length < 1 || scope.length > 4 || new Set(scope).size !== scope.length || scope.some((item) => !AGENT_SCOPES.has(item))) {
      throw codedError("INVALID_SCOPE");
    }
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pairingCode = randomBytes(32).toString("base64url");
    const pairingCodeHash = createHash("sha256").update(pairingCode).digest("base64url");
    const fingerprintHex = createHash("sha256").update(pairingCode).digest("hex").slice(0, 8).toUpperCase();
    const publicKeyJwk = publicKey.export({ format: "jwk" });
    this.#prepared = { privateKey, publicKeyJwk, pairingCode, scope: [...scope] };
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
          response.status >= 500,
        );
      }
      if (!response.ok) {
        const transient = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
        throw codedError(
          transient ? "AGENT_TRANSPORT_UNAVAILABLE" : (typeof value?.error === "string" ? value.error : "INVALID_AGENT_RESPONSE"),
          transient,
        );
      }
      if (!value || typeof value !== "object" || value.ok !== true) throw codedError("INVALID_AGENT_RESPONSE");
      return value;
    } catch (error) {
      if (error?.code) throw error;
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
        || !Number.isFinite(Date.parse(data.claimedAt))
        || !Number.isSafeInteger(data.nextSequence)
        || data.nextSequence < 1
      ) {
        throw codedError("INVALID_AGENT_RESPONSE");
      }
      this.#claimed = { agentRunId, nextSequence: data.nextSequence };
      this.#pendingClaim = undefined;
      return { agentRunId, status: "claimed" };
    } catch (error) {
      if (!error?.transient) this.#pendingClaim = undefined;
      throw error;
    } finally {
      this.#busy = undefined;
    }
  }

  async command(action, payload) {
    if (!this.#prepared || !this.#claimed) throw codedError("BRIDGE_NOT_CLAIMED");
    if (this.#busy) throw codedError("BRIDGE_BUSY");
    if (action !== "getDecisionContext" && !this.#prepared.scope.includes(action)) throw codedError("ACTION_NOT_ALLOWED");
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
        throw codedError("INVALID_AGENT_RESPONSE");
      }
      this.#claimed.nextSequence += 1;
      this.#pendingCommand = undefined;
      return response;
    } catch (error) {
      if (!error?.transient) this.#pendingCommand = undefined;
      throw error;
    } finally {
      this.#busy = undefined;
    }
  }

  async getDecisionContext() {
    const response = await this.command("getDecisionContext", {});
    return response.data;
  }
}
