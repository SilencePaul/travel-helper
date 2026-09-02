import type { Page } from "@playwright/test";
import type {
  AgentRun,
  CandidateCategory,
  DecisionCommand,
  DecisionCommandResult,
  DecisionWorkspace,
  ResearchStatus,
} from "../../packages/contracts/src/index";

export const decisionResearchCoordinatorName = "__decisionResearchHarnessCall";
export const decisionResearchWorkspaceEvent = "decision-research-test-workspace-refresh";

export type DecisionResearchHarnessCall = {
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
    | "bridge.cancel";
  input?: unknown;
};

type HarnessResult = { ok: true; data: unknown } | { ok: false; error: string };
type PendingBridgeOperation = {
  resolve: (result: HarnessResult) => void;
};

type HarnessOptions = {
  initialCandidates?: CandidateCategory[];
  prepareError?: "CODEX_NOT_AVAILABLE" | "CODEX_NOT_AUTHENTICATED";
};

const now = "2026-08-31T00:00:00.000Z";
const taskBase = { researchTaskId: "research-task-e2e", startedAt: now, updatedAt: now };
const candidateNames: Record<CandidateCategory, [string, string]> = {
  hotel: ["海景行旅", "湾畔酒店"],
  restaurant: ["码头茶餐厅", "巷里小馆"],
  attraction: ["海港博物馆", "山顶花园"],
};

function candidate(category: CandidateCategory, index: number) {
  const id = `candidate-${category}-${index + 1}`;
  const evidenceId = `evidence-${category}-${index + 1}`;
  const evidence = {
    id: evidenceId,
    tripId: "trip-2026-gba",
    revision: 1,
    updatedAt: now,
    candidateId: id,
    sourceKind: "official" as const,
    sourceName: "测试官方来源",
    sourceUrl: `https://${category}-${index + 1}.example.test/detail`,
    capturedAt: now,
    queryContext: { dates: { start: "2026-10-04", end: "2026-10-05" }, travelers: 2 },
    captureMethod: "detail_page" as const,
    facts: category === "hotel"
      ? { propertyName: candidateNames[category][index], address: "香港测试地址", checkInDate: "2026-10-04", checkOutDate: "2026-10-05", travelers: 2, roomTypeOrBed: "大床房", availability: "available" as const, priceAmount: 1200, currency: "CNY", priceDisplay: "total" as const, cancellationPolicy: "可免费取消" }
      : category === "attraction"
        ? { name: candidateNames[category][index], address: "香港测试地址", openInformation: "09:00–18:00", priceSnapshot: "CNY 100", ticketType: "标准票" }
        : { name: candidateNames[category][index], address: "香港测试地址", openInformation: "11:00–22:00", priceSnapshot: "人均 CNY 120" },
    fieldCompleteness: ["name", "address"],
    verificationOutcome: "web_verified" as const,
  };
  return {
    candidate: {
      id,
      tripId: "trip-2026-gba",
      revision: 1,
      updatedAt: now,
      category,
      entity: { name: candidateNames[category][index], address: "香港测试地址" },
      applicability: { dates: { start: "2026-10-04", end: "2026-10-05" }, travelers: 2 },
      recommendation: { round: 1, reason: `专注${category}类别的测试候选`, preferenceRevisionIds: [], feedbackIds: [] },
      verificationState: "web_verified" as const,
      decisionState: "none" as const,
      currentEvidenceId: evidenceId,
    },
    evidence: [
      evidence,
      { ...evidence, id: `${evidenceId}-secondary`, sourceKind: "web" as const, sourceName: "测试独立来源", sourceUrl: `https://independent-${category}-${index + 1}.example.test/detail` },
    ],
  };
}

function workspace(categories: CandidateCategory[] = []): DecisionWorkspace {
  const pairs = categories.flatMap((category) => [candidate(category, 0), candidate(category, 1)]);
  return {
    tripId: "trip-2026-gba",
    preferences: [],
    candidates: pairs.map((pair) => pair.candidate),
    placements: [],
    evidence: pairs.flatMap((pair) => pair.evidence),
    feedback: [],
    confirmations: [],
    workspaceCursor: String(pairs.length),
    fetchedAt: now,
  };
}

export class DecisionResearchHarness {
  readonly calls: DecisionResearchHarnessCall[] = [];
  private currentWorkspace: DecisionWorkspace;
  private currentStatus: ResearchStatus = { phase: "idle" };
  private runs = new Map<string, AgentRun>();
  private createByIdempotency = new Map<string, string>();
  private pending: PendingBridgeOperation[] = [];
  private selectedCategory: CandidateCategory = "hotel";
  private nextRun = 1;
  private readonly prepareError?: HarnessOptions["prepareError"];

  constructor(private readonly page: Page, options: HarnessOptions = {}) {
    this.currentWorkspace = workspace(options.initialCandidates);
    this.prepareError = options.prepareError;
  }

  async install() {
    await this.page.exposeFunction(decisionResearchCoordinatorName, (call: DecisionResearchHarnessCall) => this.handle(call));
  }

  count(operation: DecisionResearchHarnessCall["operation"]) {
    return this.calls.filter((call) => call.operation === operation).length;
  }

  inputs(operation: DecisionResearchHarnessCall["operation"]) {
    return this.calls.filter((call) => call.operation === operation).map((call) => call.input);
  }

  async publishDisclosureChange() {
    this.currentWorkspace = {
      ...this.currentWorkspace,
      summary: {
        id: "summary-e2e",
        tripId: this.currentWorkspace.tripId,
        revision: 1,
        updatedAt: now,
        sourcePreferenceRevisions: {},
        common: ["希望新候选靠近码头"],
        disagreements: [],
        tradeoffs: [],
        status: "ready",
        generatedAt: now,
      },
      workspaceCursor: String(Number(this.currentWorkspace.workspaceCursor) + 1),
    };
    await this.page.evaluate((eventName) => window.dispatchEvent(new Event(eventName)), decisionResearchWorkspaceEvent);
  }

  complete() {
    this.currentWorkspace = workspace([this.selectedCategory]);
    this.settlePending({ phase: "completed", ...taskBase });
  }

  blockForAuth() {
    this.revokeClaimedRuns();
    this.settlePending({ phase: "needs_owner_action", ...taskBase, blockedReason: "codex_auth_required" });
  }

  blockForSource(hostname = "booking.example.com") {
    this.revokeClaimedRuns();
    this.settlePending({ phase: "needs_owner_action", ...taskBase, blockedReason: "source_captcha", blockedHostname: hostname });
  }

  beginResearching() {
    this.settlePending({ phase: "researching", ...taskBase });
  }

  private settlePending(status: Exclude<ResearchStatus, { phase: "idle" }>) {
    this.currentStatus = status;
    const operation = this.pending.shift();
    if (!operation) throw new Error("No pending Bridge operation to settle");
    operation.resolve({ ok: true, data: status });
  }

  private revokeClaimedRuns() {
    for (const [id, run] of this.runs) {
      if (run.status === "claimed") this.runs.set(id, { ...run, status: "revoked", revision: run.revision + 1, revokedAt: now });
    }
  }

  private async handle(call: DecisionResearchHarnessCall): Promise<HarnessResult> {
    this.calls.push(structuredClone(call));
    switch (call.operation) {
      case "workspace.load":
      case "workspace.refresh":
        return { ok: true, data: structuredClone(this.currentWorkspace) };
      case "workspace.command":
        return this.command(call.input as DecisionCommand);
      case "workspace.agent-run-status": {
        const { agentRunId } = call.input as { agentRunId: string };
        const run = this.runs.get(agentRunId);
        return run ? { ok: true, data: structuredClone(run) } : { ok: false, error: "AGENT_RUN_NOT_FOUND" };
      }
      case "bridge.prepare":
        return this.prepareError
          ? { ok: false, error: this.prepareError }
          : { ok: true, data: { publicKeyJwk: { kty: "EC", crv: "P-256", x: "test-x", y: "test-y" }, pairingCodeHash: "a".repeat(43), pairingCodeFingerprint: "E2E SAFE FIXTURE" } };
      case "bridge.claim": {
        const { agentRunId } = call.input as { agentRunId: string };
        const run = this.runs.get(agentRunId);
        if (!run || run.status === "revoked") return { ok: false, error: "AGENT_RUN_INACTIVE" };
        this.runs.set(agentRunId, { ...run, status: "claimed", revision: run.revision + 1, claimedAt: now, nextSequence: 2 });
        return { ok: true, data: { agentRunId, status: "claimed" } };
      }
      case "bridge.execute":
        this.selectedCategory = (call.input as { targetCategory: CandidateCategory }).targetCategory;
        return new Promise((resolve) => this.pending.push({ resolve }));
      case "bridge.status":
        return { ok: true, data: structuredClone(this.currentStatus) };
      case "bridge.resume":
        return new Promise((resolve) => this.pending.push({ resolve }));
      case "bridge.cancel": {
        const status = { phase: "cancelled", ...taskBase, errorCode: "CODEX_RESEARCH_CANCELLED" } satisfies ResearchStatus;
        this.currentStatus = status;
        this.revokeClaimedRuns();
        return { ok: true, data: status };
      }
    }
  }

  private command(input: DecisionCommand): HarnessResult {
    if (input.action === "createAgentRun") {
      const previous = this.createByIdempotency.get(input.idempotencyKey);
      const agentRunId = previous ?? `agent-run-e2e-${this.nextRun++}`;
      this.createByIdempotency.set(input.idempotencyKey, agentRunId);
      if (!this.runs.has(agentRunId)) {
        this.runs.set(agentRunId, {
          agentRunId,
          tripId: input.tripId,
          status: "pending_claim",
          scope: input.scope,
          revision: 1,
          nextSequence: 1,
          createdAt: now,
          expiresAt: "2099-08-31T00:15:00.000Z",
        });
      }
      const result: DecisionCommandResult = { ok: true, action: "createAgentRun", data: { agentRunId, expiresAt: "2099-08-31T00:15:00.000Z" } };
      return { ok: true, data: result };
    }
    if (input.action === "revokeAgentRun") {
      const run = this.runs.get(input.agentRunId);
      if (!run) return { ok: false, error: "AGENT_RUN_NOT_FOUND" };
      this.runs.set(input.agentRunId, { ...run, status: "revoked", revision: run.revision + 1, revokedAt: now });
      const result: DecisionCommandResult = { ok: true, action: "revokeAgentRun", data: { agentRunId: input.agentRunId, revokedAt: now } };
      return { ok: true, data: result };
    }
    return { ok: false, error: "INVALID_REQUEST" };
  }
}
