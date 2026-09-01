import { spawn } from "node:child_process";

export const NOTIFICATION_TITLE = "旅行 Agent 需要你处理";
export const NOTIFICATION_BODY = "请打开共同决定页面查看";

const OSASCRIPT_PATH = "/usr/bin/osascript";
const NOTIFICATION_SCRIPT = `display notification "${NOTIFICATION_BODY}" with title "${NOTIFICATION_TITLE}"`;

export function createMacosNotifier({
  spawnImpl = spawn,
  timeoutMs = 5_000,
  terminationGraceMs = 250,
} = {}) {
  if (typeof spawnImpl !== "function") throw new TypeError("INVALID_NOTIFIER");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000
    || !Number.isSafeInteger(terminationGraceMs)
    || terminationGraceMs <= 0
    || terminationGraceMs > 10_000) {
    throw new TypeError("INVALID_NOTIFIER");
  }
  const attemptedTransitions = new Set();

  async function notifyOwnerAction(transitionKey) {
    if (typeof transitionKey !== "string" || transitionKey.length === 0 || attemptedTransitions.has(transitionKey)) {
      return false;
    }
    attemptedTransitions.add(transitionKey);

    let child;
    try {
      child = spawnImpl(
        OSASCRIPT_PATH,
        ["-e", NOTIFICATION_SCRIPT],
        { shell: false, stdio: "ignore" },
      );
    } catch {
      return false;
    }
    if (!child || typeof child.once !== "function" || typeof child.removeListener !== "function") return false;

    return new Promise((resolve) => {
      let settled = false;
      let timedOut = false;
      let timeoutTimer;
      let escalationTimer;
      let finalTimer;
      const clearTimers = () => {
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        if (escalationTimer !== undefined) clearTimeout(escalationTimer);
        if (finalTimer !== undefined) clearTimeout(finalTimer);
      };
      const onError = () => finish(false);
      const onClose = (code) => finish(!timedOut && code === 0);
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimers();
        child.removeListener("error", onError);
        child.removeListener("close", onClose);
        resolve(result);
      };
      child.once("error", onError);
      child.once("close", onClose);
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill?.("SIGTERM");
        } catch {
          // Escalation below remains bounded even when TERM fails.
        }
        if (settled) return;
        escalationTimer = setTimeout(() => {
          try {
            child.kill?.("SIGKILL");
          } catch {
            // The final bounded wait remains authoritative.
          }
          if (settled) return;
          finalTimer = setTimeout(() => finish(false), terminationGraceMs);
          finalTimer.unref?.();
        }, terminationGraceMs);
        escalationTimer.unref?.();
      }, timeoutMs);
      timeoutTimer.unref?.();
    });
  }

  return Object.freeze({ notifyOwnerAction });
}
