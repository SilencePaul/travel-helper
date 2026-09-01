import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  RECOVERY_STATE_FIELDS,
  createResearchStateStore,
} from "./research-state-store.mjs";

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
  const fileSystem = {
    ...fs,
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
