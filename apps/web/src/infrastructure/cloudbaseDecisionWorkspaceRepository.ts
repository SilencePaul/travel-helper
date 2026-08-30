import {
  AgentRunSchema,
  DecisionCommandSchema,
  DecisionEventSchema,
  DecisionWorkspaceSchema,
  type AgentRun,
  type DecisionCommand,
  type DecisionCommandResult,
  type DecisionEvent,
  type DecisionWorkspace,
  type DecisionWorkspaceRepository,
} from "@travel/contracts";
import { ForbiddenError, RepositoryUnavailableError } from "./cloudbaseTripRepository";
import { getCloudbaseClient } from "./cloudbaseClient";

type CallFunction = (options: { name: string; data: Record<string, unknown> }) => Promise<{ result?: unknown }>;
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type Options = {
  callFunction?: CallFunction;
  storage?: StorageLike;
  pollIntervalMs?: number;
};

function serviceErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const code = (value as { error?: unknown; code?: unknown }).error ?? (value as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isMembershipError(code: string | undefined) {
  return code === "AUTH_REQUIRED" || code === "MEMBERSHIP_REQUIRED" || code === "FORBIDDEN";
}

class CursorExpiredError extends Error {}

export class CloudBaseDecisionWorkspaceRepository implements DecisionWorkspaceRepository {
  private readonly callFunction: CallFunction;
  private readonly storage?: StorageLike;
  private readonly pollIntervalMs: number;
  private readonly snapshots = new Map<string, DecisionWorkspace>();

  constructor(options: Options = {}) {
    this.callFunction = options.callFunction ?? getCloudbaseClient().callFunction.bind(getCloudbaseClient());
    this.storage = options.storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
  }

  private cacheKey(tripId: string) {
    return `travel-decision-workspace:${tripId}`;
  }

  private cursorNumber(cursor: string): number | undefined {
    if (!/^\d+$/.test(cursor)) return undefined;
    const value = Number(cursor);
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }

  private saveSnapshot(workspace: DecisionWorkspace): DecisionWorkspace {
    const current = this.cachedSnapshot(workspace.tripId);
    const currentCursor = current && this.cursorNumber(current.workspaceCursor);
    const nextCursor = this.cursorNumber(workspace.workspaceCursor);
    if (current && (nextCursor === undefined || (currentCursor !== undefined && nextCursor <= currentCursor))) return current;
    this.snapshots.set(workspace.tripId, workspace);
    this.storage?.setItem(this.cacheKey(workspace.tripId), JSON.stringify(workspace));
    return workspace;
  }

  private cachedSnapshot(tripId: string): DecisionWorkspace | undefined {
    const memory = this.snapshots.get(tripId);
    if (memory) return memory;
    const value = this.storage?.getItem(this.cacheKey(tripId));
    if (!value) return undefined;
    try {
      const parsed = DecisionWorkspaceSchema.safeParse(JSON.parse(value));
      if (!parsed.success || parsed.data.tripId !== tripId || this.cursorNumber(parsed.data.workspaceCursor) === undefined) {
        this.storage?.removeItem(this.cacheKey(tripId));
        return undefined;
      }
      this.snapshots.set(tripId, parsed.data);
      return parsed.data;
    } catch {
      return undefined;
    }
  }

  private clearSnapshot(tripId: string) {
    this.snapshots.delete(tripId);
    this.storage?.removeItem(this.cacheKey(tripId));
  }

  async refresh(tripId: string): Promise<DecisionWorkspace> {
    try {
      const response = await this.callFunction({ name: "trip-api", data: { action: "getDecisionWorkspace", tripId } });
      const code = serviceErrorCode(response.result);
      if (isMembershipError(code)) {
        this.clearSnapshot(tripId);
        throw new ForbiddenError();
      }
      const parsed = DecisionWorkspaceSchema.safeParse(response.result);
      if (!parsed.success || parsed.data.tripId !== tripId || this.cursorNumber(parsed.data.workspaceCursor) === undefined) throw new RepositoryUnavailableError();
      return this.saveSnapshot(parsed.data);
    } catch (error) {
      if (error instanceof ForbiddenError || error instanceof RepositoryUnavailableError) throw error;
      const code = serviceErrorCode(error);
      if (isMembershipError(code)) {
        this.clearSnapshot(tripId);
        throw new ForbiddenError();
      }
      throw new RepositoryUnavailableError();
    }
  }

  async load(tripId: string): Promise<DecisionWorkspace> {
    try {
      return await this.refresh(tripId);
    } catch (error) {
      if (error instanceof ForbiddenError) throw error;
      const cached = this.cachedSnapshot(tripId);
      if (cached) return cached;
      throw new RepositoryUnavailableError();
    }
  }

  async command(input: DecisionCommand): Promise<DecisionCommandResult> {
    const command = DecisionCommandSchema.parse(input);
    try {
      const response = await this.callFunction({ name: "trip-api", data: command });
      const result = response.result;
      const code = serviceErrorCode(result);
      if (isMembershipError(code)) {
        this.clearSnapshot(command.tripId);
        throw new ForbiddenError();
      }
      if (!result || typeof result !== "object" || typeof (result as { ok?: unknown }).ok !== "boolean") throw new RepositoryUnavailableError();
      return result as DecisionCommandResult;
    } catch (error) {
      if (error instanceof ForbiddenError || error instanceof RepositoryUnavailableError) throw error;
      const code = serviceErrorCode(error);
      if (isMembershipError(code)) {
        this.clearSnapshot(command.tripId);
        throw new ForbiddenError();
      }
      throw new RepositoryUnavailableError();
    }
  }

  async getAgentRunStatus(tripId: string, agentRunId: string): Promise<AgentRun> {
    try {
      const response = await this.callFunction({ name: "trip-api", data: { action: "getAgentRunStatus", tripId, agentRunId } });
      const code = serviceErrorCode(response.result);
      if (isMembershipError(code)) {
        this.clearSnapshot(tripId);
        throw new ForbiddenError();
      }
      const parsed = AgentRunSchema.safeParse(response.result);
      if (!parsed.success || parsed.data.tripId !== tripId || parsed.data.agentRunId !== agentRunId) throw new RepositoryUnavailableError();
      return parsed.data;
    } catch (error) {
      if (error instanceof ForbiddenError || error instanceof RepositoryUnavailableError) throw error;
      const code = serviceErrorCode(error);
      if (isMembershipError(code)) {
        this.clearSnapshot(tripId);
        throw new ForbiddenError();
      }
      throw new RepositoryUnavailableError();
    }
  }

  async events(tripId: string, afterCursor: number): Promise<{ events: DecisionEvent[]; cursor: number }> {
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) throw new RepositoryUnavailableError();
    try {
      const response = await this.callFunction({ name: "trip-api", data: { action: "getDecisionEvents", tripId, afterCursor } });
      const code = serviceErrorCode(response.result);
      if (isMembershipError(code)) {
        this.clearSnapshot(tripId);
        throw new ForbiddenError();
      }
      if (code === "CURSOR_EXPIRED") throw new CursorExpiredError();
      if (!response.result || typeof response.result !== "object") throw new RepositoryUnavailableError();
      const value = response.result as { events?: unknown; cursor?: unknown };
      const parsedEvents = DecisionEventSchema.array().safeParse(value.events);
      if (!parsedEvents.success || !Number.isSafeInteger(value.cursor) || (value.cursor as number) < afterCursor) throw new RepositoryUnavailableError();
      return { events: parsedEvents.data, cursor: value.cursor as number };
    } catch (error) {
      if (error instanceof ForbiddenError || error instanceof RepositoryUnavailableError || error instanceof CursorExpiredError) throw error;
      const code = serviceErrorCode(error);
      if (isMembershipError(code)) {
        this.clearSnapshot(tripId);
        throw new ForbiddenError();
      }
      throw new RepositoryUnavailableError();
    }
  }

  subscribe(tripId: string, onChange: (workspace: DecisionWorkspace) => void): () => void {
    let stopped = false;
    let polling = false;
    let cursor = this.cursorNumber(this.cachedSnapshot(tripId)?.workspaceCursor ?? "0") ?? 0;
    const poll = async () => {
      if (stopped || polling) return;
      polling = true;
      try {
        const cachedCursor = this.cursorNumber(this.cachedSnapshot(tripId)?.workspaceCursor ?? "0");
        if (cachedCursor !== undefined && cachedCursor > cursor) cursor = cachedCursor;
        const next = await this.events(tripId, cursor);
        if (stopped) return;
        if (next.events.length > 0) {
          const workspace = await this.refresh(tripId);
          if (stopped) return;
          cursor = this.cursorNumber(workspace.workspaceCursor) ?? cursor;
          onChange(workspace);
        } else {
          cursor = next.cursor;
        }
      } catch (error) {
        if (error instanceof ForbiddenError) {
          stopped = true;
        } else if (error instanceof CursorExpiredError && !stopped) {
          try {
            const workspace = await this.refresh(tripId);
            if (stopped) return;
            cursor = this.cursorNumber(workspace.workspaceCursor) ?? cursor;
            onChange(workspace);
          } catch (refreshError) {
            if (refreshError instanceof ForbiddenError) stopped = true;
          }
        }
      } finally {
        polling = false;
      }
    };
    const timer = window.setInterval(() => { void poll(); }, this.pollIntervalMs);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }
}
