import type {
  AgentRun,
  DecisionCommand,
  DecisionCommandResult,
  DecisionWorkspace,
  DecisionWorkspaceRepository,
  Member,
  TripRepository,
} from "@travel/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import seed from "../../../../content/trip.seed.json";
import { TripApp } from "../App";
import { LocalTripRepository } from "../infrastructure/localTripRepository";
import type { RouteSegment, RouteService } from "../features/map/types";
import { LoginPage } from "../features/auth/LoginPage";
import { AuthCallbackPage } from "../features/auth/AuthCallbackPage";
import { BootstrapPage } from "../features/auth/BootstrapPage";
import { PendingApprovalPage } from "../features/auth/PendingApprovalPage";
import { AuthShell } from "../features/auth/AuthShell";
import { logout, recoverAuthenticatedMember } from "../infrastructure/authSession";
import { LocalAgentBridgeError, type LocalAgentBridge } from "../infrastructure/localAgentBridgeClient";
import {
  browserDataMode,
  callActiveBrowserTestBridge,
  readBrowserTestDecisionCoordinator,
  type TestDecisionResearchCall,
  type TestDecisionResearchCoordinator,
} from "./browserEnvironment";

const decisionResearchCoordinatorName = "__decisionResearchHarnessCall";
const decisionResearchWorkspaceEvent = "decision-research-test-workspace-refresh";

type ProductionAuthState =
  | { status: "checking" }
  | { status: "login" }
  | { status: "pending" }
  | { status: "error" }
  | { status: "authenticated"; member: Member };

function authErrorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
}

function browserTestDecisionCoordinator(): TestDecisionResearchCoordinator | undefined {
  if (!import.meta.env.DEV) return undefined;
  return readBrowserTestDecisionCoordinator(
    true,
    window.location.search,
    () => (window as typeof window & { __decisionResearchHarnessCall?: TestDecisionResearchCoordinator })[decisionResearchCoordinatorName],
  );
}

async function callTestDecisionCoordinator<T>(coordinator: TestDecisionResearchCoordinator, call: TestDecisionResearchCall): Promise<T> {
  const result = await coordinator(call);
  if (!result.ok) throw new Error(result.error);
  return result.data as T;
}

async function callTestDecisionBridge<T>(coordinator: TestDecisionResearchCoordinator, call: TestDecisionResearchCall): Promise<T> {
  const result = await coordinator(call);
  if (!result.ok) throw new LocalAgentBridgeError(result.error as ConstructorParameters<typeof LocalAgentBridgeError>[0]);
  return result.data as T;
}

function createBrowserTestRepository(): TripRepository | undefined {
  if (!import.meta.env.DEV) return undefined;
  const params = new URLSearchParams(window.location.search);
  const delayMs = Number(params.get("__testSaveDelayMs"));
  const hotelRouteFixture = params.get("__testRouteMap") === "1";
  const dateWarningFixture = params.get("__testDateWarning") === "1";
  if ((!Number.isFinite(delayMs) || delayMs <= 0) && !hotelRouteFixture && !dateWarningFixture) return undefined;

  let fixture = hotelRouteFixture ? {
    ...seed,
    days: seed.days.map((day) => day.city === "香港" ? { ...day, itemIds: ["peak", "star-ferry"] } : day),
  } : seed;
  if (dateWarningFixture) {
    fixture = {
      ...fixture,
      orders: fixture.orders.map((order) => order.category === "hotel" ? { ...order, dayId: fixture.days.at(-1)?.id } : order),
    };
  }
  const localRepository = new LocalTripRepository(fixture);
  return {
    load: (tripId) => localRepository.load(tripId),
    subscribe: (tripId, onChange) => localRepository.subscribe(tripId, onChange),
    save: async (trip, expectedVersion) => {
      if (Number.isFinite(delayMs) && delayMs > 0) await new Promise((resolve) => window.setTimeout(resolve, delayMs));
      return localRepository.save(trip, expectedVersion);
    },
  };
}

function createBrowserTestRouteService(): RouteService | undefined {
  if (!import.meta.env.DEV || new URLSearchParams(window.location.search).get("__testRouteMap") !== "1") return undefined;
  return {
    async getSegments(input) {
      if (input.dayId.includes(":hotel")) {
        const isPark = input.placeIds.includes("park-hotel-hong-kong");
        const walking = input.modeByLeg[0] === "walking";
        return { segments: [{ id: `${input.dayId}-${isPark ? "park" : "kowloon"}`, fromPlaceId: input.placeIds[0]!, toPlaceId: input.placeIds[1]!, mode: walking ? "walking" : "transit", distanceMeters: walking ? (isPark ? 760 : 380) : (isPark ? 2200 : 1300), durationMinutes: walking ? (isPark ? 10 : 5) : (isPark ? 22 : 13), summary: "测试高德酒店路线", path: [] }], failures: [] };
      }
      const fixtures = [
        {
          id: "test-peak-arabica",
          fromPlaceId: "peak",
          toPlaceId: "arabica-peak",
          mode: "transit",
          distanceMeters: 1800,
          durationMinutes: 15,
          summary: "测试提供方公共交通路线",
          path: [
            { lng: 114.1454, lat: 22.2757, coordinateSystem: "GCJ02" },
            { lng: 114.148, lat: 22.273, coordinateSystem: "GCJ02" },
            { lng: 114.150192, lat: 22.270851, coordinateSystem: "GCJ02" },
          ],
        },
        {
          id: "test-arabica-central",
          fromPlaceId: "arabica-peak",
          toPlaceId: "central-pier",
          mode: "transit",
          distanceMeters: 1800,
          durationMinutes: 15,
          summary: "测试提供方公共交通路线",
          path: [
            { lng: 114.150192, lat: 22.270851, coordinateSystem: "GCJ02" },
            { lng: 114.154678, lat: 22.268561, coordinateSystem: "GCJ02" },
            { lng: 114.166177, lat: 22.284364, coordinateSystem: "GCJ02" },
          ],
        },
        {
          id: "test-central-ferry",
          fromPlaceId: "central-pier",
          toPlaceId: "star-ferry",
          mode: "transit",
          distanceMeters: 1300,
          durationMinutes: 12,
          summary: "测试提供方公共交通路线",
          path: [
            { lng: 114.1596, lat: 22.2864, coordinateSystem: "GCJ02" },
            { lng: 114.1637, lat: 22.2901, coordinateSystem: "GCJ02" },
            { lng: 114.1691, lat: 22.2947, coordinateSystem: "GCJ02" },
          ],
        },
        {
          id: "test-peak-ferry",
          fromPlaceId: "peak",
          toPlaceId: "star-ferry",
          mode: "transit",
          distanceMeters: 4100,
          durationMinutes: 32,
          summary: "测试提供方公共交通路线",
          path: [
            { lng: 114.1454, lat: 22.2757, coordinateSystem: "GCJ02" },
            { lng: 114.154678, lat: 22.268561, coordinateSystem: "GCJ02" },
            { lng: 114.166177, lat: 22.284364, coordinateSystem: "GCJ02" },
            { lng: 114.173827, lat: 22.29081, coordinateSystem: "GCJ02" },
          ],
        },
      ] satisfies RouteSegment[];
      const segments = fixtures.filter((segment) => input.placeIds.some((id, index) => id === segment.fromPlaceId && input.placeIds[index + 1] === segment.toPlaceId));
      return { segments, failures: [] };
    },
  };
}

function createBrowserTestMemberFixture() {
  if (!import.meta.env.DEV) return undefined;
  const params = new URLSearchParams(window.location.search);
  if (params.get("__testMemberManagement") !== "1" && params.get("__testDecisionAgent") !== "1") return undefined;
  const admin = { uid: "e2e-admin", displayName: "测试管理员", role: "admin", version: 1, createdAt: "2026-08-30T00:00:00.000Z" } satisfies Member;
  const companion = { uid: "e2e-companion", displayName: "低视口测试同行者（名字很长）", role: "member", version: 1, createdAt: "2026-08-30T00:00:00.000Z" } satisfies Member;
  const member = params.get("__testDecisionAgentRole") === "member" ? companion : admin;
  return { member, members: [admin, companion] };
}

type TestAgentRunCoordinator = (input: Extract<DecisionCommand, { action: "createAgentRun" }>) => Promise<{ agentRunId: string; expiresAt: string }>;

function createBrowserTestDecisionRepository(): DecisionWorkspaceRepository | undefined {
  if (!import.meta.env.DEV || new URLSearchParams(window.location.search).get("__testDecisionAgent") !== "1") return undefined;
  const researchCoordinator = browserTestDecisionCoordinator();
  if (researchCoordinator) {
    return {
      load: (tripId) => callTestDecisionCoordinator(researchCoordinator, { operation: "workspace.load", input: { tripId } }),
      refresh: (tripId) => callTestDecisionCoordinator(researchCoordinator, { operation: "workspace.refresh", input: { tripId } }),
      command: (input) => callTestDecisionCoordinator(researchCoordinator, { operation: "workspace.command", input }),
      getAgentRunStatus: (tripId, agentRunId) => callTestDecisionCoordinator(researchCoordinator, { operation: "workspace.agent-run-status", input: { tripId, agentRunId } }),
      events: async (_tripId, afterCursor) => ({ events: [], cursor: afterCursor }),
      subscribe: (tripId, onChange) => {
        let active = true;
        const refresh = () => {
          void callTestDecisionCoordinator<DecisionWorkspace>(researchCoordinator, { operation: "workspace.refresh", input: { tripId } })
            .then((next) => { if (active) onChange(next); })
            .catch(() => undefined);
        };
        window.addEventListener(decisionResearchWorkspaceEvent, refresh);
        return () => {
          active = false;
          window.removeEventListener(decisionResearchWorkspaceEvent, refresh);
        };
      },
    };
  }
  const coordinator = (window as typeof window & { __createTestAgentRun?: TestAgentRunCoordinator }).__createTestAgentRun;
  if (typeof coordinator !== "function") return undefined;
  let run: AgentRun | undefined;
  const workspace = (tripId: string): DecisionWorkspace => ({
    tripId,
    preferences: [],
    candidates: [],
    placements: [],
    evidence: [],
    feedback: [],
    confirmations: [],
    workspaceCursor: "0",
    fetchedAt: new Date().toISOString(),
  });
  return {
    load: async (tripId) => workspace(tripId),
    refresh: async (tripId) => workspace(tripId),
    subscribe: () => () => undefined,
    events: async (_tripId, afterCursor) => ({ events: [], cursor: afterCursor }),
    command: async (input): Promise<DecisionCommandResult> => {
      if (input.action !== "createAgentRun") return { ok: false, error: "INVALID_REQUEST" };
      const data = await coordinator(input);
      const createdAt = new Date().toISOString();
      run = {
        agentRunId: data.agentRunId,
        tripId: input.tripId,
        status: "claimed",
        scope: input.scope,
        revision: 2,
        nextSequence: 2,
        createdAt,
        claimedAt: createdAt,
        expiresAt: data.expiresAt,
      };
      return { ok: true, action: "createAgentRun", data };
    },
    getAgentRunStatus: async (tripId, agentRunId) => {
      if (!run || run.tripId !== tripId || run.agentRunId !== agentRunId) throw new Error("AGENT_RUN_NOT_FOUND");
      return run;
    },
  };
}

function createBrowserTestAgentBridge(): LocalAgentBridge | undefined {
  if (new URLSearchParams(window.location.search).get("__testDecisionAgentRole") === "member") return undefined;
  const coordinator = browserTestDecisionCoordinator();
  if (!coordinator) return undefined;
  let requestSequence = 0;
  const callBridge = <T,>(operation: Extract<TestDecisionResearchCall["operation"], `bridge.${string}`>, input: unknown, options?: { signal?: AbortSignal }) => {
    const signal = options?.signal;
    return callActiveBrowserTestBridge(signal, () => {
      const requestId = `test-bridge-request-${++requestSequence}`;
      const request = callTestDecisionBridge<T>(coordinator, {
        operation,
        input,
        request: { requestId, aborted: false },
      });
      const abort = () => {
        void callTestDecisionCoordinator(coordinator, { operation: "bridge.abort", input: { requestId } }).catch(() => undefined);
      };
      signal?.addEventListener("abort", abort, { once: true });
      return request.finally(() => signal?.removeEventListener("abort", abort));
    });
  };
  return {
    prepare: (options) => callBridge("bridge.prepare", undefined, options),
    claim: (agentRunId, options) => callBridge("bridge.claim", { agentRunId }, options),
    executeTravelResearch: (input, options) => callBridge("bridge.execute", input, options),
    getResearchStatus: (options) => callBridge("bridge.status", undefined, options),
    resumeTravelResearch: (input, options) => callBridge("bridge.resume", input, options),
    cancelResearch: (input, options) => callBridge("bridge.cancel", input, options),
  };
}

export function BrowserRoot({ agentBridge }: { agentBridge?: LocalAgentBridge } = {}) {
  const mode = browserDataMode(import.meta.env.DEV, import.meta.env.VITE_DATA_MODE);
  if (mode === "cloudbase") return <ProductionAuthGate agentBridge={agentBridge} />;
  if (mode === "local") return <DevBrowserRoot agentBridge={agentBridge} />;
  return (
    <AuthShell step="配置检查" title="旅行助手尚未正确发布" description="生产环境没有连接到共享行程服务。">
      <p className="auth-error" role="alert">请联系管理员检查数据模式配置后重新发布。</p>
    </AuthShell>
  );
}

function DevBrowserRoot({ agentBridge }: { agentBridge?: LocalAgentBridge }) {
  const [repository] = useState(createBrowserTestRepository);
  const [decisionRepository] = useState(createBrowserTestDecisionRepository);
  const [testAgentBridge] = useState(createBrowserTestAgentBridge);
  const [routeService] = useState(createBrowserTestRouteService);
  const [memberFixture] = useState(createBrowserTestMemberFixture);
  return <BrowserRouter><TripApp repository={repository} decisionRepository={decisionRepository} routeService={routeService} member={memberFixture?.member} memberManagementInitialMembers={memberFixture?.members} agentBridge={memberFixture?.member.role === "member" ? undefined : agentBridge ?? testAgentBridge} /></BrowserRouter>;
}

export function ProductionAuthGate({ agentBridge }: { agentBridge?: LocalAgentBridge } = {}) {
  const [authState, setAuthState] = useState<ProductionAuthState>({ status: "checking" });
  const acceptMember = useCallback((member: Member) => {
    setAuthState(member.role === "pending" ? { status: "pending" } : member.role === "admin" || member.role === "member" ? { status: "authenticated", member } : { status: "login" });
  }, []);
  const refreshAuth = useCallback(async () => {
    try {
      const member = await recoverAuthenticatedMember();
      acceptMember(member);
    } catch (error) {
      const code = authErrorCode(error);
      if (code === "PENDING_APPROVAL") setAuthState({ status: "pending" });
      else if (["AUTH_REQUIRED", "MEMBERSHIP_REQUIRED", "NOT_AUTHORIZED", "REMOVED"].includes(String(code))) setAuthState({ status: "login" });
      else setAuthState({ status: "error" });
    }
  }, [acceptMember]);
  /* oxlint-disable react/set-state-in-effect -- initial auth state synchronizes with the external auth session */
  useEffect(() => {
    void refreshAuth();
  }, [refreshAuth]);
  /* oxlint-enable react/set-state-in-effect */

  return (
    <BrowserRouter>
      <ProductionRoutes authState={authState} setAuthState={setAuthState} acceptMember={acceptMember} onRetryAuth={refreshAuth} agentBridge={agentBridge} />
    </BrowserRouter>
  );
}

function ProductionRoutes({ authState, setAuthState, acceptMember, onRetryAuth, agentBridge }: { authState: ProductionAuthState; setAuthState: (state: ProductionAuthState) => void; acceptMember: (member: Member) => void; onRetryAuth: () => Promise<void>; agentBridge?: LocalAgentBridge }) {
  const navigate = useNavigate();
  const location = useLocation();
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const frame = requestAnimationFrame(() => {
      const destination = document.querySelector<HTMLElement>("main");
      if (!destination) return;
      destination.tabIndex = -1;
      destination.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [authState.status, location.pathname, location.search]);
  const handleUnauthorized = useCallback((error: unknown) => {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
    setAuthState({ status: code === "PENDING_APPROVAL" ? "pending" : "login" });
    void logout().catch(() => undefined);
    navigate(code === "PENDING_APPROVAL" ? "/auth/pending" : "/", { replace: true });
  }, [navigate, setAuthState]);
  const handleLogout = useCallback(async () => {
    await logout();
    setAuthState({ status: "login" });
    navigate("/", { replace: true });
  }, [navigate, setAuthState]);
  const home = authState.status === "checking"
    ? <AuthShell step="身份检查" title="正在寻找你的旅行通行证" description="如果已经登录，我们会直接带你回到行程。"><div className="auth-progress" role="status"><span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" /><b>正在恢复登录状态…</b></div></AuthShell>
    : authState.status === "error"
      ? <AuthShell step="连接检查" title="暂时无法确认登录状态" description="登录信息仍保留在这台设备上，请在网络恢复后重试。"><p className="auth-error" role="alert">暂时无法确认登录状态，请检查网络。</p><button className="auth-secondary control-button control-button--secondary" type="button" onClick={() => { setAuthState({ status: "checking" }); void onRetryAuth(); }}>重新检查登录状态</button></AuthShell>
    : authState.status === "pending"
      ? <PendingApprovalPage onAuthenticated={acceptMember} onLogout={handleLogout} />
      : authState.status === "authenticated"
        ? <TripApp member={authState.member} onUnauthorized={handleUnauthorized} onLogout={handleLogout} agentBridge={agentBridge} />
        : <LoginPage />;
  const isHostingCallback = new URLSearchParams(location.search).get("auth_callback") === "1";

  return (
    <Routes>
      <Route path="/" element={isHostingCallback ? <AuthCallbackPage onAuthenticated={acceptMember} /> : home} />
      <Route path="/auth/callback" element={<AuthCallbackPage onAuthenticated={acceptMember} />} />
      <Route path="/auth/bootstrap" element={<BootstrapPage onAuthenticated={acceptMember} />} />
      <Route path="/auth/pending" element={<PendingApprovalPage onAuthenticated={acceptMember} onLogout={handleLogout} />} />
      <Route path="*" element={home} />
    </Routes>
  );
}
