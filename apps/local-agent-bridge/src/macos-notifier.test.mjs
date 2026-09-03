import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  NOTIFICATION_BODY,
  NOTIFICATION_TITLE,
  createMacosNotifier,
} from "./macos-notifier.mjs";

function fakeSpawn(outcomes = []) {
  const calls = [];
  let attempts = 0;
  return {
    calls,
    spawnImpl(executable, args, options) {
      const outcome = outcomes[attempts] ?? {};
      attempts += 1;
      if (outcome.throw) throw new Error("raw synchronous spawn failure");
      const child = new EventEmitter();
      child.signals = [];
      child.kill = (signal) => {
        child.signals.push(signal);
        if (outcome.killThrows) throw new Error("raw kill failure");
        if (outcome.closeSynchronouslyOnKillSignal === signal) {
          child.emit("close", null, signal);
        }
        if (outcome.closeOnKillSignal === signal) {
          queueMicrotask(() => child.emit("close", null, signal));
        }
        return true;
      };
      calls.push({ executable, args, options, child });
      queueMicrotask(() => {
        if (outcome.hang) return;
        if (outcome.error) child.emit("error", new Error("raw asynchronous spawn failure"));
        else child.emit("close", outcome.code ?? 0, null);
      });
      return child;
    },
  };
}

test("uses only the fixed osascript executable, text, and shell-free arguments", async () => {
  const fake = fakeSpawn();
  const notifier = createMacosNotifier({ spawnImpl: fake.spawnImpl });

  assert.equal(await notifier.notifyOwnerAction("block-1; display dialog \"injected\""), true);

  assert.equal(fake.calls.length, 1);
  assert.deepEqual({ ...fake.calls[0], child: undefined }, {
    executable: "/usr/bin/osascript",
    args: [
      "-e",
      `display notification "${NOTIFICATION_BODY}" with title "${NOTIFICATION_TITLE}"`,
    ],
    options: {
      shell: false,
      stdio: "ignore",
    },
    child: undefined,
  });
  const invocation = JSON.stringify(fake.calls[0]);
  assert.equal(invocation.includes("block-1"), false);
  assert.equal(NOTIFICATION_TITLE, "旅行 Agent 需要你处理");
  assert.equal(NOTIFICATION_BODY, "请打开共同决定页面查看");
});

test("attempts each new block transition at most once", async () => {
  const fake = fakeSpawn();
  const notifier = createMacosNotifier({ spawnImpl: fake.spawnImpl });

  assert.equal(await notifier.notifyOwnerAction("block-1"), true);
  assert.equal(await notifier.notifyOwnerAction("block-1"), false);
  assert.equal(await notifier.notifyOwnerAction("block-2"), true);
  assert.equal(fake.calls.length, 2);
});

test("synchronous, asynchronous, and non-zero notification failures are isolated and deduplicated", async () => {
  const fake = fakeSpawn([
    { throw: true },
    { error: true },
    { code: 1 },
  ]);
  const notifier = createMacosNotifier({ spawnImpl: fake.spawnImpl });

  assert.equal(await notifier.notifyOwnerAction("sync-failure"), false);
  assert.equal(await notifier.notifyOwnerAction("sync-failure"), false);
  assert.equal(await notifier.notifyOwnerAction("async-failure"), false);
  assert.equal(await notifier.notifyOwnerAction("exit-failure"), false);
  assert.equal(fake.calls.length, 2);
});

test("a hanging notification escalates TERM to KILL and cleans all pending listeners", async () => {
  const fake = fakeSpawn([{ hang: true, closeOnKillSignal: "SIGKILL" }]);
  const notifier = createMacosNotifier({
    spawnImpl: fake.spawnImpl,
    timeoutMs: 10,
    terminationGraceMs: 10,
  });

  const result = await Promise.race([
    notifier.notifyOwnerAction("hanging-transition"),
    new Promise((resolve) => setTimeout(() => resolve("still-pending"), 250)),
  ]);

  assert.equal(result, false);
  assert.deepEqual(fake.calls[0].child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(fake.calls[0].child.listenerCount("error"), 0);
  assert.equal(fake.calls[0].child.listenerCount("close"), 0);
});

test("a synchronous close during termination cancels later escalation", async () => {
  const fake = fakeSpawn([{ hang: true, closeSynchronouslyOnKillSignal: "SIGTERM" }]);
  const notifier = createMacosNotifier({
    spawnImpl: fake.spawnImpl,
    timeoutMs: 5,
    terminationGraceMs: 5,
  });

  assert.equal(await notifier.notifyOwnerAction("synchronous-close"), false);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(fake.calls[0].child.signals, ["SIGTERM"]);
  assert.equal(fake.calls[0].child.listenerCount("error"), 0);
  assert.equal(fake.calls[0].child.listenerCount("close"), 0);
});
