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
const MIN_UNBOUND_CLAIM_AGE_MS = 8_000;
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

function hasExactOwnKeys(value, keys) {
  if (!value || typeof value !== "object") return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function hasAllowedOwnKeys(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function opaqueIdentifier(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function safeRevokeSnapshot(value) {
  if (!hasExactOwnKeys(value, ["agentRunId", "expiresAt", "firstSentAt", "body"])
    || !opaqueIdentifier(value.agentRunId)
    || !Number.isSafeInteger(value.firstSentAt)
    || !Number.isFinite(utcDateTimeMilliseconds(value.expiresAt))
    || typeof value.body !== "string" || Buffer.byteLength(value.body, "utf8") > 4_096) {
    throw codedError("INVALID_REQUEST");
  }
  let envelope;
  try {
    envelope = JSON.parse(value.body);
  } catch {
    throw codedError("INVALID_REQUEST");
  }
  if (!hasExactOwnKeys(envelope, ["agentRunId", "sequence", "idempotencyKey", "action", "payload", "signature"])
    || envelope.agentRunId !== value.agentRunId
    || !Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1
    || !opaqueIdentifier(envelope.idempotencyKey)
    || envelope.action !== "revokeAgentRunSelf"
    || !hasExactOwnKeys(envelope.payload, [])
    || typeof envelope.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/u.test(envelope.signature)) {
    throw codedError("INVALID_REQUEST");
  }
  return Object.freeze({
    agentRunId: value.agentRunId,
    expiresAt: value.expiresAt,
    firstSentAt: value.firstSentAt,
    body: value.body,
    sequence: envelope.sequence,
  });
}

function validDate(value) {
  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value) : undefined;
  if (!match) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime())
    && date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() + 1 === Number(match[2])
    && date.getUTCDate() === Number(match[3]);
}

function validDateTime(value) {
  const match = typeof value === "string"
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/u.exec(value)
    : undefined;
  if (!match) return false;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  const date = new Date(time);
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() + 1 === Number(match[2])
    && date.getUTCDate() === Number(match[3])
    && date.getUTCHours() === Number(match[4])
    && date.getUTCMinutes() === Number(match[5])
    && date.getUTCSeconds() === Number(match[6]);
}

function safeCandidate(value) {
  const candidateKeys = [
    "id", "tripId", "revision", "updatedAt", "category", "entity", "applicability",
    "recommendation", "verificationState", "decisionState",
  ];
  if (!hasAllowedOwnKeys(value, candidateKeys, ["currentEvidenceId", "verificationBlockReason"])
    || !nonEmptyString(value.id) || !nonEmptyString(value.tripId)
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !validDateTime(value.updatedAt)
    || !["hotel", "restaurant", "attraction"].includes(value.category)
    || !hasAllowedOwnKeys(value.entity, ["name"], ["address", "latitude", "longitude"])
    || !nonEmptyString(value.entity.name)
    || (Object.hasOwn(value.entity, "address") && typeof value.entity.address !== "string")
    || (Object.hasOwn(value.entity, "latitude") && (typeof value.entity.latitude !== "number" || !Number.isFinite(value.entity.latitude)))
    || (Object.hasOwn(value.entity, "longitude") && (typeof value.entity.longitude !== "number" || !Number.isFinite(value.entity.longitude)))
    || !hasAllowedOwnKeys(value.applicability, [], ["dates", "travelers"])
    || (Object.hasOwn(value.applicability, "dates")
      && (!hasExactOwnKeys(value.applicability.dates, ["start", "end"])
        || !validDate(value.applicability.dates.start) || !validDate(value.applicability.dates.end)))
    || (Object.hasOwn(value.applicability, "travelers")
      && (!Number.isSafeInteger(value.applicability.travelers) || value.applicability.travelers <= 0))
    || !hasExactOwnKeys(value.recommendation, [
      "round", "reason", "preferenceRevisionIds", "feedbackIds",
    ])
    || !Number.isSafeInteger(value.recommendation.round) || value.recommendation.round <= 0
    || !nonEmptyString(value.recommendation.reason)
    || !Array.isArray(value.recommendation.preferenceRevisionIds)
    || !value.recommendation.preferenceRevisionIds.every((item) => typeof item === "string")
    || !Array.isArray(value.recommendation.feedbackIds)
    || !value.recommendation.feedbackIds.every((item) => typeof item === "string")
    || !["candidate", "web_verified", "needs_takeover", "stale"].includes(value.verificationState)
    || !["none", "tentative", "confirmed"].includes(value.decisionState)
    || (Object.hasOwn(value, "currentEvidenceId") && !nonEmptyString(value.currentEvidenceId))
    || (Object.hasOwn(value, "verificationBlockReason")
      && !["login", "captcha", "risk_control", "load_failed", "field_missing"].includes(value.verificationBlockReason))
    || (value.verificationState !== "needs_takeover" && Object.hasOwn(value, "verificationBlockReason"))) {
    return undefined;
  }
  return {
    id: value.id,
    tripId: value.tripId,
    revision: value.revision,
    updatedAt: value.updatedAt,
    category: value.category,
    entity: {
      name: value.entity.name,
      ...(Object.hasOwn(value.entity, "address") ? { address: value.entity.address } : {}),
      ...(Object.hasOwn(value.entity, "latitude") ? { latitude: value.entity.latitude } : {}),
      ...(Object.hasOwn(value.entity, "longitude") ? { longitude: value.entity.longitude } : {}),
    },
    applicability: {
      ...(Object.hasOwn(value.applicability, "dates")
        ? { dates: { start: value.applicability.dates.start, end: value.applicability.dates.end } }
        : {}),
      ...(Object.hasOwn(value.applicability, "travelers") ? { travelers: value.applicability.travelers } : {}),
    },
    recommendation: {
      round: value.recommendation.round,
      reason: value.recommendation.reason,
      preferenceRevisionIds: [...value.recommendation.preferenceRevisionIds],
      feedbackIds: [...value.recommendation.feedbackIds],
    },
    verificationState: value.verificationState,
    decisionState: value.decisionState,
    ...(Object.hasOwn(value, "currentEvidenceId") ? { currentEvidenceId: value.currentEvidenceId } : {}),
    ...(Object.hasOwn(value, "verificationBlockReason")
      ? { verificationBlockReason: value.verificationBlockReason }
      : {}),
  };
}

function safeCandidateBatch(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 4) return undefined;
  const candidates = value.map(safeCandidate);
  return candidates.every(Boolean) ? candidates : undefined;
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

  releaseUnboundClaim(agentRunId) {
    if (this.#busy || this.#pendingClaim || this.#pendingCommand
      || typeof agentRunId !== "string" || !agentRunId
      || this.#claimed?.agentRunId !== agentRunId) return false;
    this.#clearCapability();
    return true;
  }

  expireUnboundClaim(agentRunId, minAgeMs = MIN_UNBOUND_CLAIM_AGE_MS) {
    if (this.#busy || this.#pendingCommand
      || typeof agentRunId !== "string" || !agentRunId
      || !Number.isSafeInteger(minAgeMs) || minAgeMs < 0) return false;
    const pending = this.#pendingClaim;
    const claimed = this.#claimed;
    if ((pending && claimed) || (!pending && !claimed)) return false;
    const capability = pending ?? claimed;
    if (capability.agentRunId !== agentRunId || !Number.isFinite(capability.firstSentAt)) return false;
    let now;
    try {
      now = currentTime(this.#now);
    } catch {
      return false;
    }
    if (now - capability.firstSentAt < Math.max(MIN_UNBOUND_CLAIM_AGE_MS, minAgeMs)) return false;
    this.#clearCapability();
    return true;
  }

  #clearCapability() {
    this.#prepared = undefined;
    this.#claimed = undefined;
    this.#pendingClaim = undefined;
    this.#pendingCommand = undefined;
  }

  prepare() {
    if (this.#busy || this.#pendingClaim || this.#pendingCommand) throw codedError("BRIDGE_BUSY");
    if (this.#claimed) {
      const expiry = utcDateTimeMilliseconds(this.#claimed.expiresAt);
      if (!Number.isFinite(expiry)) throw codedError("INVALID_AGENT_RESPONSE");
      if (expiry > currentTime(this.#now)) throw codedError("BRIDGE_BUSY");
      this.#clearCapability();
    }
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
    if (!this.#prepared) throw codedError("BRIDGE_NOT_PREPARED");
    if (!opaqueIdentifier(agentRunId)) throw codedError("INVALID_REQUEST");
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
      currentTime(this.#now, true);
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
        || !Number.isSafeInteger(data.nextSequence)
        || data.nextSequence < 1
      ) {
        throw codedError("INVALID_AGENT_RESPONSE", true);
      }
      this.#claimed = {
        agentRunId,
        expiresAt: data.expiresAt,
        nextSequence: data.nextSequence,
        firstSentAt: pending.firstSentAt,
      };
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

  async #executeCommand(action, payload, allowPersistedRevoke = false) {
    if ((!this.#prepared && !allowPersistedRevoke) || !this.#claimed) throw codedError("BRIDGE_NOT_CLAIMED");
    if (this.#busy) throw codedError("BRIDGE_BUSY");
    if (!CONTROL_ACTIONS.has(action) && !this.#prepared.scope.includes(action)) throw codedError("ACTION_NOT_ALLOWED");
    const { payload: safePayload, requested } = requestSnapshot(action, payload);
    if (!this.#pendingCommand) {
      const firstSentAt = currentTime(this.#now);
      if (!activeAgentRun(this.#claimed.expiresAt, firstSentAt)) {
        if (action === "revokeAgentRunSelf") this.#clearCapability();
        throw codedError("AGENT_RUN_EXPIRED");
      }
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
      this.#pendingCommand = { action, requested, firstSentAt, body: JSON.stringify(envelope) };
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
      let safeResponse = response;
      if (action === "submitProposalBatch") {
        const hasReplayed = Object.hasOwn(response, "replayed");
        const data = safeCandidateBatch(response.data);
        if (!hasExactOwnKeys(response, hasReplayed ? ["ok", "action", "data", "replayed"] : ["ok", "action", "data"])
          || response.ok !== true || !data) {
          throw codedError("INVALID_AGENT_RESPONSE", true);
        }
        safeResponse = {
          ok: true,
          action: "submitProposalBatch",
          data,
          ...(hasReplayed ? { replayed: response.replayed } : {}),
        };
      } else if (action === "revokeAgentRunSelf") {
        const data = response.data;
        const hasReplayed = Object.hasOwn(response, "replayed");
        if (!hasExactOwnKeys(response, hasReplayed ? ["ok", "action", "data", "replayed"] : ["ok", "action", "data"])
          || !hasExactOwnKeys(data, ["agentRunId", "revokedAt"])
          || data.agentRunId !== this.#claimed.agentRunId
          || !Number.isFinite(utcDateTimeMilliseconds(data.revokedAt))) {
          throw codedError("INVALID_AGENT_RESPONSE", true);
        }
        safeResponse = {
          ok: true,
          action: "revokeAgentRunSelf",
          data: { agentRunId: data.agentRunId, revokedAt: data.revokedAt },
          ...(hasReplayed ? { replayed: response.replayed } : {}),
        };
      }
      this.#claimed.nextSequence += 1;
      this.#pendingCommand = undefined;
      if (action === "revokeAgentRunSelf") {
        this.#clearCapability();
      }
      return safeResponse;
    } catch (error) {
      if (!error?.uncertain && ["INVALID_AGENT_CLAIM", "AGENT_RUN_EXPIRED"].includes(error?.code)) {
        this.#clearCapability();
      } else if (!error?.uncertain) {
        this.#pendingCommand = undefined;
      }
      throw error;
    } finally {
      this.#busy = undefined;
    }
  }

  async getDecisionContext() {
    const response = await this.#executeCommand("getDecisionContext", {});
    return response.data;
  }

  async submitProposalBatch(payload) {
    return this.#executeCommand("submitProposalBatch", payload);
  }

  async revokeSelf() {
    return this.#executeCommand("revokeAgentRunSelf", {});
  }

  prepareRevokeSelf() {
    if (!this.#prepared || !this.#claimed) throw codedError("BRIDGE_NOT_CLAIMED");
    if (this.#busy) throw codedError("BRIDGE_BUSY");
    const { payload, requested } = requestSnapshot("revokeAgentRunSelf", {});
    if (!this.#pendingCommand) {
      const firstSentAt = currentTime(this.#now);
      if (!activeAgentRun(this.#claimed.expiresAt, firstSentAt)) {
        this.#clearCapability();
        throw codedError("AGENT_RUN_EXPIRED");
      }
      if (!Number.isSafeInteger(this.#claimed.nextSequence) || this.#claimed.nextSequence >= Number.MAX_SAFE_INTEGER) {
        throw codedError("SEQUENCE_EXHAUSTED");
      }
      const signed = {
        agentRunId: this.#claimed.agentRunId,
        sequence: this.#claimed.nextSequence,
        idempotencyKey: randomUUID(),
        action: "revokeAgentRunSelf",
        payload,
      };
      this.#pendingCommand = {
        action: "revokeAgentRunSelf",
        requested,
        firstSentAt,
        body: JSON.stringify({ ...signed, signature: signature(this.#prepared.privateKey, signed) }),
      };
    } else if (this.#pendingCommand.requested !== requested) {
      throw codedError("COMMAND_RETRY_REQUIRED");
    }
    return Object.freeze({
      agentRunId: this.#claimed.agentRunId,
      expiresAt: this.#claimed.expiresAt,
      firstSentAt: this.#pendingCommand.firstSentAt,
      body: this.#pendingCommand.body,
    });
  }

  async reconcileRevokeSelf(value) {
    const snapshot = safeRevokeSnapshot(value);
    if (this.#busy) throw codedError("BRIDGE_BUSY");
    const requested = canonicalJson({ action: "revokeAgentRunSelf", payload: {} });
    if (this.#pendingCommand) {
      if (!this.#claimed || this.#claimed.agentRunId !== snapshot.agentRunId
        || this.#pendingCommand.requested !== requested
        || this.#pendingCommand.firstSentAt !== snapshot.firstSentAt
        || this.#pendingCommand.body !== snapshot.body) {
        throw codedError("COMMAND_RETRY_REQUIRED");
      }
    } else {
      if (this.#prepared
        || (this.#claimed && (
          this.#claimed.agentRunId !== snapshot.agentRunId
          || this.#claimed.expiresAt !== snapshot.expiresAt
          || this.#claimed.nextSequence !== snapshot.sequence
          || this.#claimed.firstSentAt !== snapshot.firstSentAt
        ))) {
        throw codedError("COMMAND_RETRY_REQUIRED");
      }
      this.#claimed ??= {
        agentRunId: snapshot.agentRunId,
        expiresAt: snapshot.expiresAt,
        nextSequence: snapshot.sequence,
        firstSentAt: snapshot.firstSentAt,
      };
      this.#pendingCommand = {
        action: "revokeAgentRunSelf",
        requested,
        firstSentAt: snapshot.firstSentAt,
        body: snapshot.body,
      };
    }
    return this.#executeCommand("revokeAgentRunSelf", {}, true);
  }

  releaseExpiredReadOnlyPending() {
    if (this.#busy || !this.#claimed || !this.#pendingCommand) return false;
    if (activeAgentRun(this.#claimed.expiresAt, currentTime(this.#now))) return false;
    if (!["getDecisionContext", "revokeAgentRunSelf"].includes(this.#pendingCommand.action)) return false;
    this.#clearCapability();
    return true;
  }
}
