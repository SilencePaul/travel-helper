const { createTripCommands } = require("./lib/commands.js");

function uidFromIdentity(identity) {
  if (!identity || typeof identity !== "object") return undefined;
  if (typeof identity.customUserId === "string" && identity.customUserId) return identity.customUserId;
  if (typeof identity.uid === "string" && identity.uid) return identity.uid;
  return undefined;
}

function createRuntimeGetUserInfo(env) {
  if (!env.VITE_CLOUDBASE_ENV_ID) return undefined;
  try {
    // Caller identity is injected by the CloudBase function runtime. Initializing
    // this client with server credentials turns it into a service client and
    // prevents getUserInfo() from seeing the browser's custom-login identity.
    const cloudbase = require("@cloudbase/node-sdk").init({ env: env.VITE_CLOUDBASE_ENV_ID });
    const auth = cloudbase.auth();
    return () => auth.getUserInfo();
  } catch {
    return undefined;
  }
}

function payloadFromEvent(event) {
  if (event && event.data && typeof event.data === "object") return event.data;
  if (typeof event?.body === "string") {
    try { return JSON.parse(event.body); } catch { return {}; }
  }
  return event;
}

function createDatabase(env) {
  if (!env.VITE_CLOUDBASE_ENV_ID || !env.CLOUDBASE_SERVER_SECRET_ID || !env.CLOUDBASE_SERVER_SECRET_KEY) return undefined;
  try {
    const cloudbase = require("@cloudbase/node-sdk").init({ env: env.VITE_CLOUDBASE_ENV_ID, secretId: env.CLOUDBASE_SERVER_SECRET_ID, secretKey: env.CLOUDBASE_SERVER_SECRET_KEY });
    return cloudbase.database();
  } catch { return undefined; }
}

function safeError(error) {
  const code = typeof error?.code === "string" ? error.code : "TRIP_API_UNAVAILABLE";
  const allowed = new Set(["AUTH_REQUIRED", "INVALID_REQUEST", "MEMBERSHIP_REQUIRED", "ADMIN_REQUIRED", "MEMBER_NOT_FOUND", "INVALID_MEMBER_STATE", "MEMBER_LIMIT_REACHED", "LAST_ADMIN", "FORBIDDEN", "TRIP_NOT_FOUND", "VERSION_CONFLICT", "INVALID_TRIP", "IDEMPOTENCY_KEY_REUSED", "SESSION_REVOKE_FAILED", "MEMBERSHIP_ASSOCIATIONS_UNAVAILABLE", "MEMBERSHIP_INDEX_UNAVAILABLE", "SUMMARY_NOT_READY", "AGENT_RUN_EXPIRED", "AGENT_SCOPE_FORBIDDEN", "INVALID_AGENT_CLAIM", "INVALID_CONFIRMATION_STATE", "INVALID_PLACEMENT", "INVALID_PLACEMENT_STATE", "VERIFICATION_INCOMPLETE", "CURSOR_EXPIRED"]);
  return allowed.has(code) ? code : "TRIP_API_UNAVAILABLE";
}

const decisionMutationActions = new Set([
  "upsertPreference", "completePreference", "skipPreference", "generatePreferenceSummary",
  "recordFeedback", "placeTentative", "attachTentativeToLegacyTrip", "detachTentativeFromLegacyTrip",
  "setConfirmationReceipt", "createAgentRun", "revokeAgentRun",
]);
const agentActions = new Set(["claimAgentRun", "submitProposalBatch", "appendEvidenceSnapshot", "reportVerificationBlocked", "generatePreferenceSummary", "getDecisionContext"]);

function isAgentEnvelope(payload) {
  const nonempty = (value) => typeof value === "string" && value.length > 0;
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !agentActions.has(payload.action)) return false;
  if (payload.action === "claimAgentRun") {
    return nonempty(payload.agentRunId) && nonempty(payload.pairingCode) && nonempty(payload.clientNonce) && nonempty(payload.signature);
  }
  return nonempty(payload.agentRunId)
    && Number.isSafeInteger(payload.sequence) && payload.sequence > 0
    && nonempty(payload.idempotencyKey)
    && nonempty(payload.signature)
    && payload.payload && typeof payload.payload === "object" && !Array.isArray(payload.payload);
}

function header(headers = {}, name) {
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    body: JSON.stringify(body),
  };
}

function createAgentHttpHandler({ handler, maxBodyBytes = 64 * 1024 } = {}) {
  if (typeof handler !== "function") throw new TypeError("handler is required");
  return async (event = {}) => {
    const method = String(event.httpMethod || event.method || "").toUpperCase();
    const path = String(event.path || event.requestContext?.http?.path || event.requestContext?.path || "/");
    if (method !== "POST" || path !== "/api/agent") return json(404, { ok: false, error: "INVALID_REQUEST" });
    if (!/^application\/json(?:\s*;|$)/i.test(String(header(event.headers, "content-type") || ""))) {
      return json(415, { ok: false, error: "INVALID_REQUEST" });
    }
    const source = typeof event.body === "string" ? event.body : JSON.stringify(event.body ?? {});
    if (Buffer.byteLength(source) > maxBodyBytes) return json(413, { ok: false, error: "INVALID_REQUEST" });
    let payload;
    try { payload = JSON.parse(source); } catch { return json(400, { ok: false, error: "INVALID_REQUEST" }); }
    if (!isAgentEnvelope(payload)) {
      return json(400, { ok: false, error: "INVALID_REQUEST" });
    }
    try {
      const result = await handler(payload);
      const statusCode = result?.ok === true ? 200
        : result?.error === "AGENT_RUN_EXPIRED" ? 410
          : result?.error === "TRIP_API_UNAVAILABLE" ? 503
            : ["INVALID_AGENT_CLAIM", "AGENT_SCOPE_FORBIDDEN", "FORBIDDEN"].includes(result?.error) ? 403
              : 400;
      return json(statusCode, result?.ok === true || result?.ok === false ? result : { ok: false, error: "TRIP_API_UNAVAILABLE" });
    } catch {
      return json(503, { ok: false, error: "TRIP_API_UNAVAILABLE" });
    }
  };
}

function decisionSuccess(action, result) {
  if (["upsertPreference", "completePreference", "skipPreference"].includes(action)) return { ok: true, action, data: result.preference };
  if (action === "generatePreferenceSummary") return { ok: true, action, data: result.summary };
  if (action === "recordFeedback") return { ok: true, action, data: result.feedback };
  if (["placeTentative", "attachTentativeToLegacyTrip", "detachTentativeFromLegacyTrip"].includes(action)) {
    return { ok: true, action, data: result.placement, ...(Number.isInteger(result.tripVersion) ? { tripVersion: result.tripVersion } : {}) };
  }
  if (action === "setConfirmationReceipt") return { ok: true, action, data: { receipt: result.receipt, candidate: result.candidate } };
  if (action === "createAgentRun" || action === "revokeAgentRun") return { ok: true, action, data: result };
  return result;
}

function agentSuccess(action, result) {
  if (action === "claimAgentRun") return { ok: true, data: result };
  const data = action === "submitProposalBatch" ? result.candidates
    : action === "generatePreferenceSummary" ? result.summary
      : action === "getDecisionContext" ? result.context
      : result.candidate;
  return {
    ok: true,
    action,
    data,
    ...(result.warning === "VERIFICATION_INCOMPLETE" ? { warning: result.warning } : {}),
    ...(typeof result.replayed === "boolean" ? { replayed: result.replayed } : {}),
  };
}

function createTripHandler({ db, commands, env = process.env, getUserInfo } = {}) {
  let effectiveCommands = commands;
  let effectiveGetUserInfo = getUserInfo;
  return async (event = {}) => {
    const payload = payloadFromEvent(event);
    const ensureCommands = () => {
      if (effectiveCommands) return effectiveCommands;
      const database = db || createDatabase(env);
      if (!database) return undefined;
      effectiveCommands = createTripCommands({ db: database });
      return effectiveCommands;
    };
    const isAgentRequest = payload?.action === "claimAgentRun"
      || (agentActions.has(payload?.action) && typeof payload?.agentRunId === "string" && Number.isInteger(payload?.sequence));
    if (isAgentRequest) {
      try {
        const agentCommands = ensureCommands();
        if (!agentCommands) return { ok: false, error: "TRIP_API_UNAVAILABLE" };
        return agentSuccess(payload.action, await agentCommands.executeAgent(payload));
      } catch (error) {
        return { ok: false, error: safeError(error), ...(error?.latest ? { latest: error.latest } : {}) };
      }
    }
    effectiveGetUserInfo ||= createRuntimeGetUserInfo(env);
    let runtimeIdentity;
    try { runtimeIdentity = effectiveGetUserInfo?.(); } catch { runtimeIdentity = undefined; }
    const actorUid = uidFromIdentity(runtimeIdentity);
    if (!actorUid || typeof actorUid !== "string") return { error: "AUTH_REQUIRED" };
    const isDecisionMutation = decisionMutationActions.has(payload?.action);
    try {
      if (!ensureCommands()) return { error: "TRIP_API_UNAVAILABLE" };
      const result = await effectiveCommands.execute(payload, actorUid);
      return isDecisionMutation ? decisionSuccess(payload.action, result) : result;
    } catch (error) {
      const code = safeError(error);
      if (isDecisionMutation) return { ok: false, error: code, ...(error?.latest ? { latest: error.latest } : {}) };
      return { error: code, ...(code === "VERSION_CONFLICT" && Number.isInteger(error.currentVersion) ? { currentVersion: error.currentVersion } : {}) };
    }
  };
}

exports.createTripHandler = createTripHandler;
exports.createAgentHttpHandler = createAgentHttpHandler;
const defaultTripHandler = createTripHandler();
const defaultAgentHttpHandler = createAgentHttpHandler({ handler: defaultTripHandler });
exports.main = defaultTripHandler;
exports.agentMain = defaultAgentHttpHandler;
