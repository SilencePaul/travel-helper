import {
  DecisionCommandSchema,
  DecisionEventSchema,
  DecisionWorkspaceSchema,
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

  private saveSnapshot(workspace: DecisionWorkspace) {
    this.snapshots.set(workspace.tripId, workspace);
    this.storage?.setItem(this.cacheKey(workspace.tripId), JSON.stringify(workspace));
  }

  private cachedSnapshot(tripId: string): DecisionWorkspace | undefined {
    const memory = this.snapshots.get(tripId);
    if (memory) return memory;
    const value = this.storage?.getItem(this.cacheKey(tripId));
    if (!value) return undefined;
    try {
      const parsed = DecisionWorkspaceSchema.safeParse(JSON.parse(value));
      if (!parsed.success) return undefined;
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

  async load(tripId: string): Promise<DecisionWorkspace> {
    try {
      const response = await this.callFunction({ name: "trip-api", data: { action: "getDecisionWorkspace", tripId } });
      const code = serviceErrorCode(response.result);
      if (isMembershipError(code)) {
        this.clearSnapshot(tripId);
        throw new ForbiddenError();
      }
      const parsed = DecisionWorkspaceSchema.safeParse(response.result);
      if (!parsed.success) throw new RepositoryUnavailableError();
      this.saveSnapshot(parsed.data);
      return parsed.data;
    } catch (error) {
      if (error instanceof ForbiddenError) throw error;
      const code = serviceErrorCode(error);
      if (isMembershipError(code)) {
        this.clearSnapshot(tripId);
        throw new ForbiddenError();
      }
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

  async events(tripId: string, afterCursor: number): Promise<{ events: DecisionEvent[]; cursor: number }> {
    try {
      const response = await this.callFunction({ name: "trip-api", data: { action: "getDecisionEvents", tripId, afterCursor } });
      const code = serviceErrorCode(response.result);
      if (isMembershipError(code)) {
        this.clearSnapshot(tripId);
        throw new ForbiddenError();
      }
      if (!response.result || typeof response.result !== "object") throw new RepositoryUnavailableError();
      const value = response.result as { events?: unknown; cursor?: unknown };
      const parsedEvents = DecisionEventSchema.array().safeParse(value.events);
      if (!parsedEvents.success || !Number.isInteger(value.cursor)) throw new RepositoryUnavailableError();
      return { events: parsedEvents.data, cursor: value.cursor as number };
    } catch (error) {
      if (error instanceof ForbiddenError || error instanceof RepositoryUnavailableError) throw error;
      throw new RepositoryUnavailableError();
    }
  }

  subscribe(tripId: string, onChange: (workspace: DecisionWorkspace) => void): () => void {
    let stopped = false;
    let cursor = Number(this.cachedSnapshot(tripId)?.workspaceCursor ?? 0);
    const poll = async () => {
      if (stopped) return;
      try {
        const next = await this.events(tripId, cursor);
        cursor = next.cursor;
        if (next.events.length > 0) onChange(await this.load(tripId));
      } catch (error) {
        if (error instanceof ForbiddenError) stopped = true;
      }
    };
    const timer = window.setInterval(() => { void poll(); }, this.pollIntervalMs);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }
}
