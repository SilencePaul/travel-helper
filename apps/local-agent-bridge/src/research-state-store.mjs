import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as defaultFileSystem from "node:fs/promises";
import { isIP } from "node:net";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";

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
const LOCK_FILE_NAME = ".travel-research-state.lock";
const MAX_STATE_BYTES = 32 * 1_024;
const DEFAULT_LOCK_WAIT_MS = 7_000;
const DEFAULT_LOCK_RETRY_MS = 10;
const DEFAULT_LOCK_STALE_MS = 30_000;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
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
const NON_PUBLIC_HOST_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "lan",
  "home",
  "home.arpa",
  "localdomain",
  "corp",
  "intranet",
  "private",
  "test",
  "invalid",
  "example",
  "onion",
];
const BROAD_DIRECTORIES = new Set([
  "/tmp",
  "/private/tmp",
  "/var",
  "/private/var",
  "/Users",
  "/home",
  "/etc",
  "/usr",
  "/opt",
  "/System",
  "/Library",
  "/Applications",
  "/Volumes",
]);
const BROAD_LEAF_NAMES = new Set(["Desktop", "Documents", "Downloads", "Library", "Application Support"]);

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
  if (!value.includes(".") || value.startsWith(".") || value.endsWith(".") || value.includes("..")) return false;
  if (isIP(value) !== 0) return false;
  if (NON_PUBLIC_HOST_SUFFIXES.some((suffix) => value === suffix || value.endsWith(`.${suffix}`))) return false;
  try {
    if (new URL(`https://${value}/`).hostname !== value) return false;
  } catch {
    return false;
  }
  return value.split(".").every((label) => (
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
  ));
}

function dedicatedDirectory(value) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) return false;
  const root = parse(value).root;
  if (value === root || value === tmpdir() || value === homedir() || BROAD_DIRECTORIES.has(value)) return false;
  const segments = value.slice(root.length).split("/").filter(Boolean);
  if (segments.length < 2) return false;
  if (/^\/(?:Users|home)\/[^/]+$/u.test(value)) return false;
  return !BROAD_LEAF_NAMES.has(segments.at(-1));
}

function validDuration(value, maximum) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
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
  lockWaitMs = DEFAULT_LOCK_WAIT_MS,
  lockRetryMs = DEFAULT_LOCK_RETRY_MS,
  lockStaleMs = DEFAULT_LOCK_STALE_MS,
} = {}) {
  if (!dedicatedDirectory(directory)) {
    throw codedError("RESEARCH_STATE_INVALID");
  }
  if (!fileSystem || typeof fileSystem !== "object" || typeof tempToken !== "function") {
    throw codedError("RESEARCH_STATE_INVALID");
  }
  if (!validDuration(lockWaitMs, 60_000)
    || !validDuration(lockRetryMs, 1_000)
    || !validDuration(lockStaleMs, 300_000)
    || lockRetryMs > lockWaitMs) {
    throw codedError("RESEARCH_STATE_INVALID");
  }

  const filePath = join(directory, STATE_FILE_NAME);
  const lockPath = join(directory, LOCK_FILE_NAME);

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
    let handle;
    try {
      handle = await fileSystem.open(filePath, constants.O_RDONLY | NO_FOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_STATE_BYTES) {
        throw codedError("RESEARCH_STATE_INVALID");
      }
      if ((info.mode & 0o777) !== 0o600) throw codedError("RESEARCH_STATE_INVALID");
      const serialized = await handle.readFile({ encoding: "utf8" });
      if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
        throw codedError("RESEARCH_STATE_INVALID");
      }
      return validateState(JSON.parse(serialized));
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      if (error?.code === "RESEARCH_STATE_INVALID") throw error;
      throw codedError("RESEARCH_STATE_INVALID");
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // Reads already fail closed above; close has no recovery data to expose.
        }
      }
    }
  }

  async function syncDirectory() {
    let handle;
    try {
      handle = await fileSystem.open(directory, constants.O_RDONLY | NO_FOLLOW);
      const info = await handle.stat();
      if (!info.isDirectory()) throw new Error("not a directory");
      await handle.sync();
    } catch {
      throw codedError("RESEARCH_STATE_UNAVAILABLE");
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // Any earlier sync failure is already surfaced.
        }
      }
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
    let handle;
    let temporaryCreated = false;
    try {
      handle = await fileSystem.open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
        0o600,
      );
      temporaryCreated = true;
      await handle.writeFile(serialized, { encoding: "utf8" });
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fileSystem.rename(temporaryPath, filePath);
      temporaryCreated = false;
      await syncDirectory();
    } catch {
      throw codedError("RESEARCH_STATE_UNAVAILABLE");
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // The persistence result remains authoritative.
        }
      }
      if (temporaryCreated) {
        try {
          await fileSystem.rm(temporaryPath, { force: true });
        } catch {
          // The persistence result remains authoritative.
        }
      }
    }
    return state;
  }

  async function clear() {
    await ensureDirectory();
    try {
      await fileSystem.unlink(filePath);
      await syncDirectory();
    } catch (error) {
      if (error?.code !== "ENOENT") throw codedError("RESEARCH_STATE_UNAVAILABLE");
    }
  }

  async function currentTime() {
    const value = Date.now();
    if (!Number.isFinite(value)) throw codedError("RESEARCH_STATE_UNAVAILABLE");
    return value;
  }

  async function removeStaleLock() {
    let handle;
    let info;
    try {
      handle = await fileSystem.open(lockPath, constants.O_RDONLY | NO_FOLLOW);
      info = await handle.stat();
      if (!info.isFile() || (info.mode & 0o777) !== 0o600) {
        throw codedError("RESEARCH_STATE_UNAVAILABLE");
      }
      if ((await currentTime()) - info.mtimeMs < lockStaleMs) return false;
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      if (error?.code === "RESEARCH_STATE_UNAVAILABLE") throw error;
      throw codedError("RESEARCH_STATE_UNAVAILABLE");
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // Lock validation already fails closed on observable errors.
        }
      }
    }

    try {
      const current = await fileSystem.lstat(lockPath);
      if (!current.isFile() || current.isSymbolicLink()
        || current.dev !== info.dev || current.ino !== info.ino
        || (current.mode & 0o777) !== 0o600
        || (await currentTime()) - current.mtimeMs < lockStaleMs) {
        return false;
      }
      await fileSystem.unlink(lockPath);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      throw codedError("RESEARCH_STATE_UNAVAILABLE");
    }
  }

  async function acquireLock() {
    await ensureDirectory();
    const deadline = (await currentTime()) + lockWaitMs;
    while (true) {
      let createdHandle;
      try {
        createdHandle = await fileSystem.open(
          lockPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
          0o600,
        );
        const info = await createdHandle.stat();
        if (!info.isFile() || (info.mode & 0o777) !== 0o600) {
          throw codedError("RESEARCH_STATE_UNAVAILABLE");
        }
        return createdHandle;
      } catch (error) {
        if (createdHandle) {
          try {
            await fileSystem.unlink(lockPath);
          } catch {
            // The validation failure remains authoritative.
          }
          try {
            await createdHandle.close();
          } catch {
            // The validation failure remains authoritative.
          }
        }
        if (error?.code !== "EEXIST") {
          if (error?.code === "RESEARCH_STATE_UNAVAILABLE") throw error;
          throw codedError("RESEARCH_STATE_UNAVAILABLE");
        }
      }

      if (await removeStaleLock()) continue;
      const remaining = deadline - (await currentTime());
      if (remaining <= 0) throw codedError("RESEARCH_STATE_BUSY");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(lockRetryMs, remaining)));
    }
  }

  async function releaseLock(handle) {
    let failed = false;
    try {
      await fileSystem.unlink(lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT") failed = true;
    }
    try {
      await handle.close();
    } catch {
      failed = true;
    }
    if (failed) throw codedError("RESEARCH_STATE_UNAVAILABLE");
  }

  async function persistNeedsOwnerAction(value, notifier) {
    const state = validateState(value);
    const lock = await acquireLock();
    let result;
    let failure;
    try {
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
      result = state;
    } catch (error) {
      failure = error;
    }
    try {
      await releaseLock(lock);
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
    return result;
  }

  return Object.freeze({
    filePath,
    load,
    save,
    clear,
    persistNeedsOwnerAction,
  });
}
