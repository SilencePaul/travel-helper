import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { chmod, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  PROPOSAL_RECONCILIATION_STATE_FIELDS,
  RECOVERY_STATE_FIELDS,
  RECONCILIATION_STATE_FIELDS,
  createResearchStateStore,
} from "./research-state-store.mjs";
import { createMacosNotifier } from "./macos-notifier.mjs";

const STATE_FILE = "travel-research-state.json";
const LOCK_FILE = ".travel-research-state.lock";
const PUBLIC_RESOLVER = async () => [{ address: "8.8.8.8", family: 4 }];

function lockOwner(pid = process.pid, nonce = "replacement-owner-nonce-1234") {
  return `${JSON.stringify({ pid, nonce })}\n`;
}

function recoverableState(overrides = {}) {
  return {
    tripId: "trip-private",
    researchTaskId: "research-task-1",
    agentRunId: "agent-run-1",
    operationId: "operation-1",
    reconciliationState: "active",
    codexThreadId: "0198f29d-45df-7ce0-8f84-140b19c5ca21",
    targetCategory: "hotel",
    targetScopeId: `scope_${"a".repeat(64)}`,
    disclosureFingerprint: "b".repeat(64),
    aliasSalt: "safe-alias-salt-1234",
    blockedReason: "source_login_required",
    blockedHostname: "booking.example.org",
    activeRuntimeMs: 12_345,
    phase: "needs_owner_action",
    startedAt: "2026-09-01T01:02:03.000Z",
    updatedAt: "2026-09-01T01:04:05.000Z",
    ...overrides,
  };
}

function reconciliationState(overrides = {}) {
  const agentRunId = "agent-run-1";
  return {
    recordType: "self_revoke_reconciliation",
    tripId: "trip-private",
    researchTaskId: "research-task-1",
    agentRunId,
    operationId: "operation-1",
    reconciliationState: "self_revoke_reconciling",
    activePhase: "validating",
    revokeRequest: {
      agentRunId,
      expiresAt: "2026-09-01T01:15:00.000Z",
      firstSentAt: Date.parse("2026-09-01T01:03:00.000Z"),
      body: JSON.stringify({
        agentRunId,
        sequence: 4,
        idempotencyKey: "revoke-operation-1",
        action: "revokeAgentRunSelf",
        payload: {},
        signature: "s".repeat(86),
      }),
    },
    codexThreadId: "0198f29d-45df-7ce0-8f84-140b19c5ca21",
    targetCategory: "hotel",
    targetScopeId: `scope_${"a".repeat(64)}`,
    disclosureFingerprint: "b".repeat(64),
    aliasSalt: "safe-alias-salt-1234",
    blockedReason: "source_login_required",
    blockedHostname: "booking.example.org",
    activeRuntimeMs: 12_345,
    terminalPhase: "needs_owner_action",
    startedAt: "2026-09-01T01:02:03.000Z",
    updatedAt: "2026-09-01T01:04:05.000Z",
    ...overrides,
  };
}

function proposalReconciliationState(overrides = {}) {
  const agentRunId = "agent-run-1";
  const envelope = (action, payload, sequence, suffix) => JSON.stringify({
    agentRunId,
    sequence,
    idempotencyKey: `${action}-${suffix}`,
    action,
    payload,
    signature: "s".repeat(86),
  });
  return {
    recordType: "proposal_submit_reconciliation",
    tripId: "trip-private",
    researchTaskId: "research-task-1",
    agentRunId,
    operationId: "operation-1",
    reconciliationState: "active",
    submission: {
      agentRunId,
      expiresAt: "2026-09-01T01:15:00.000Z",
      firstSentAt: Date.parse("2026-09-01T01:03:00.000Z"),
      submitBody: envelope("submitProposalBatch", {
        round: 1,
        candidates: [{ category: "hotel" }, { category: "hotel" }],
      }, 4, "submit"),
      successRevokeBody: envelope("revokeAgentRunSelf", {}, 5, "success"),
      failureRevokeBody: envelope("revokeAgentRunSelf", {}, 4, "failure"),
    },
    activeRuntimeMs: 12_345,
    startedAt: "2026-09-01T01:02:03.000Z",
    updatedAt: "2026-09-01T01:04:05.000Z",
    ...overrides,
  };
}

async function temporaryStore(context, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "research-state-store-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "application-data");
  return {
    directory,
    filePath: join(directory, STATE_FILE),
    store: createResearchStateStore({ directory, resolveHostname: PUBLIC_RESOLVER, ...options }),
  };
}

test("persists one strict recovery record with owner-only permissions", async (context) => {
  const { directory, filePath, store } = await temporaryStore(context);
  const state = recoverableState();

  await store.save(state);

  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.deepEqual(await store.load(), state);

  const serialized = await readFile(filePath, "utf8");
  assert.deepEqual(Object.keys(JSON.parse(serialized)), RECOVERY_STATE_FIELDS);
  for (const forbidden of [
    "travelerName", "memberName", "city", "travelDate", "preference", "candidates",
    "prompt", "output", "uid", "credential", "privateKey", "pairingCode",
    "深圳", "2026-10-03", "一鸣", "网页原始输出",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("persists only the fixed signed self-revoke replay record before terminal publication", async (context) => {
  const { filePath, store } = await temporaryStore(context);
  const state = reconciliationState();

  await store.persistSelfRevokeReconciliation(state);

  assert.deepEqual(await store.load(), state);
  const serialized = await readFile(filePath, "utf8");
  assert.deepEqual(Object.keys(JSON.parse(serialized)), RECONCILIATION_STATE_FIELDS);
  for (const forbidden of ["privateKey", "pairingCode", "travelerName", "prompt", "output", "cookie"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("persists only a strict proposal replay responsibility and rejects nested private data", async (context) => {
  const { filePath, store } = await temporaryStore(context);
  const state = proposalReconciliationState();

  await store.persistProposalReconciliation(state);

  assert.deepEqual(await store.load(), state);
  const serialized = await readFile(filePath, "utf8");
  assert.deepEqual(Object.keys(JSON.parse(serialized)), PROPOSAL_RECONCILIATION_STATE_FIELDS);
  for (const forbidden of ["privateKey", "pairingCode", "cookie", "credential", "codexThreadId"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }

  const privateEnvelope = JSON.parse(state.submission.submitBody);
  privateEnvelope.payload.candidates[0].privateKey = "must-never-persist";
  await assert.rejects(store.persistProposalReconciliation(proposalReconciliationState({
    submission: { ...state.submission, submitBody: JSON.stringify(privateEnvelope) },
  })), { code: "RESEARCH_STATE_INVALID" });

  const credentialEnvelope = JSON.parse(state.submission.submitBody);
  credentialEnvelope.payload.candidates[0].reason = "Bearer exposed-token-1234";
  await assert.rejects(store.persistProposalReconciliation(proposalReconciliationState({
    submission: { ...state.submission, submitBody: JSON.stringify(credentialEnvelope) },
  })), { code: "RESEARCH_STATE_INVALID" });
});

test("writes through a same-directory temporary file and atomic rename", async (context) => {
  const renames = [];
  const synced = [];
  const fileSystem = {
    ...fs,
    async open(path, flags, mode) {
      const handle = await fs.open(path, flags, mode);
      return {
        async chmod(...args) { return handle.chmod(...args); },
        async writeFile(...args) { return handle.writeFile(...args); },
        async read(...args) { return handle.read(...args); },
        async readFile(...args) { return handle.readFile(...args); },
        async stat(...args) { return handle.stat(...args); },
        async sync() { synced.push(path); return handle.sync(); },
        async close() { return handle.close(); },
      };
    },
    async rename(from, to) {
      renames.push({ from, to });
      return fs.rename(from, to);
    },
  };
  const { directory, filePath, store } = await temporaryStore(context, {
    fileSystem,
    tempToken: () => "fixed-safe-token",
  });

  await store.save(recoverableState());

  const stateRenames = renames.filter(({ to }) => to === filePath);
  assert.equal(stateRenames.length, 1);
  assert.equal(dirname(stateRenames[0].from), directory);
  assert.equal(dirname(stateRenames[0].to), directory);
  assert.notEqual(stateRenames[0].from, filePath);
  await assert.rejects(stat(stateRenames[0].from), { code: "ENOENT" });
  assert.equal(synced.includes(stateRenames[0].from), true);
  assert.equal(synced.includes(directory), true);
});

test("a post-rename directory sync failure reports uncertainty while preserving the exact reconciliation record", async (context) => {
  let stateDirectory;
  let stateFilePath;
  let published = false;
  let failDirectorySync = false;
  const fileSystem = {
    ...fs,
    async open(path, flags, mode) {
      const handle = await fs.open(path, flags, mode);
      if (path !== stateDirectory || !failDirectorySync) return handle;
      return {
        async stat(...args) { return handle.stat(...args); },
        async sync() {
          failDirectorySync = false;
          throw new Error("directory sync failed after publish");
        },
        async close() { return handle.close(); },
      };
    },
    async rename(from, to) {
      const result = await fs.rename(from, to);
      if (to === stateFilePath) {
        published = true;
        failDirectorySync = true;
      }
      return result;
    },
  };
  const created = await temporaryStore(context, { fileSystem });
  stateDirectory = created.directory;
  stateFilePath = created.filePath;
  const state = reconciliationState();

  await assert.rejects(created.store.persistSelfRevokeReconciliation(state), { code: "RESEARCH_STATE_UNAVAILABLE" });

  assert.equal(published, true);
  assert.deepEqual(await created.store.load(), state);
});

test("cleans an exclusively-created temporary file when writing fails", async (context) => {
  const { directory } = await temporaryStore(context);
  const fileSystem = {
    ...fs,
    async open(path, flags, mode) {
      const handle = await fs.open(path, flags, mode);
      if (!path.endsWith(".tmp")) return handle;
      return {
        async chmod(...args) { return handle.chmod(...args); },
        async stat(...args) { return handle.stat(...args); },
        async writeFile() { throw new Error("raw write failure"); },
        async sync() { return handle.sync(); },
        async close() { return handle.close(); },
      };
    },
  };
  const store = createResearchStateStore({
    directory,
    fileSystem,
    tempToken: () => "failed-write-token",
    resolveHostname: PUBLIC_RESOLVER,
  });

  await assert.rejects(store.save(recoverableState()), { code: "RESEARCH_STATE_UNAVAILABLE" });
  assert.deepEqual((await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
});

test("rejects extra, missing, malformed, nested, and privacy-bearing fields", async (context) => {
  const { filePath, store } = await temporaryStore(context);
  const cases = [
    { ...recoverableState(), travelerName: "一鸣" },
    Object.fromEntries(Object.entries(recoverableState()).filter(([key]) => key !== "updatedAt")),
    { ...recoverableState(), prompt: "search Shenzhen" },
    { ...recoverableState(), output: { candidates: [] } },
    { ...recoverableState(), targetScopeId: "scope_stale" },
    { ...recoverableState(), disclosureFingerprint: "not-a-fingerprint" },
    { ...recoverableState(), aliasSalt: "short" },
    { ...recoverableState(), blockedHostname: "https://booking.example.org/login?token=secret" },
    { ...recoverableState(), researchTaskId: "旅行任务-深圳" },
    { ...recoverableState(), activeRuntimeMs: -1 },
    { ...recoverableState(), phase: "researching" },
  ];
  for (const state of cases) {
    await assert.rejects(store.save(state), { code: "RESEARCH_STATE_INVALID" });
  }

  await store.save(recoverableState());
  const onDisk = JSON.parse(await readFile(filePath, "utf8"));
  await writeFile(filePath, JSON.stringify({ ...onDisk, uid: "private-uid" }), { mode: 0o600 });
  await assert.rejects(store.load(), { code: "RESEARCH_STATE_INVALID" });
});

test("clear is idempotent and removes completed or cancelled task recovery", async (context) => {
  const { filePath, store } = await temporaryStore(context);

  await store.save(recoverableState());
  await store.clear();
  assert.equal(await store.load(), undefined);
  await assert.rejects(stat(filePath), { code: "ENOENT" });

  await store.save(recoverableState({ researchTaskId: "research-task-2" }));
  await store.clear();
  await store.clear();
  assert.equal(await store.load(), undefined);
});

test("persists a new owner-action transition before notifying and does not re-notify after restart", async (context) => {
  const { directory, filePath, store } = await temporaryStore(context);
  const calls = [];
  const notifier = {
    async notifyOwnerAction(transitionKey) {
      calls.push({
        transitionKey,
        persisted: JSON.parse(await readFile(filePath, "utf8")),
      });
      return true;
    },
  };
  const first = recoverableState();

  await store.persistNeedsOwnerAction(first, notifier);
  await store.persistNeedsOwnerAction(first, notifier);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].persisted, first);

  const restarted = createResearchStateStore({ directory, resolveHostname: PUBLIC_RESOLVER });
  await restarted.persistNeedsOwnerAction(first, notifier);
  assert.equal(calls.length, 1);

  const second = recoverableState({ updatedAt: "2026-09-01T01:05:06.000Z" });
  await restarted.persistNeedsOwnerAction(second, notifier);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].persisted, second);
  assert.notEqual(calls[0].transitionKey, calls[1].transitionKey);
});

test("publishing a blocker notifies once even when its reconciliation intent used the same timestamp", async (context) => {
  const { store } = await temporaryStore(context);
  let notifications = 0;
  const intent = reconciliationState();
  const blocker = recoverableState();

  await store.persistSelfRevokeReconciliation(intent);
  await store.persistNeedsOwnerAction(blocker, {
    async notifyOwnerAction() {
      notifications += 1;
      return true;
    },
  });
  await store.persistNeedsOwnerAction(blocker, {
    async notifyOwnerAction() {
      notifications += 1;
      return true;
    },
  });

  assert.equal(notifications, 1);
});

test("notification failure never rolls back or hides persisted owner-action state", async (context) => {
  const { store } = await temporaryStore(context);
  const state = recoverableState({
    blockedReason: "codex_auth_required",
    blockedHostname: null,
  });

  await assert.doesNotReject(store.persistNeedsOwnerAction(state, {
    async notifyOwnerAction() {
      throw new Error("raw notification failure");
    },
  }));
  assert.deepEqual(await store.load(), state);
});

test("a hanging macOS notification cannot keep a persisted transition pending", async (context) => {
  const { store } = await temporaryStore(context);
  const child = new (await import("node:events")).EventEmitter();
  child.signals = [];
  child.kill = (signal) => { child.signals.push(signal); return true; };
  const notifier = createMacosNotifier({
    spawnImpl: () => child,
    timeoutMs: 10,
    terminationGraceMs: 10,
  });
  const state = recoverableState();

  const result = await Promise.race([
    store.persistNeedsOwnerAction(state, notifier),
    new Promise((resolve) => setTimeout(() => resolve("still-pending"), 250)),
  ]);

  assert.deepEqual(result, state);
  assert.deepEqual(await store.load(), state);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("two independent stores serialize the same transition and notify only once", async (context) => {
  const { directory } = await temporaryStore(context);
  const first = createResearchStateStore({ directory, resolveHostname: PUBLIC_RESOLVER });
  const second = createResearchStateStore({ directory, resolveHostname: PUBLIC_RESOLVER });
  const observedLockContents = [];
  let notificationCalls = 0;
  const notifier = {
    async notifyOwnerAction() {
      notificationCalls += 1;
      observedLockContents.push(await readFile(join(directory, LOCK_FILE), "utf8"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      return true;
    },
  };

  await Promise.all([
    first.persistNeedsOwnerAction(recoverableState(), notifier),
    second.persistNeedsOwnerAction(recoverableState(), notifier),
  ]);

  assert.equal(notificationCalls, 1);
  assert.equal(observedLockContents.length, 1);
  const owner = JSON.parse(observedLockContents[0]);
  assert.deepEqual(Object.keys(owner), ["pid", "nonce"]);
  assert.equal(owner.pid, process.pid);
  assert.match(owner.nonce, /^[A-Za-z0-9_-]{16,128}$/u);
  assert.equal(/name|city|prompt|output|credential|private|pairing/iu.test(observedLockContents[0]), false);
  await assert.rejects(stat(join(directory, LOCK_FILE)), { code: "ENOENT" });
});

test("recovers a dead-PID lock despite a future mtime but bounds waiting on a live PID", async (context) => {
  const { directory } = await temporaryStore(context);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, LOCK_FILE);
  await writeFile(lockPath, lockOwner(424_242), { flag: "wx", mode: 0o600 });
  await chmod(lockPath, 0o600);
  await utimes(lockPath, new Date("2099-01-01T00:00:00.000Z"), new Date("2099-01-01T00:00:00.000Z"));

  const recovered = createResearchStateStore({
    directory,
    lockWaitMs: 100,
    lockRetryMs: 2,
    isProcessAlive: (pid) => pid !== 424_242,
    resolveHostname: PUBLIC_RESOLVER,
  });
  await recovered.persistNeedsOwnerAction(recoverableState(), { notifyOwnerAction: async () => true });
  await assert.rejects(stat(lockPath), { code: "ENOENT" });

  await writeFile(lockPath, lockOwner(process.pid, "live-owner-nonce-1234"), { flag: "wx", mode: 0o600 });
  await utimes(lockPath, new Date(0), new Date(0));
  const bounded = createResearchStateStore({
    directory,
    lockWaitMs: 20,
    lockRetryMs: 2,
    isProcessAlive: () => true,
    resolveHostname: PUBLIC_RESOLVER,
  });
  await assert.rejects(
    bounded.persistNeedsOwnerAction(recoverableState({ updatedAt: "2026-09-01T01:05:06.000Z" }), {
      notifyOwnerAction: async () => true,
    }),
    { code: "RESEARCH_STATE_BUSY" },
  );
});

test("a validation failure never removes a replacement lock", async (context) => {
  const { directory } = await temporaryStore(context);
  const lockPath = join(directory, LOCK_FILE);
  let replaced = false;
  const fileSystem = {
    ...fs,
    async open(path, flags, mode) {
      const handle = await fs.open(path, flags, mode);
      if (path !== lockPath && !path.startsWith(`${lockPath}.owner.`)) return handle;
      return {
        async chmod(...args) { return handle.chmod(...args); },
        async writeFile(...args) { return handle.writeFile(...args); },
        async sync(...args) { return handle.sync(...args); },
        async stat() {
          if (!replaced) {
            replaced = true;
            try {
              await fs.unlink(lockPath);
            } catch (error) {
              if (error?.code !== "ENOENT") throw error;
            }
            await writeFile(lockPath, lockOwner(process.pid, "new-owner-nonce-1234"), {
              flag: "wx",
              mode: 0o600,
            });
            await chmod(lockPath, 0o600);
          }
          throw new Error("raw lock stat failure");
        },
        async close() { return handle.close(); },
      };
    },
  };
  const store = createResearchStateStore({ directory, fileSystem, resolveHostname: PUBLIC_RESOLVER });

  await assert.rejects(
    store.persistNeedsOwnerAction(recoverableState(), { notifyOwnerAction: async () => true }),
    { code: "RESEARCH_STATE_UNAVAILABLE" },
  );
  assert.equal(await readFile(lockPath, "utf8"), lockOwner(process.pid, "new-owner-nonce-1234"));
});

test("lock owner setup failures never leave a zero-byte or partial well-known lock", async (context) => {
  for (const failure of ["zero", "partial", "chmod", "sync", "validation-stat"]) {
    const { directory } = await temporaryStore(context);
    const lockPath = join(directory, LOCK_FILE);
    let statCalls = 0;
    const fileSystem = {
      ...fs,
      async open(path, flags, mode) {
        const handle = await fs.open(path, flags, mode);
        if (path !== lockPath && !path.startsWith(`${lockPath}.owner.`)) return handle;
        return {
          async chmod(...args) {
            if (failure === "chmod") throw new Error("raw chmod failure");
            return handle.chmod(...args);
          },
          async writeFile(value) {
            if (failure === "partial") await handle.write(String(value).slice(0, 5));
            throw new Error("raw owner write failure");
          },
          async read(...args) { return handle.read(...args); },
          async stat(...args) {
            statCalls += 1;
            if (failure === "validation-stat" && statCalls > 1) {
              throw new Error("raw validation stat failure");
            }
            return handle.stat(...args);
          },
          async sync(...args) {
            if (failure === "sync") throw new Error("raw owner sync failure");
            return handle.sync(...args);
          },
          async close() { return handle.close(); },
        };
      },
    };
    const store = createResearchStateStore({ directory, fileSystem, resolveHostname: PUBLIC_RESOLVER });

    await assert.rejects(store.save(recoverableState()), { code: "RESEARCH_STATE_UNAVAILABLE" });
    await assert.rejects(stat(lockPath), { code: "ENOENT" }, failure);
  }
});

test("a partial owner temp with transient cleanup faults never publishes or blocks the next store", async (context) => {
  const { directory } = await temporaryStore(context);
  const lockPath = join(directory, LOCK_FILE);
  let partialWriteAttempted = false;
  let cleanupFaults = 3;
  const fileSystem = {
    ...fs,
    async open(path, flags, mode) {
      const handle = await fs.open(path, flags, mode);
      const ownerTemp = path.startsWith(`${lockPath}.owner.`);
      if (path !== lockPath && !ownerTemp) return handle;
      return {
        async chmod(...args) { return handle.chmod(...args); },
        async writeFile(value) {
          partialWriteAttempted = true;
          await handle.write(String(value).slice(0, 5));
          throw new Error("partial owner write failure");
        },
        async read(...args) { return handle.read(...args); },
        async stat(...args) { return handle.stat(...args); },
        async sync(...args) { return handle.sync(...args); },
        async close() { return handle.close(); },
      };
    },
    async lstat(path) {
      if (partialWriteAttempted
        && cleanupFaults > 0
        && (path === lockPath || path.startsWith(`${lockPath}.owner.`))) {
        cleanupFaults -= 1;
        throw new Error("transient cleanup lstat failure");
      }
      return fs.lstat(path);
    },
  };
  const first = createResearchStateStore({ directory, fileSystem, resolveHostname: PUBLIC_RESOLVER });

  await assert.rejects(first.save(recoverableState()), { code: "RESEARCH_STATE_UNAVAILABLE" });
  assert.equal(partialWriteAttempted, true);
  assert.equal(cleanupFaults, 0);
  await assert.rejects(stat(lockPath), { code: "ENOENT" });

  const second = createResearchStateStore({ directory, resolveHostname: PUBLIC_RESOLVER });
  const nextState = recoverableState({
    researchTaskId: "after-owner-temp-failure",
    updatedAt: "2026-09-01T01:10:11.000Z",
  });
  await second.save(nextState);
  assert.deepEqual(await second.load(), nextState);
});

test("owner temp publication uses link EEXIST without overwriting a legal lock", async (context) => {
  const { directory } = await temporaryStore(context);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, LOCK_FILE);
  const existingOwner = lockOwner(process.pid, "existing-live-owner-1234");
  await writeFile(lockPath, existingOwner, { flag: "wx", mode: 0o600 });
  await chmod(lockPath, 0o600);
  let publishAttempts = 0;
  const fileSystem = {
    ...fs,
    async link(from, to) {
      if (to === lockPath) {
        publishAttempts += 1;
        assert.equal(await readFile(lockPath, "utf8"), existingOwner);
      }
      return fs.link(from, to);
    },
  };
  const store = createResearchStateStore({
    directory,
    fileSystem,
    isProcessAlive: () => true,
    lockWaitMs: 20,
    lockRetryMs: 2,
    resolveHostname: PUBLIC_RESOLVER,
  });

  await assert.rejects(store.save(recoverableState()), { code: "RESEARCH_STATE_BUSY" });
  assert.ok(publishAttempts > 0);
  assert.equal(await readFile(lockPath, "utf8"), existingOwner);
  assert.deepEqual(
    (await fs.readdir(directory)).filter((name) => name.startsWith(`${LOCK_FILE}.owner.`)),
    [],
  );
});

test("load reads and validates through one no-follow file descriptor", async (context) => {
  const { directory, store } = await temporaryStore(context);
  await store.save(recoverableState());
  const fdOnly = createResearchStateStore({
    directory,
    resolveHostname: PUBLIC_RESOLVER,
    fileSystem: {
      ...fs,
      async readFile() { throw new Error("path read must not be used"); },
    },
  });

  assert.deepEqual(await fdOnly.load(), recoverableState());
});

test("rejects broad dangerous directories before any chmod or write", () => {
  for (const directory of [
    "/", "/tmp", "/private/tmp", "/var", "/Users", "/home",
    tmpdir(), homedir(), "/tmp/../tmp",
  ]) {
    assert.throws(() => createResearchStateStore({ directory }), { code: "RESEARCH_STATE_INVALID" });
  }
});

test("rejects local, private, reserved, and IP-literal blocked sources", async (context) => {
  const { store } = await temporaryStore(context);
  for (const blockedHostname of [
    "localhost",
    "login.localhost",
    "router.local",
    "service.internal",
    "source.test",
    "127.0.0.1",
    "10.0.0.8",
    "169.254.1.1",
    "192.168.1.1",
    "224.0.0.1",
    "0177.0.0.1",
  ]) {
    await assert.rejects(
      store.save(recoverableState({ blockedHostname })),
      { code: "RESEARCH_STATE_INVALID" },
    );
  }

  await assert.doesNotReject(store.save(recoverableState({ blockedHostname: "login.booking.com" })));
});

test("an active PID lock is never stolen during a slow write", async (context) => {
  const { directory } = await temporaryStore(context);
  let slowWriteReached;
  const reachedSlowWrite = new Promise((resolve) => { slowWriteReached = resolve; });
  let delayed = false;
  const slowFileSystem = {
    ...fs,
    async rename(from, to) {
      if (!delayed && to.endsWith(STATE_FILE)) {
        delayed = true;
        slowWriteReached();
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      return fs.rename(from, to);
    },
  };
  const lockOptions = {
    lockWaitMs: 250,
    lockRetryMs: 2,
    resolveHostname: PUBLIC_RESOLVER,
  };
  const first = createResearchStateStore({ directory, fileSystem: slowFileSystem, ...lockOptions });
  const second = createResearchStateStore({ directory, ...lockOptions });
  let notifications = 0;
  const notifier = { notifyOwnerAction: async () => { notifications += 1; return true; } };

  const firstRun = first.persistNeedsOwnerAction(recoverableState(), notifier);
  await reachedSlowWrite;
  const secondRun = second.persistNeedsOwnerAction(recoverableState(), notifier);
  await Promise.all([firstRun, secondRun]);

  assert.equal(notifications, 1);
});

test("an old owner never removes a replacement lock it does not own", async (context) => {
  const { directory, store } = await temporaryStore(context);
  const lockPath = join(directory, LOCK_FILE);
  const notifier = {
    async notifyOwnerAction() {
      await fs.unlink(lockPath);
      await writeFile(lockPath, lockOwner(process.pid, "replacement-owner-nonce-1234"), { flag: "wx", mode: 0o600 });
      await chmod(lockPath, 0o600);
      return true;
    },
  };

  await assert.rejects(
    store.persistNeedsOwnerAction(recoverableState(), notifier),
    { code: "RESEARCH_STATE_UNAVAILABLE" },
  );
  assert.equal((await stat(lockPath)).isFile(), true);
});

test("a replaced owner cannot publish over the replacement owner's state", async (context) => {
  const { directory, filePath } = await temporaryStore(context);
  const lockPath = join(directory, LOCK_FILE);
  const replacement = recoverableState({
    researchTaskId: "replacement-task",
    updatedAt: "2026-09-01T01:05:06.000Z",
  });
  let replaced = false;
  const fileSystem = {
    ...fs,
    async open(path, flags, mode) {
      const handle = await fs.open(path, flags, mode);
      if (!path.endsWith(".tmp")) return handle;
      return {
        async chmod(...args) { return handle.chmod(...args); },
        async writeFile(...args) { return handle.writeFile(...args); },
        async stat(...args) { return handle.stat(...args); },
        async sync(...args) {
          await handle.sync(...args);
          if (!replaced) {
            replaced = true;
            await fs.unlink(lockPath);
            await writeFile(lockPath, lockOwner(process.pid, "replacement-owner-nonce-5678"), {
              flag: "wx",
              mode: 0o600,
            });
            await chmod(lockPath, 0o600);
            await writeFile(filePath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
            await chmod(filePath, 0o600);
          }
        },
        async close() { return handle.close(); },
      };
    },
  };
  const store = createResearchStateStore({ directory, fileSystem, resolveHostname: PUBLIC_RESOLVER });

  await assert.rejects(
    store.persistNeedsOwnerAction(recoverableState(), { notifyOwnerAction: async () => true }),
    { code: "RESEARCH_STATE_UNAVAILABLE" },
  );
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), replacement);
  assert.equal(await readFile(lockPath, "utf8"), lockOwner(process.pid, "replacement-owner-nonce-5678"));
});

test("direct save also owns and rechecks the lock before publishing", async (context) => {
  const { directory, filePath } = await temporaryStore(context);
  const lockPath = join(directory, LOCK_FILE);
  const replacement = recoverableState({
    researchTaskId: "replacement-save-task",
    updatedAt: "2026-09-01T01:06:07.000Z",
  });
  let foundLock = false;
  let intercepted = false;
  const fileSystem = {
    ...fs,
    async open(path, flags, mode) {
      const handle = await fs.open(path, flags, mode);
      if (!path.endsWith(".tmp")) return handle;
      return {
        async chmod(...args) { return handle.chmod(...args); },
        async writeFile(...args) { return handle.writeFile(...args); },
        async stat(...args) { return handle.stat(...args); },
        async sync(...args) {
          await handle.sync(...args);
          if (!intercepted) {
            intercepted = true;
            try {
              await fs.unlink(lockPath);
              foundLock = true;
            } catch (error) {
              if (error?.code !== "ENOENT") throw error;
            }
            if (foundLock) {
              await writeFile(lockPath, lockOwner(process.pid, "replacement-save-nonce-1234"), {
                flag: "wx",
                mode: 0o600,
              });
              await chmod(lockPath, 0o600);
            }
            await writeFile(filePath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
            await chmod(filePath, 0o600);
          }
        },
        async close() { return handle.close(); },
      };
    },
  };
  const store = createResearchStateStore({ directory, fileSystem, resolveHostname: PUBLIC_RESOLVER });

  await assert.rejects(store.save(recoverableState()), { code: "RESEARCH_STATE_UNAVAILABLE" });
  assert.equal(foundLock, true);
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), replacement);
});

test("losing the lock inside the publish rename window removes the old owner's published inode", async (context) => {
  const { directory, filePath } = await temporaryStore(context);
  const lockPath = join(directory, LOCK_FILE);
  const replacement = recoverableState({
    researchTaskId: "publish-window-replacement",
    updatedAt: "2026-09-01T01:07:08.000Z",
  });
  let intercepted = false;
  const fileSystem = {
    ...fs,
    async rename(from, to) {
      if (!intercepted && from.endsWith(".tmp") && to === filePath) {
        intercepted = true;
        await fs.unlink(lockPath);
        await writeFile(lockPath, lockOwner(process.pid, "publish-window-lock-1234"), {
          flag: "wx",
          mode: 0o600,
        });
        await chmod(lockPath, 0o600);
        await writeFile(filePath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
        await chmod(filePath, 0o600);
      }
      return fs.rename(from, to);
    },
  };
  const store = createResearchStateStore({ directory, fileSystem, resolveHostname: PUBLIC_RESOLVER });
  const oldOwnerState = recoverableState();

  await assert.rejects(
    store.persistNeedsOwnerAction(oldOwnerState, { notifyOwnerAction: async () => true }),
    { code: "RESEARCH_STATE_UNAVAILABLE" },
  );
  let persisted;
  try {
    persisted = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  assert.notDeepEqual(persisted, oldOwnerState);
  assert.equal(await readFile(lockPath, "utf8"), lockOwner(process.pid, "publish-window-lock-1234"));
});

test("publish rollback never deletes a state inode installed after the old owner publishes", async (context) => {
  const { directory, filePath } = await temporaryStore(context);
  const lockPath = join(directory, LOCK_FILE);
  const replacement = recoverableState({
    researchTaskId: "post-publish-replacement",
    updatedAt: "2026-09-01T01:08:09.000Z",
  });
  let intercepted = false;
  const fileSystem = {
    ...fs,
    async rename(from, to) {
      const result = await fs.rename(from, to);
      if (!intercepted && from.endsWith(".tmp") && to === filePath) {
        intercepted = true;
        await fs.unlink(lockPath);
        await writeFile(lockPath, lockOwner(process.pid, "post-publish-lock-1234"), {
          flag: "wx",
          mode: 0o600,
        });
        await chmod(lockPath, 0o600);
        await fs.unlink(filePath);
        await writeFile(filePath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
        await chmod(filePath, 0o600);
      }
      return result;
    },
  };
  const store = createResearchStateStore({ directory, fileSystem, resolveHostname: PUBLIC_RESOLVER });

  await assert.rejects(store.save(recoverableState()), { code: "RESEARCH_STATE_UNAVAILABLE" });
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), replacement);
  assert.equal(await readFile(lockPath, "utf8"), lockOwner(process.pid, "post-publish-lock-1234"));
});

test("release retries one transient ownership stat failure and removes its own lock", async (context) => {
  const { directory } = await temporaryStore(context);
  const lockPath = join(directory, LOCK_FILE);
  let failReleaseCheck = false;
  let injected = false;
  const fileSystem = {
    ...fs,
    async lstat(path) {
      if (path === lockPath && failReleaseCheck && !injected) {
        injected = true;
        throw new Error("transient release lstat failure");
      }
      return fs.lstat(path);
    },
  };
  const store = createResearchStateStore({ directory, fileSystem, resolveHostname: PUBLIC_RESOLVER });

  await assert.doesNotReject(store.persistNeedsOwnerAction(recoverableState(), {
    async notifyOwnerAction() {
      failReleaseCheck = true;
      return true;
    },
  }));
  assert.equal(injected, true);
  await assert.rejects(stat(lockPath), { code: "ENOENT" });
});

test("a same-process nonce marked orphaned after persistent release failure is recoverable", async (context) => {
  const { directory } = await temporaryStore(context);
  const lockPath = join(directory, LOCK_FILE);
  let failReleaseChecks = false;
  const failingFileSystem = {
    ...fs,
    async lstat(path) {
      if (path === lockPath && failReleaseChecks) throw new Error("persistent release lstat failure");
      return fs.lstat(path);
    },
  };
  const first = createResearchStateStore({
    directory,
    fileSystem: failingFileSystem,
    resolveHostname: PUBLIC_RESOLVER,
  });

  await assert.rejects(first.persistNeedsOwnerAction(recoverableState(), {
    async notifyOwnerAction() {
      failReleaseChecks = true;
      return true;
    },
  }), { code: "RESEARCH_STATE_UNAVAILABLE" });
  assert.equal((await stat(lockPath)).isFile(), true);

  const second = createResearchStateStore({
    directory,
    lockWaitMs: 50,
    lockRetryMs: 2,
    isProcessAlive: () => true,
    resolveHostname: PUBLIC_RESOLVER,
  });
  const nextState = recoverableState({
    researchTaskId: "same-process-recovery",
    updatedAt: "2026-09-01T01:09:10.000Z",
  });
  await second.save(nextState);

  assert.deepEqual(await second.load(), nextState);
  await assert.rejects(stat(lockPath), { code: "ENOENT" });
});

test("explicit fd chmod preserves state and lock mode under a restrictive umask", async (context) => {
  const { directory, filePath, store } = await temporaryStore(context);
  const lockModes = [];
  const previousMask = process.umask(0o777);
  try {
    await store.save(recoverableState());
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
    assert.deepEqual(await store.load(), recoverableState());
    await store.persistNeedsOwnerAction(
      recoverableState({ updatedAt: "2026-09-01T01:05:06.000Z" }),
      {
        async notifyOwnerAction() {
          lockModes.push((await stat(join(directory, LOCK_FILE))).mode & 0o777);
          return true;
        },
      },
    );
  } finally {
    process.umask(previousMask);
  }

  assert.deepEqual(lockModes, [0o600]);
});

test("a failed detached-lock inspection restores the lock without orphan files", async (context) => {
  const { directory } = await temporaryStore(context);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, LOCK_FILE);
  const serializedOwner = lockOwner(424_242, "dead-owner-nonce-1234");
  await writeFile(lockPath, serializedOwner, { flag: "wx", mode: 0o600 });
  await chmod(lockPath, 0o600);
  await utimes(lockPath, new Date(0), new Date(0));
  const fileSystem = {
    ...fs,
    async lstat(path) {
      if (path.includes(`${LOCK_FILE}.stale.`)) throw new Error("raw detached stat failure");
      return fs.lstat(path);
    },
  };
  const store = createResearchStateStore({
    directory,
    fileSystem,
    isProcessAlive: () => false,
    resolveHostname: PUBLIC_RESOLVER,
    lockWaitMs: 20,
    lockRetryMs: 2,
  });

  await assert.rejects(
    store.persistNeedsOwnerAction(recoverableState(), { notifyOwnerAction: async () => true }),
    { code: "RESEARCH_STATE_UNAVAILABLE" },
  );
  assert.equal(await readFile(lockPath, "utf8"), serializedOwner);
  assert.deepEqual((await fs.readdir(directory)).filter((name) => name.includes(`${LOCK_FILE}.stale.`)), []);
});

test("DNS validation rejects hostnames resolving to any non-global address on save and load", async (context) => {
  const { directory } = await temporaryStore(context);
  const privateAnswers = [
    "127.0.0.1",
    "10.0.0.8",
    "100.64.0.1",
    "169.254.1.1",
    "192.168.1.1",
    "198.51.100.2",
    "224.0.0.1",
    "::1",
    "::127.0.0.1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "5f00::1",
    "ff00::1",
  ];
  for (const address of privateAnswers) {
    const store = createResearchStateStore({
      directory,
      resolveHostname: async () => [{ address }],
    });
    await assert.rejects(
      store.save(recoverableState({ blockedHostname: "127.0.0.1.nip.io" })),
      { code: "RESEARCH_STATE_INVALID" },
    );
  }

  const mixed = createResearchStateStore({
    directory,
    resolveHostname: async () => ["8.8.8.8", "192.168.1.1"],
  });
  await assert.rejects(mixed.save(recoverableState()), { code: "RESEARCH_STATE_INVALID" });

  const writer = createResearchStateStore({ directory, resolveHostname: PUBLIC_RESOLVER });
  await writer.save(recoverableState({ blockedHostname: "127.0.0.1.nip.io" }));
  const reader = createResearchStateStore({
    directory,
    resolveHostname: async () => [{ address: "127.0.0.1", family: 4 }],
  });
  await assert.rejects(reader.load(), { code: "RESEARCH_STATE_INVALID" });
});

test("DNS validation fails closed on empty, malformed, failed, and timed-out resolution", async (context) => {
  const { directory } = await temporaryStore(context);
  const resolvers = [
    async () => [],
    async () => [{ address: "not-an-ip" }],
    async () => { throw new Error("raw DNS failure"); },
    async () => new Promise(() => {}),
  ];

  for (const resolveHostname of resolvers) {
    const store = createResearchStateStore({ directory, resolveHostname, dnsTimeoutMs: 5 });
    await assert.rejects(store.save(recoverableState()), { code: "RESEARCH_STATE_INVALID" });
  }
});

test("DNS validation accepts only a hostname whose complete answer set is global", async (context) => {
  const calls = [];
  const { store } = await temporaryStore(context, {
    resolveHostname: async (hostname) => {
      calls.push(hostname);
      return [
        { address: "8.8.8.8", family: 4 },
        { address: "2606:4700:4700::1111", family: 6 },
      ];
    },
  });

  await store.save(recoverableState({ blockedHostname: "login.booking.com" }));
  assert.deepEqual(await store.load(), recoverableState({ blockedHostname: "login.booking.com" }));
  assert.deepEqual(calls, ["login.booking.com", "login.booking.com"]);
});
