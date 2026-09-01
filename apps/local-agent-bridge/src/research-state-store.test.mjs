import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { chmod, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  RECOVERY_STATE_FIELDS,
  createResearchStateStore,
} from "./research-state-store.mjs";
import { createMacosNotifier } from "./macos-notifier.mjs";

const STATE_FILE = "travel-research-state.json";

function recoverableState(overrides = {}) {
  return {
    researchTaskId: "research-task-1",
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

async function temporaryStore(context, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "research-state-store-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "application-data");
  return {
    directory,
    filePath: join(directory, STATE_FILE),
    store: createResearchStateStore({ directory, ...options }),
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

test("writes through a same-directory temporary file and atomic rename", async (context) => {
  const renames = [];
  const synced = [];
  const fileSystem = {
    ...fs,
    async open(path, flags, mode) {
      const handle = await fs.open(path, flags, mode);
      return {
        async writeFile(...args) { return handle.writeFile(...args); },
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

  assert.equal(renames.length, 1);
  assert.equal(dirname(renames[0].from), directory);
  assert.equal(dirname(renames[0].to), directory);
  assert.equal(renames[0].to, filePath);
  assert.notEqual(renames[0].from, filePath);
  await assert.rejects(stat(renames[0].from), { code: "ENOENT" });
  assert.equal(synced.includes(renames[0].from), true);
  assert.equal(synced.includes(directory), true);
});

test("cleans an exclusively-created temporary file when writing fails", async (context) => {
  const { directory } = await temporaryStore(context);
  const fileSystem = {
    ...fs,
    async open(path, flags, mode) {
      const handle = await fs.open(path, flags, mode);
      if (!path.endsWith(".tmp")) return handle;
      return {
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

  const restarted = createResearchStateStore({ directory });
  await restarted.persistNeedsOwnerAction(first, notifier);
  assert.equal(calls.length, 1);

  const second = recoverableState({ updatedAt: "2026-09-01T01:05:06.000Z" });
  await restarted.persistNeedsOwnerAction(second, notifier);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].persisted, second);
  assert.notEqual(calls[0].transitionKey, calls[1].transitionKey);
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
  });
  const state = recoverableState();

  const result = await Promise.race([
    store.persistNeedsOwnerAction(state, notifier),
    new Promise((resolve) => setTimeout(() => resolve("still-pending"), 250)),
  ]);

  assert.deepEqual(result, state);
  assert.deepEqual(await store.load(), state);
  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("two independent stores serialize the same transition and notify only once", async (context) => {
  const { directory } = await temporaryStore(context);
  const first = createResearchStateStore({ directory });
  const second = createResearchStateStore({ directory });
  const observedLockContents = [];
  let notificationCalls = 0;
  const notifier = {
    async notifyOwnerAction() {
      notificationCalls += 1;
      observedLockContents.push(await readFile(join(directory, ".travel-research-state.lock"), "utf8"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      return true;
    },
  };

  await Promise.all([
    first.persistNeedsOwnerAction(recoverableState(), notifier),
    second.persistNeedsOwnerAction(recoverableState(), notifier),
  ]);

  assert.equal(notificationCalls, 1);
  assert.deepEqual(observedLockContents, [""]);
  await assert.rejects(stat(join(directory, ".travel-research-state.lock")), { code: "ENOENT" });
});

test("recovers an owner-only stale lock but bounds waiting on a live lock", async (context) => {
  const { directory } = await temporaryStore(context);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, ".travel-research-state.lock");
  await writeFile(lockPath, "", { flag: "wx", mode: 0o600 });
  await chmod(lockPath, 0o600);
  await utimes(lockPath, new Date(0), new Date(0));

  const recovered = createResearchStateStore({ directory, lockWaitMs: 100, lockRetryMs: 2, lockStaleMs: 10 });
  await recovered.persistNeedsOwnerAction(recoverableState(), { notifyOwnerAction: async () => true });
  await assert.rejects(stat(lockPath), { code: "ENOENT" });

  await writeFile(lockPath, "", { flag: "wx", mode: 0o600 });
  const bounded = createResearchStateStore({ directory, lockWaitMs: 20, lockRetryMs: 2, lockStaleMs: 60_000 });
  await assert.rejects(
    bounded.persistNeedsOwnerAction(recoverableState({ updatedAt: "2026-09-01T01:05:06.000Z" }), {
      notifyOwnerAction: async () => true,
    }),
    { code: "RESEARCH_STATE_BUSY" },
  );
});

test("cleans a newly-created lock when lock validation fails", async (context) => {
  const { directory } = await temporaryStore(context);
  const lockPath = join(directory, ".travel-research-state.lock");
  const fileSystem = {
    ...fs,
    async open(path, flags, mode) {
      const handle = await fs.open(path, flags, mode);
      if (path !== lockPath) return handle;
      return {
        async stat() { throw new Error("raw lock stat failure"); },
        async close() { return handle.close(); },
      };
    },
  };
  const store = createResearchStateStore({ directory, fileSystem });

  await assert.rejects(
    store.persistNeedsOwnerAction(recoverableState(), { notifyOwnerAction: async () => true }),
    { code: "RESEARCH_STATE_UNAVAILABLE" },
  );
  await assert.rejects(stat(lockPath), { code: "ENOENT" });
});

test("load reads and validates through one no-follow file descriptor", async (context) => {
  const { directory, store } = await temporaryStore(context);
  await store.save(recoverableState());
  const fdOnly = createResearchStateStore({
    directory,
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
