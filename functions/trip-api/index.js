const { createTripCommands } = require("./lib/commands.js");

function actorUidFromEvent(event) {
  return event?.userInfo?.uid;
}

function payloadFromEvent(event) {
  if (event && event.data && typeof event.data === "object") return event.data;
  if (typeof event?.body === "string") {
    try { return JSON.parse(event.body); } catch { return {}; }
  }
  return event;
}

function createDatabase(env) {
  if (!env.VITE_CLOUDBASE_ENV_ID || !env.CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS) return undefined;
  try {
    const cloudbase = require("@cloudbase/node-sdk").init({ env: env.VITE_CLOUDBASE_ENV_ID, credentials: JSON.parse(env.CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS) });
    return cloudbase.database();
  } catch { return undefined; }
}

function safeError(error) {
  const code = typeof error?.code === "string" ? error.code : "TRIP_API_UNAVAILABLE";
  const allowed = new Set(["AUTH_REQUIRED", "INVALID_REQUEST", "MEMBERSHIP_REQUIRED", "ADMIN_REQUIRED", "MEMBER_NOT_FOUND", "INVALID_MEMBER_STATE", "LAST_ADMIN", "FORBIDDEN", "TRIP_NOT_FOUND", "VERSION_CONFLICT", "INVALID_TRIP", "IDEMPOTENCY_KEY_REUSED", "SESSION_REVOKE_FAILED"]);
  return allowed.has(code) ? code : "TRIP_API_UNAVAILABLE";
}

function createTripHandler({ db, commands, env = process.env } = {}) {
  let effectiveCommands = commands;
  return async (event = {}) => {
    const actorUid = actorUidFromEvent(event);
    if (!actorUid || typeof actorUid !== "string") return { error: "AUTH_REQUIRED" };
    try {
      if (!effectiveCommands) {
        const database = db || createDatabase(env);
        if (!database) return { error: "TRIP_API_UNAVAILABLE" };
        effectiveCommands = createTripCommands({ db: database });
      }
      return await effectiveCommands.execute(payloadFromEvent(event), actorUid);
    } catch (error) {
      const code = safeError(error);
      return { error: code, ...(code === "VERSION_CONFLICT" && Number.isInteger(error.currentVersion) ? { currentVersion: error.currentVersion } : {}) };
    }
  };
}

exports.createTripHandler = createTripHandler;
exports.main = createTripHandler();
