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
    | "bridge.cancel"
    | "bridge.abort";
  input?: unknown;
  request?: { requestId: string; aborted: boolean };
};

type HarnessResult = { ok: true; data: unknown } | { ok: false; error: string };

type HarnessOptions = {
  initialCandidates?: CandidateCategory[];
  existingSharedDecision?: boolean;
  holdPrepare?: boolean;
  prepareError?: "CODEX_NOT_AVAILABLE" | "CODEX_NOT_AUTHENTICATED";
};

const now = "2026-08-31T00:00:00.000Z";
const taskBase = { researchTaskId: "research-task-e2e", startedAt: now, updatedAt: now };
const researchTaskId = taskBase.researchTaskId;
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

function workspaceWithExistingSharedDecision(): DecisionWorkspace {
  const initial = workspace(["hotel"]);
  const existingCandidateId = initial.candidates[0]!.id;
  return {
    ...initial,
    preferences: [{
      id: "preference-existing",
      tripId: initial.tripId,
      ownerUid: "e2e-admin",
      answers: { pace: "slow", accommodation: "quiet" },
      freeText: { mustHave: "安静" },
      status: "completed",
      revision: 2,
      updatedAt: now,
      updatedBy: "e2e-admin",
    }],
    summary: {
      id: "summary-existing",
      tripId: initial.tripId,
      sourcePreferenceRevisions: { "e2e-admin": 2 },
      common: ["都希望住得安静"],
      disagreements: [],
      tradeoffs: ["交通与安静之间平衡"],
      status: "ready",
      generatedAt: now,
      revision: 1,
      updatedAt: now,
    },
    candidates: initial.candidates.map((item) => item.id === existingCandidateId ? { ...item, decisionState: "confirmed" } : item),
    placements: [{ id: "placement-existing", tripId: initial.tripId, candidateId: existingCandidateId, tripDayId: "day-2026-10-04", date: "2026-10-04", sortKey: "a0", status: "planned", revision: 1, updatedAt: now }],
    feedback: [{ id: "feedback-existing", tripId: initial.tripId, candidateId: existingCandidateId, actorUid: "e2e-companion", kind: "like", reason: "位置合适", createdAt: now, revision: 1, updatedAt: now }],
    confirmations: [{ id: "confirmation-existing", tripId: initial.tripId, candidateId: existingCandidateId, memberUid: "e2e-admin", active: true, actedAt: now, revision: 1, updatedAt: now }],
  };
}

function mergeById<T extends { id: string }>(existing: T[], additions: T[]) {
  const existingIds = new Set(existing.map((item) => item.id));
  return [...existing, ...additions.filter((item) => !existingIds.has(item.id))];
}

function inputRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export class DecisionResearchHarness {
  readonly calls: DecisionResearchHarnessCall[] = [];
  private currentWorkspace: DecisionWorkspace;
  private currentStatus: ResearchStatus = { phase: "idle" };
  private runs = new Map<string, AgentRun>();
  private createByIdempotency = new Map<string, string>();
  private selectedCategory: CandidateCategory = "hotel";
  private currentResearchTaskId?: string;
  private currentClaimedRunId?: string;
  private revokeClaimOnStatus = false;
  private nextRun = 1;
  private readonly prepareError?: HarnessOptions["prepareError"];
  private readonly holdPrepare: boolean;
  private readonly pendingRequests = new Map<string, (result: HarnessResult) => void>();

  constructor(private readonly page: Page, options: HarnessOptions = {}) {
    this.currentWorkspace = options.existingSharedDecision
      ? workspaceWithExistingSharedDecision()
      : workspace(options.initialCandidates);
    this.prepareError = options.prepareError;
    this.holdPrepare = options.holdPrepare ?? false;
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

  workspaceSnapshot() {
    return structuredClone(this.currentWorkspace);
  }

  runSnapshot(agentRunId: string) {
    const run = this.runs.get(agentRunId);
    return run ? structuredClone(run) : undefined;
  }

  pendingRequestCount() {
    return this.pendingRequests.size;
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
    const generated = workspace([this.selectedCategory]);
    this.currentWorkspace = {
      ...this.currentWorkspace,
      candidates: mergeById(this.currentWorkspace.candidates, generated.candidates),
      evidence: mergeById(this.currentWorkspace.evidence, generated.evidence),
      workspaceCursor: String(Number(this.currentWorkspace.workspaceCursor) + generated.candidates.length),
      fetchedAt: now,
    };
    this.currentStatus = { phase: "completed", ...taskBase };
    this.revokeClaimedRuns();
    this.revokeClaimOnStatus = false;
  }

  blockForAuth() {
    this.currentStatus = { phase: "needs_owner_action", ...taskBase, blockedReason: "codex_auth_required" };
    this.revokeClaimOnStatus = true;
  }

  blockForSource(hostname = "booking.example.com") {
    this.currentStatus = { phase: "needs_owner_action", ...taskBase, blockedReason: "source_captcha", blockedHostname: hostname };
    this.revokeClaimOnStatus = true;
  }

  beginResearching() {
    this.currentStatus = { phase: "researching", ...taskBase };
  }

  private revokeClaimedRuns() {
    for (const [id, run] of this.runs) {
      if (run.status === "claimed") this.runs.set(id, { ...run, status: "revoked", revision: run.revision + 1, revokedAt: now });
    }
    this.currentClaimedRunId = undefined;
  }

  private activeClaimedRun() {
    if (!this.currentClaimedRunId) return undefined;
    const run = this.runs.get(this.currentClaimedRunId);
    if (run?.status === "claimed" && Date.parse(run.expiresAt) > Date.now()) return run;
    this.currentClaimedRunId = undefined;
    return undefined;
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
        const agentRunId = inputRecord(call.input)?.agentRunId;
        if (typeof agentRunId !== "string") return { ok: false, error: "AGENT_RUN_NOT_FOUND" };
        const run = this.runs.get(agentRunId);
        return run ? { ok: true, data: structuredClone(run) } : { ok: false, error: "AGENT_RUN_NOT_FOUND" };
      }
      case "bridge.prepare": {
        if (this.prepareError) return { ok: false, error: this.prepareError };
        if (this.holdPrepare) {
          if (!call.request?.requestId) return { ok: false, error: "AGENT_TRANSPORT_UNAVAILABLE" };
          return new Promise((resolve) => this.pendingRequests.set(call.request!.requestId, resolve));
        }
        return { ok: true, data: { publicKeyJwk: { kty: "EC", crv: "P-256", x: "test-x", y: "test-y" }, pairingCodeHash: "a".repeat(43), pairingCodeFingerprint: "E2E SAFE FIXTURE" } };
      }
      case "bridge.claim": {
        const agentRunId = inputRecord(call.input)?.agentRunId;
        if (typeof agentRunId !== "string") return { ok: false, error: "AGENT_RUN_INACTIVE" };
        const run = this.runs.get(agentRunId);
        if (!run || run.status !== "pending_claim" || Date.parse(run.expiresAt) <= Date.now()
          || (this.currentClaimedRunId !== undefined && this.currentClaimedRunId !== agentRunId)) {
          return { ok: false, error: "AGENT_RUN_INACTIVE" };
        }
        this.runs.set(agentRunId, { ...run, status: "claimed", revision: run.revision + 1, claimedAt: now, nextSequence: 2 });
        this.currentClaimedRunId = agentRunId;
        return { ok: true, data: { agentRunId, status: "claimed" } };
      }
      case "bridge.execute": {
        const input = inputRecord(call.input);
        const activeRun = this.activeClaimedRun();
        if (!input || input.agentRunId !== activeRun?.agentRunId || this.currentResearchTaskId !== undefined) {
          return { ok: false, error: "AGENT_RUN_INACTIVE" };
        }
        if (typeof input.targetCategory !== "string" || !Object.hasOwn(candidateNames, input.targetCategory)) {
          return { ok: false, error: "INVALID_RESEARCH_TARGET" };
        }
        this.selectedCategory = input.targetCategory as CandidateCategory;
        this.currentResearchTaskId = researchTaskId;
        const status = { phase: "researching", ...taskBase } satisfies ResearchStatus;
        this.currentStatus = status;
        return { ok: true, data: status };
      }
      case "bridge.status": {
        if (this.revokeClaimOnStatus) {
          this.revokeClaimedRuns();
          this.revokeClaimOnStatus = false;
        }
        return { ok: true, data: structuredClone(this.currentStatus) };
      }
      case "bridge.resume": {
        const input = inputRecord(call.input);
        const activeRun = this.activeClaimedRun();
        const expectedAction = this.currentStatus.phase === "needs_owner_action" && this.currentStatus.blockedReason === "codex_auth_required"
          ? "retry_codex_auth"
          : "skip_blocked_source";
        if (!input || input.agentRunId !== activeRun?.agentRunId || input.researchTaskId !== this.currentResearchTaskId
          || this.currentStatus.phase !== "needs_owner_action" || input.resumeAction !== expectedAction) {
          return { ok: false, error: "AGENT_RUN_INACTIVE" };
        }
        const status = { phase: "resuming", ...taskBase } satisfies ResearchStatus;
        this.currentStatus = status;
        return { ok: true, data: status };
      }
      case "bridge.cancel": {
        const requestedTaskId = inputRecord(call.input)?.researchTaskId;
        if (!this.currentResearchTaskId || requestedTaskId !== this.currentResearchTaskId) {
          return { ok: false, error: "AGENT_RUN_INACTIVE" };
        }
        if (this.currentStatus.phase === "completed") {
          return { ok: true, data: structuredClone(this.currentStatus) };
        }
        const status = { phase: "cancelled", ...taskBase, errorCode: "CODEX_RESEARCH_CANCELLED" } satisfies ResearchStatus;
        this.currentStatus = status;
        this.revokeClaimedRuns();
        return { ok: true, data: status };
      }
      case "bridge.abort": {
        const requestId = inputRecord(call.input)?.requestId;
        if (typeof requestId !== "string") return { ok: false, error: "AGENT_TRANSPORT_UNAVAILABLE" };
        const pending = this.pendingRequests.get(requestId);
        if (!pending) return { ok: false, error: "AGENT_TRANSPORT_UNAVAILABLE" };
        this.pendingRequests.delete(requestId);
        pending({ ok: false, error: "AGENT_TRANSPORT_UNAVAILABLE" });
        return { ok: true, data: { requestId, aborted: true } };
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
      if (this.currentClaimedRunId === input.agentRunId) this.currentClaimedRunId = undefined;
      const result: DecisionCommandResult = { ok: true, action: "revokeAgentRun", data: { agentRunId: input.agentRunId, revokedAt: now } };
      return { ok: true, data: result };
    }
    return { ok: false, error: "INVALID_REQUEST" };
  }
}
