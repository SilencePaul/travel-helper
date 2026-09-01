import { createHash, randomUUID } from "node:crypto";
import * as defaultFileSystem from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export const RECOVERY_STATE_FIELDS = Object.freeze([
  "researchTaskId",
  "codexThreadId",
  "targetCategory",
  "targetScopeId",
  "disclosureFingerprint",
  "aliasSalt",
  "blockedReason",
  "blockedHostname",
  "activeRuntimeMs",
  "phase",
  "startedAt",
  "updatedAt",
]);

const STATE_FILE_NAME = "travel-research-state.json";
const MAX_STATE_BYTES = 32 * 1_024;
const TARGET_CATEGORIES = new Set(["hotel", "restaurant", "attraction"]);
const BLOCKED_REASONS = new Set([
  "codex_auth_required",
  "source_login_required",
  "source_captcha",
  "source_risk_control",
]);
const SOURCE_BLOCKED_REASONS = new Set([
  "source_login_required",
  "source_captcha",
  "source_risk_control",
]);

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactFields(value) {
  return plainObject(value)
    && Reflect.ownKeys(value).length === RECOVERY_STATE_FIELDS.length
    && RECOVERY_STATE_FIELDS.every((field) => Object.hasOwn(value, field));
}

function opaqueIdentifier(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function canonicalTimestamp(value) {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function safeHostname(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 253) return false;
  if (value !== value.toLowerCase() || !/^[a-z0-9.-]+$/u.test(value)) return false;
  if (value.startsWith(".") || value.endsWith(".") || value.includes("..")) return false;
  return value.split(".").every((label) => (
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
  ));
}

function validateState(value) {
  const valid = hasExactFields(value)
    && opaqueIdentifier(value.researchTaskId)
    && opaqueIdentifier(value.codexThreadId)
    && TARGET_CATEGORIES.has(value.targetCategory)
    && /^scope_[a-f0-9]{64}$/u.test(value.targetScopeId)
    && /^[a-f0-9]{64}$/u.test(value.disclosureFingerprint)
    && typeof value.aliasSalt === "string"
    && Buffer.byteLength(value.aliasSalt, "utf8") >= 16
    && Buffer.byteLength(value.aliasSalt, "utf8") <= 1_024
    && /^[A-Za-z0-9_-]+$/u.test(value.aliasSalt)
    && BLOCKED_REASONS.has(value.blockedReason)
    && Number.isSafeInteger(value.activeRuntimeMs)
    && value.activeRuntimeMs >= 0
    && value.activeRuntimeMs <= 600_000
    && value.phase === "needs_owner_action"
    && canonicalTimestamp(value.startedAt)
    && canonicalTimestamp(value.updatedAt)
    && Date.parse(value.updatedAt) >= Date.parse(value.startedAt)
    && (SOURCE_BLOCKED_REASONS.has(value.blockedReason)
      ? safeHostname(value.blockedHostname)
      : value.blockedHostname === null);
  if (!valid) throw codedError("RESEARCH_STATE_INVALID");
  return Object.freeze(Object.fromEntries(RECOVERY_STATE_FIELDS.map((field) => [field, value[field]])));
}

function transitionKey(state) {
  return createHash("sha256")
    .update(JSON.stringify([
      state.researchTaskId,
      state.blockedReason,
      state.blockedHostname,
      state.updatedAt,
    ]))
    .digest("base64url");
}

function sameTransition(left, right) {
  return Boolean(left && transitionKey(left) === transitionKey(right));
}

export function createResearchStateStore({
  directory,
  fileSystem = defaultFileSystem,
  tempToken = randomUUID,
} = {}) {
  if (typeof directory !== "string" || !isAbsolute(directory)) {
    throw codedError("RESEARCH_STATE_INVALID");
  }
  if (!fileSystem || typeof fileSystem !== "object" || typeof tempToken !== "function") {
    throw codedError("RESEARCH_STATE_INVALID");
  }

  const filePath = join(directory, STATE_FILE_NAME);

  async function ensureDirectory() {
    try {
      await fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });
      const info = await fileSystem.lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw codedError("RESEARCH_STATE_UNAVAILABLE");
      await fileSystem.chmod(directory, 0o700);
    } catch (error) {
      if (error?.code === "RESEARCH_STATE_UNAVAILABLE") throw error;
      throw codedError("RESEARCH_STATE_UNAVAILABLE");
    }
  }

  async function load() {
    await ensureDirectory();
    try {
      const info = await fileSystem.lstat(filePath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STATE_BYTES) {
        throw codedError("RESEARCH_STATE_INVALID");
      }
      if ((info.mode & 0o777) !== 0o600) throw codedError("RESEARCH_STATE_INVALID");
      const serialized = await fileSystem.readFile(filePath, "utf8");
      if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
        throw codedError("RESEARCH_STATE_INVALID");
      }
      return validateState(JSON.parse(serialized));
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      if (error?.code === "RESEARCH_STATE_INVALID") throw error;
      throw codedError("RESEARCH_STATE_INVALID");
    }
  }

  async function save(value) {
    const state = validateState(value);
    const serialized = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
      throw codedError("RESEARCH_STATE_INVALID");
    }
    await ensureDirectory();

    let token;
    try {
      token = tempToken();
    } catch {
      throw codedError("RESEARCH_STATE_UNAVAILABLE");
    }
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(token)) {
      throw codedError("RESEARCH_STATE_UNAVAILABLE");
    }
    const temporaryPath = join(directory, `.${STATE_FILE_NAME}.${token}.tmp`);
    let temporaryCreated = false;
    try {
      await fileSystem.writeFile(temporaryPath, serialized, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      temporaryCreated = true;
      await fileSystem.chmod(temporaryPath, 0o600);
      await fileSystem.rename(temporaryPath, filePath);
      temporaryCreated = false;
    } catch {
      if (temporaryCreated) {
        try {
          await fileSystem.rm(temporaryPath, { force: true });
        } catch {
          // The original persistence failure remains authoritative.
        }
      }
      throw codedError("RESEARCH_STATE_UNAVAILABLE");
    }
    return state;
  }

  async function clear() {
    await ensureDirectory();
    try {
      await fileSystem.unlink(filePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw codedError("RESEARCH_STATE_UNAVAILABLE");
    }
  }

  async function persistNeedsOwnerAction(value, notifier) {
    const state = validateState(value);
    const previous = await load();
    const isNewTransition = !sameTransition(previous, state);
    await save(state);
    if (isNewTransition && notifier && typeof notifier.notifyOwnerAction === "function") {
      try {
        await notifier.notifyOwnerAction(transitionKey(state));
      } catch {
        // Notification is best-effort; the persisted state is the source of truth.
      }
    }
    return state;
  }

  return Object.freeze({
    filePath,
    load,
    save,
    clear,
    persistNeedsOwnerAction,
  });
}
