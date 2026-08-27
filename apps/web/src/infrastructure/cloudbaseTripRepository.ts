import { TripSchema, type Trip, type TripChange, type TripConnectionState, type TripRepository } from "@travel/contracts";
import { getCloudbaseClient } from "./cloudbaseClient";

type DatabaseLike = {
  collection: (name: string) => { doc: (id: string) => {
    get: () => Promise<{ data?: unknown[] | unknown }>;
    watch: (options: { onChange: (snapshot: SnapshotLike) => void; onError: (error: unknown) => void }) => { close: () => void };
  } };
};

type FunctionsLike = { callFunction: (options: { name: string; data: Record<string, unknown> }) => Promise<{ result?: unknown }> };
type SnapshotLike = { docs?: unknown[]; docChanges?: Array<{ doc?: unknown; dataType?: string; queueType?: string }>; type?: string };

export class VersionConflictError extends Error {
  readonly code = "VERSION_CONFLICT";
  constructor() { super("旅行计划已被其他成员更新，请刷新后重试"); this.name = "VersionConflictError"; }
}

export class UnauthorizedError extends Error {
  readonly code: string = "UNAUTHORIZED";
  constructor(message = "登录已失效") { super(message); this.name = "UnauthorizedError"; }
}

export class ForbiddenError extends UnauthorizedError {
  readonly code = "FORBIDDEN";
  constructor() { super("无权执行此操作"); this.name = "ForbiddenError"; }
}

export class RepositoryUnavailableError extends Error {
  readonly code = "REPOSITORY_UNAVAILABLE";
  constructor() { super("旅行计划暂时不可用，请稍后重试"); this.name = "RepositoryUnavailableError"; }
}

function first(data: unknown): unknown {
  return Array.isArray(data) ? data[0] : data;
}

function newIdempotencyKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `save-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function parsedTrip(value: unknown): Trip {
  const result = TripSchema.safeParse(value);
  if (!result.success) throw new RepositoryUnavailableError();
  return result.data;
}

function serviceErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const code = (value as { error?: unknown; code?: unknown }).error ?? (value as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isUnauthorizedCode(code: string | undefined) {
  return code === "UNAUTHORIZED"
    || code === "AUTH_REQUIRED"
    || code === "MEMBERSHIP_REQUIRED"
    || code === "FORBIDDEN"
    || code === "ADMIN_REQUIRED"
    || code === "NOT_AUTHORIZED"
    || code === "PENDING_APPROVAL"
    || code === "REMOVED"
    || code === "PERMISSION_DENIED"
    || code === "PERMISSION_DENIED:"
    || code?.startsWith("PERMISSION_DENIED:") === true;
}

function unauthorizedError(code?: string) {
  return code === "FORBIDDEN" || code === "MEMBERSHIP_REQUIRED" || code === "ADMIN_REQUIRED"
    ? new ForbiddenError()
    : new UnauthorizedError();
}

export function isUnauthorizedError(error: unknown): error is UnauthorizedError {
  if (error instanceof UnauthorizedError) return true;
  const code = serviceErrorCode(error);
  return isUnauthorizedCode(code);
}

export type CloudBaseTripRepositoryOptions = {
  app?: { database: () => DatabaseLike; callFunction: FunctionsLike["callFunction"] };
  database?: DatabaseLike;
  functions?: FunctionsLike;
  callFunction?: FunctionsLike["callFunction"];
};

export class CloudBaseTripRepository implements TripRepository {
  readonly syncMode = "cloudbase" as const;
  private readonly database: DatabaseLike;
  private readonly functions: FunctionsLike;
  private readonly versions = new Map<string, number>();

  constructor(options: CloudBaseTripRepositoryOptions = {}) {
    const app = options.app ?? (!options.database || !options.functions ? getCloudbaseClient() : undefined);
    this.database = options.database ?? app!.database();
    this.functions = options.functions ?? (options.callFunction ? { callFunction: options.callFunction } : app!);
  }

  async load(tripId: string): Promise<Trip> {
    try {
      const result = await this.database.collection("trips").doc(tripId).get();
      const trip = first(result.data);
      if (!trip) throw new RepositoryUnavailableError();
      const parsed = parsedTrip(trip);
      this.versions.set(tripId, Math.max(this.versions.get(tripId) ?? -1, parsed.version));
      return parsed;
    } catch (error) {
      if (error instanceof RepositoryUnavailableError) throw error;
      const code = serviceErrorCode(error);
      if (isUnauthorizedCode(code)) throw unauthorizedError(code);
      throw new RepositoryUnavailableError();
    }
  }

  async save(next: Trip, expectedVersion: number): Promise<Trip> {
    return this.saveWithIdempotency(next, expectedVersion, newIdempotencyKey());
  }

  async saveWithIdempotency(next: Trip, expectedVersion: number, idempotencyKey: string): Promise<Trip> {
    try {
      const response = await this.functions.callFunction({
        name: "trip-api",
        data: { action: "saveTrip", tripId: next.id, trip: next, expectedVersion, idempotencyKey },
      });
      const result = response?.result;
      const code = serviceErrorCode(result);
      if (code === "VERSION_CONFLICT") throw new VersionConflictError();
      if (isUnauthorizedCode(code)) throw unauthorizedError(code);
      if (!result || typeof result !== "object" || !("trip" in result)) throw new RepositoryUnavailableError();
      const saved = parsedTrip((result as { trip: unknown }).trip);
      this.versions.set(next.id, Math.max(this.versions.get(next.id) ?? -1, saved.version));
      return saved;
    } catch (error) {
      if (error instanceof VersionConflictError || error instanceof ForbiddenError || error instanceof RepositoryUnavailableError) throw error;
      const code = serviceErrorCode(error);
      if (code === "VERSION_CONFLICT") throw new VersionConflictError();
      if (isUnauthorizedCode(code)) throw unauthorizedError(code);
      throw new RepositoryUnavailableError();
    }
  }

  subscribe(tripId: string, onChange: (change: TripChange) => void, onConnectionState?: (state: TripConnectionState) => void, onUnauthorized?: (error: unknown) => void): () => void {
    let listener: { close: () => void } | undefined;
    let unauthorized = false;
    try {
      listener = this.database.collection("trips").doc(tripId).watch({
        onChange: (snapshot) => {
          const event = snapshot.docChanges?.[0];
          if (event?.dataType === "remove" || event?.queueType === "dequeue") return;
          const docs = snapshot.docs ?? [];
          const candidate = first(docs) ?? event?.doc;
          if (!candidate || typeof candidate !== "object") return;
          let trip: Trip;
          try { trip = parsedTrip(candidate); } catch { onConnectionState?.("reconnecting"); return; }
          const currentVersion = this.versions.get(tripId) ?? -1;
          if (trip.version <= currentVersion) return;
          this.versions.set(tripId, trip.version);
          const record = candidate as { updatedByName?: unknown; actorName?: unknown; changedAt?: unknown; updatedAt?: unknown };
          onChange({ trip, actorName: typeof record.updatedByName === "string" ? record.updatedByName : typeof record.actorName === "string" ? record.actorName : "协作者", changedAt: typeof record.changedAt === "string" ? record.changedAt : typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString() });
          onConnectionState?.("synced");
        },
        onError: (error) => {
          const code = serviceErrorCode(error);
          if (isUnauthorizedCode(code)) {
            if (!unauthorized) {
              unauthorized = true;
              onUnauthorized?.(unauthorizedError(code));
            }
            return;
          }
          onConnectionState?.("reconnecting");
        },
      });
    } catch (error) {
      const code = serviceErrorCode(error);
      if (isUnauthorizedCode(code)) onUnauthorized?.(unauthorizedError(code));
      else onConnectionState?.("reconnecting");
    }
    return () => { listener?.close(); };
  }
}
