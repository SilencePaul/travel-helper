import { spawn } from "node:child_process";

export const NOTIFICATION_TITLE = "旅行 Agent 需要你处理";
export const NOTIFICATION_BODY = "请打开共同决定页面查看";

const OSASCRIPT_PATH = "/usr/bin/osascript";
const NOTIFICATION_SCRIPT = `display notification "${NOTIFICATION_BODY}" with title "${NOTIFICATION_TITLE}"`;

export function createMacosNotifier({ spawnImpl = spawn, timeoutMs = 5_000 } = {}) {
  if (typeof spawnImpl !== "function") throw new TypeError("INVALID_NOTIFIER");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
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
    if (!child || typeof child.once !== "function") return false;

    return new Promise((resolve) => {
      let settled = false;
      let timer;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve(result);
      };
      child.once("error", () => finish(false));
      child.once("close", (code) => finish(code === 0));
      timer = setTimeout(() => {
        try {
          child.kill?.("SIGTERM");
        } catch {
          // A failed termination attempt must not keep notification pending.
        }
        finish(false);
      }, timeoutMs);
      timer.unref?.();
    });
  }

  return Object.freeze({ notifyOwnerAction });
}
