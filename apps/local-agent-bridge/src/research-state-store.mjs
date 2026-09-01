import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { constants } from "node:fs";
import * as defaultFileSystem from "node:fs/promises";
import { BlockList, isIP } from "node:net";
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
const MAX_LOCK_BYTES = 512;
const DEFAULT_LOCK_WAIT_MS = 7_000;
const DEFAULT_LOCK_RETRY_MS = 10;
const DEFAULT_DNS_TIMEOUT_MS = 250;
const OWNERSHIP_CHECK_ATTEMPTS = 3;
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
// This is a cooperative lock for protocol-following Bridge instances under one account,
// not a security boundary against an arbitrary malicious process running as the same UID.
const ORPHANED_LOCK_NONCES = new Set();
const NON_GLOBAL_IPV4 = new BlockList();
const NON_GLOBAL_IPV6 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) NON_GLOBAL_IPV4.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 96], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
  ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20], ["5f00::", 16],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
]) NON_GLOBAL_IPV6.addSubnet(network, prefix, "ipv6");

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

function validLockOwner(value) {
  return plainObject(value)
    && Reflect.ownKeys(value).length === 2
    && Object.hasOwn(value, "pid")
    && Object.hasOwn(value, "nonce")
    && Number.isSafeInteger(value.pid)
    && value.pid > 0
    && value.pid <= 2_147_483_647
    && typeof value.nonce === "string"
    && /^[A-Za-z0-9_-]{16,128}$/u.test(value.nonce);
}

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function validateStateShape(value) {
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

function globalPublicAddress(value) {
  const family = isIP(value);
  if (family === 4) return !NON_GLOBAL_IPV4.check(value, "ipv4");
  if (family === 6) return !NON_GLOBAL_IPV6.check(value, "ipv6");
  return false;
}

async function defaultResolveHostname(hostname) {
  return lookup(hostname, { all: true, verbatim: true });
}

async function requirePublicResolution(hostname, resolver, timeoutMs) {
  let timer;
  try {
    const answers = await Promise.race([
      Promise.resolve().then(() => resolver(hostname)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(codedError("RESEARCH_STATE_INVALID")), timeoutMs);
      }),
    ]);
    if (!Array.isArray(answers) || answers.length === 0) throw codedError("RESEARCH_STATE_INVALID");
    for (const answer of answers) {
      const address = typeof answer === "string"
        ? answer
        : plainObject(answer) && Object.hasOwn(answer, "address") ? answer.address : undefined;
      if (typeof address !== "string" || !globalPublicAddress(address)) {
        throw codedError("RESEARCH_STATE_INVALID");
      }
    }
  } catch (error) {
    if (error?.code === "RESEARCH_STATE_INVALID") throw error;
    throw codedError("RESEARCH_STATE_INVALID");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
  lockToken = randomUUID,
  ownerPid = process.pid,
  isProcessAlive = defaultIsProcessAlive,
  lockWaitMs = DEFAULT_LOCK_WAIT_MS,
  lockRetryMs = DEFAULT_LOCK_RETRY_MS,
  resolveHostname = defaultResolveHostname,
  dnsTimeoutMs = DEFAULT_DNS_TIMEOUT_MS,
} = {}) {
  if (!dedicatedDirectory(directory)) {
    throw codedError("RESEARCH_STATE_INVALID");
  }
  if (!fileSystem || typeof fileSystem !== "object"
    || typeof tempToken !== "function"
    || typeof lockToken !== "function"
    || typeof isProcessAlive !== "function"
    || typeof resolveHostname !== "function") {
    throw codedError("RESEARCH_STATE_INVALID");
  }
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || ownerPid > 2_147_483_647) {
    throw codedError("RESEARCH_STATE_INVALID");
  }
  if (!validDuration(lockWaitMs, 60_000)
    || !validDuration(lockRetryMs, 1_000)
    || !validDuration(dnsTimeoutMs, 5_000)
    || lockRetryMs > lockWaitMs) {
    throw codedError("RESEARCH_STATE_INVALID");
  }

  const filePath = join(directory, STATE_FILE_NAME);
  const lockPath = join(directory, LOCK_FILE_NAME);

  async function validateState(value) {
    const state = validateStateShape(value);
    if (SOURCE_BLOCKED_REASONS.has(state.blockedReason)) {
      await requirePublicResolution(state.blockedHostname, resolveHostname, dnsTimeoutMs);
    }
    return state;
  }

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
      return await validateState(JSON.parse(serialized));
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

  function sameIdentity(info, identity) {
    return info.isFile()
      && !info.isSymbolicLink()
      && info.dev === identity.dev
      && info.ino === identity.ino;
  }

  function detachedPathFor(baseName, purpose) {
    let token;
    try {
      token = randomUUID();
    } catch {
      throw codedError("RESEARCH_STATE_UNAVAILABLE");
    }
    const hiddenBaseName = baseName.startsWith(".") ? baseName : `.${baseName}`;
    return join(directory, `${hiddenBaseName}.${purpose}.${token}`);
  }

  async function restoreDetachedPath(detachedPath, targetPath) {
    let keepTarget = false;
    try {
      await fileSystem.link(detachedPath, targetPath);
      keepTarget = true;
    } catch (error) {
      if (error?.code === "EEXIST") keepTarget = true;
      else throw codedError("RESEARCH_STATE_UNAVAILABLE");
    }
    if (keepTarget) await discardDetachedLock(detachedPath);
  }

  async function rollbackPublishedState(identity) {
    const detachedPath = detachedPathFor(STATE_FILE_NAME, "rollback");
    let renamed = false;
    try {
      await fileSystem.rename(filePath, detachedPath);
      renamed = true;
      const moved = await fileSystem.lstat(detachedPath);
      if (sameIdentity(moved, identity)) {
        await discardDetachedLock(detachedPath);
      } else {
        await restoreDetachedPath(detachedPath, filePath);
      }
      await syncDirectory();
    } catch (error) {
      if (error?.code === "ENOENT" && !renamed) return;
      if (renamed) {
        try {
          await restoreDetachedPath(detachedPath, filePath);
          await syncDirectory();
        } catch {
          // Preserve fail-closed semantics if the filesystem cannot restore the moved inode.
        }
      }
      throw codedError("RESEARCH_STATE_UNAVAILABLE");
    }
  }

  async function writeState(state, lock) {
    const serialized = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
      throw codedError("RESEARCH_STATE_INVALID");
    }
    await ensureDirectory();
    if (lock && !await ownsLock(lock, OWNERSHIP_CHECK_ATTEMPTS)) {
      throw codedError("RESEARCH_STATE_UNAVAILABLE");
    }

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
      await handle.chmod(0o600);
      const info = await handle.stat();
      if (!info.isFile() || (info.mode & 0o777) !== 0o600) {
        throw codedError("RESEARCH_STATE_UNAVAILABLE");
      }
      const publishedIdentity = { dev: info.dev, ino: info.ino };
      await handle.writeFile(serialized, { encoding: "utf8" });
      await handle.sync();
      if (lock && !await ownsLock(lock, OWNERSHIP_CHECK_ATTEMPTS)) {
        throw codedError("RESEARCH_STATE_UNAVAILABLE");
      }
      await handle.close();
      handle = undefined;
      await fileSystem.rename(temporaryPath, filePath);
      temporaryCreated = false;
      // Filesystems do not offer a CAS that couples this rename to a separate lock inode.
      // The cooperative Bridge protocol prevents live-owner replacement; this post-check
      // and inode-scoped rollback additionally closes injected check/rename failures.
      if (lock && !await ownsLock(lock, OWNERSHIP_CHECK_ATTEMPTS)) {
        await rollbackPublishedState(publishedIdentity);
        throw codedError("RESEARCH_STATE_UNAVAILABLE");
      }
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

  async function save(value) {
    const state = await validateState(value);
    const lock = await acquireLock();
    let result;
    let failure;
    try {
      result = await writeState(state, lock);
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

  async function readLockOwner(handle, existingInfo) {
    const info = existingInfo ?? await handle.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600
      || !Number.isSafeInteger(info.size) || info.size <= 0 || info.size > MAX_LOCK_BYTES) {
      throw codedError("RESEARCH_STATE_UNAVAILABLE");
    }
    const buffer = Buffer.alloc(info.size);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    if (!result || result.bytesRead !== buffer.length) throw codedError("RESEARCH_STATE_UNAVAILABLE");
    let owner;
    try {
      owner = JSON.parse(buffer.toString("utf8"));
    } catch {
      throw codedError("RESEARCH_STATE_UNAVAILABLE");
    }
    if (!validLockOwner(owner)) throw codedError("RESEARCH_STATE_UNAVAILABLE");
    return Object.freeze({ pid: owner.pid, nonce: owner.nonce });
  }

  function sameOwner(left, right) {
    return left.pid === right.pid && left.nonce === right.nonce;
  }

  async function inspectLockOwnership(lock) {
    const held = await lock.handle.stat();
    const current = await fileSystem.lstat(lockPath);
    if (!held.isFile() || !current.isFile() || current.isSymbolicLink()
      || (held.mode & 0o777) !== 0o600 || (current.mode & 0o777) !== 0o600
      || held.dev !== lock.dev || held.ino !== lock.ino
      || current.dev !== lock.dev || current.ino !== lock.ino) {
      return false;
    }
    return sameOwner(await readLockOwner(lock.handle, held), lock.owner);
  }

  async function ownsLock(lock, attempts = 1) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await inspectLockOwnership(lock);
      } catch {
        if (attempt + 1 < attempts) await Promise.resolve();
      }
    }
    return false;
  }

  async function discardDetachedLock(detachedPath) {
    try {
      await fileSystem.unlink(detachedPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw codedError("RESEARCH_STATE_UNAVAILABLE");
    }
  }

  async function restoreDetachedLock(detachedPath) {
    await restoreDetachedPath(detachedPath, lockPath);
  }

  async function detachOwnedLock(lock, purpose, attempts = 1) {
    if (!await ownsLock(lock, attempts)) throw codedError("RESEARCH_STATE_UNAVAILABLE");
    const detachedPath = detachedPathFor(LOCK_FILE_NAME, purpose);
    let renamed = false;
    try {
      await fileSystem.rename(lockPath, detachedPath);
      renamed = true;
      const moved = await fileSystem.lstat(detachedPath);
      const owner = await readLockOwner(lock.handle);
      if (!moved.isFile() || moved.isSymbolicLink()
        || (moved.mode & 0o777) !== 0o600
        || moved.dev !== lock.dev || moved.ino !== lock.ino
        || !sameOwner(owner, lock.owner)) {
        throw codedError("RESEARCH_STATE_UNAVAILABLE");
      }
      return detachedPath;
    } catch {
      if (renamed) {
        try {
          await restoreDetachedLock(detachedPath);
        } catch {
          // Recovery was attempted; fail closed without touching the fixed lock path again.
        }
      }
      throw codedError("RESEARCH_STATE_UNAVAILABLE");
    }
  }

  async function safelyRemoveOwnedLock(lock, purpose, attempts = 1) {
    if (!await ownsLock(lock, attempts)) return false;
    const detachedPath = await detachOwnedLock(lock, purpose, attempts);
    await discardDetachedLock(detachedPath);
    return true;
  }

  async function statHandleWithRetry(handle, attempts = OWNERSHIP_CHECK_ATTEMPTS) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await handle.stat();
      } catch (error) {
        lastError = error;
        if (attempt + 1 < attempts) await Promise.resolve();
      }
    }
    throw lastError;
  }

  async function detachLockByIdentity(identity, purpose) {
    let current;
    let lastError;
    for (let attempt = 0; attempt < OWNERSHIP_CHECK_ATTEMPTS; attempt += 1) {
      try {
        current = await fileSystem.lstat(lockPath);
        lastError = undefined;
        break;
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        lastError = error;
        if (attempt + 1 < OWNERSHIP_CHECK_ATTEMPTS) await Promise.resolve();
      }
    }
    if (lastError) throw codedError("RESEARCH_STATE_UNAVAILABLE");
    if (!sameIdentity(current, identity)) return undefined;

    const detachedPath = detachedPathFor(LOCK_FILE_NAME, purpose);
    let renamed = false;
    try {
      await fileSystem.rename(lockPath, detachedPath);
      renamed = true;
      const moved = await fileSystem.lstat(detachedPath);
      if (!sameIdentity(moved, identity)) throw codedError("RESEARCH_STATE_UNAVAILABLE");
      return detachedPath;
    } catch (error) {
      if (error?.code === "ENOENT" && !renamed) return null;
      if (renamed) {
        try {
          await restoreDetachedLock(detachedPath);
        } catch {
          // Do not touch the well-known path again if restoration cannot be confirmed.
        }
      }
      throw codedError("RESEARCH_STATE_UNAVAILABLE");
    }
  }

  async function safelyRemoveCreatedLock(identity) {
    const detachedPath = await detachLockByIdentity(identity, "invalid");
    if (detachedPath === undefined) return false;
    if (detachedPath !== null) await discardDetachedLock(detachedPath);
    return true;
  }

  async function recoverDeadLock() {
    let handle;
    try {
      handle = await fileSystem.open(lockPath, constants.O_RDONLY | NO_FOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || (info.mode & 0o777) !== 0o600) {
        throw codedError("RESEARCH_STATE_UNAVAILABLE");
      }
      let owner;
      try {
        owner = await readLockOwner(handle, info);
      } catch {
        return false;
      }
      const current = await fileSystem.lstat(lockPath);
      if (!current.isFile() || current.isSymbolicLink()
        || current.dev !== info.dev || current.ino !== info.ino
        || (current.mode & 0o777) !== 0o600) {
        return false;
      }
      const knownSameProcessOrphan = owner.pid === process.pid
        && ORPHANED_LOCK_NONCES.has(owner.nonce);
      if (!knownSameProcessOrphan) {
        let alive = true;
        try {
          alive = await isProcessAlive(owner.pid);
        } catch {
          return false;
        }
        if (alive !== false) return false;
      }
      const lock = { handle, dev: info.dev, ino: info.ino, owner };
      const detachedPath = await detachOwnedLock(lock, "stale", OWNERSHIP_CHECK_ATTEMPTS);
      await discardDetachedLock(detachedPath);
      ORPHANED_LOCK_NONCES.delete(owner.nonce);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      if (error?.code === "RESEARCH_STATE_UNAVAILABLE") throw error;
      throw codedError("RESEARCH_STATE_UNAVAILABLE");
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // The lock operation already fails closed on observable errors.
        }
      }
    }
  }

  async function acquireLock() {
    await ensureDirectory();
    let nonce;
    try {
      nonce = lockToken();
    } catch {
      throw codedError("RESEARCH_STATE_UNAVAILABLE");
    }
    const owner = { pid: ownerPid, nonce };
    if (!validLockOwner(owner)) throw codedError("RESEARCH_STATE_UNAVAILABLE");
    const serializedOwner = `${JSON.stringify(owner)}\n`;
    const deadline = (await currentTime()) + lockWaitMs;
    while (true) {
      let createdHandle;
      let createdIdentity;
      try {
        createdHandle = await fileSystem.open(
          lockPath,
          constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
          0o600,
        );
        const openedInfo = await statHandleWithRetry(createdHandle);
        if (!openedInfo.isFile()) throw codedError("RESEARCH_STATE_UNAVAILABLE");
        createdIdentity = { dev: openedInfo.dev, ino: openedInfo.ino };
        await createdHandle.chmod(0o600);
        await createdHandle.writeFile(serializedOwner, { encoding: "utf8" });
        await createdHandle.sync();
        const info = await statHandleWithRetry(createdHandle);
        if (!info.isFile() || (info.mode & 0o777) !== 0o600) {
          throw codedError("RESEARCH_STATE_UNAVAILABLE");
        }
        const lock = { handle: createdHandle, dev: info.dev, ino: info.ino, owner };
        if (!await ownsLock(lock, OWNERSHIP_CHECK_ATTEMPTS)) {
          throw codedError("RESEARCH_STATE_UNAVAILABLE");
        }
        return lock;
      } catch (error) {
        if (createdHandle) {
          let removed = false;
          if (createdIdentity) {
            try {
              removed = await safelyRemoveCreatedLock(createdIdentity);
            } catch {
              // The recorded inode could not be safely detached from the fixed path.
            }
          }
          try {
            await createdHandle.close();
          } catch {
            // The creation failure remains authoritative.
          }
          if (removed) ORPHANED_LOCK_NONCES.delete(owner.nonce);
          else ORPHANED_LOCK_NONCES.add(owner.nonce);
        }
        if (error?.code !== "EEXIST") {
          if (error?.code === "RESEARCH_STATE_UNAVAILABLE") throw error;
          throw codedError("RESEARCH_STATE_UNAVAILABLE");
        }
      }

      if (await recoverDeadLock()) continue;
      const remaining = deadline - (await currentTime());
      if (remaining <= 0) throw codedError("RESEARCH_STATE_BUSY");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(lockRetryMs, remaining)));
    }
  }

  async function releaseLock(lock) {
    let failed = false;
    let removed = false;
    try {
      removed = await safelyRemoveOwnedLock(lock, "release", OWNERSHIP_CHECK_ATTEMPTS);
      if (!removed) failed = true;
    } catch {
      failed = true;
    }
    try {
      await lock.handle.close();
    } catch {
      failed = true;
    }
    if (removed) ORPHANED_LOCK_NONCES.delete(lock.owner.nonce);
    else ORPHANED_LOCK_NONCES.add(lock.owner.nonce);
    if (failed) throw codedError("RESEARCH_STATE_UNAVAILABLE");
  }

  async function persistNeedsOwnerAction(value, notifier) {
    const state = await validateState(value);
    const lock = await acquireLock();
    let result;
    let failure;
    try {
      const previous = await load();
      const isNewTransition = !sameTransition(previous, state);
      await writeState(state, lock);
      if (!await ownsLock(lock, OWNERSHIP_CHECK_ATTEMPTS)) {
        throw codedError("RESEARCH_STATE_UNAVAILABLE");
      }
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
