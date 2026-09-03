import { LocalAgentBridgeError } from "../infrastructure/localAgentBridgeClient";

export type TestDecisionResearchCall = {
  operation:
    | "workspace.load"
    | "workspace.refresh"
    | "workspace.command"
    | "workspace.agent-run-status"
    | "bridge.prepare"
    | "bridge.claim"
    | "bridge.execute"
    | "bridge.status"
    | "bridge.resume"
    | "bridge.cancel"
    | "bridge.abort";
  input?: unknown;
  request?: { requestId: string; aborted: boolean };
};
export type TestDecisionResearchResult = { ok: true; data: unknown } | { ok: false; error: string };
export type TestDecisionResearchCoordinator = (call: TestDecisionResearchCall) => Promise<TestDecisionResearchResult>;

export function browserTestDecisionAgentEnabled(isDevelopment: boolean, search: string) {
  return isDevelopment && new URLSearchParams(search).get("__testDecisionAgent") === "1";
}

export function readBrowserTestDecisionCoordinator(
  isDevelopment: boolean,
  search: string,
  readCoordinator: () => unknown,
): TestDecisionResearchCoordinator | undefined {
  if (!browserTestDecisionAgentEnabled(isDevelopment, search)) return undefined;
  const coordinator = readCoordinator();
  return typeof coordinator === "function" ? coordinator as TestDecisionResearchCoordinator : undefined;
}

export function callActiveBrowserTestBridge<T>(signal: AbortSignal | undefined, send: () => Promise<T>): Promise<T> {
  if (signal?.aborted) return Promise.reject(new LocalAgentBridgeError("AGENT_TRANSPORT_UNAVAILABLE"));
  return send();
}

export function browserDataMode(
  isDevelopment: boolean,
  configuredMode: string | undefined,
): "cloudbase" | "local" | "invalid" {
  if (configuredMode === "cloudbase") return "cloudbase";
  return isDevelopment ? "local" : "invalid";
}
