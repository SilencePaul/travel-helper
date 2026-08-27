import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Trip, TripRepository } from "@travel/contracts";
import seed from "../../../../content/trip.seed.json";
import { LocalTripRepository } from "../infrastructure/localTripRepository";
import { CloudBaseTripRepository, isUnauthorizedError } from "../infrastructure/cloudbaseTripRepository";
import { enqueuePendingCommand, listPendingCommands, replayPendingCommands } from "../infrastructure/offlineQueue";
import { getTripSnapshot, saveTripSnapshot } from "../infrastructure/offlineStore";
import {
  TripContext,
  type TripMutation,
  type TripSyncState,
} from "./tripContext";

type TripProviderProps = {
  children: ReactNode;
  repository?: TripRepository;
  tripId?: string;
  onUnauthorized?: (error: unknown) => void;
};

function newIdempotencyKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `offline-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function TripProvider({
  children,
  repository: injectedRepository,
  tripId = seed.id,
  onUnauthorized,
}: TripProviderProps) {
  const [defaultRepository] = useState<TripRepository>(() => injectedRepository ?? (import.meta.env.VITE_DATA_MODE === "cloudbase" ? new CloudBaseTripRepository() : new LocalTripRepository(seed)));
  const repository = injectedRepository ?? defaultRepository;
  const isCloudbase = repository.syncMode === "cloudbase";
  const [trip, setTrip] = useState<Trip>();
  const [loadError, setLoadError] = useState(false);
  const [authLost, setAuthLost] = useState(false);
  const [syncState, setSyncState] = useState<TripSyncState>(isCloudbase ? "已同步" : "正在使用本地计划");
  const [pendingCommandCount, setPendingCommandCount] = useState(0);
  const [conflictPaused, setConflictPaused] = useState(false);
  const [loadedSession, setLoadedSession] = useState<number>();
  const tripRef = useRef<Trip | undefined>(undefined);
  const sessionRef = useRef(0);
  const mutationQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const savingRef = useRef(false);
  const connectionRef = useRef<"synced" | "reconnecting">("synced");
  const invalidatedRef = useRef(false);
  const replayingRef = useRef<{ session: number; promise: Promise<void> } | undefined>(undefined);

  const isOnline = () => typeof navigator === "undefined" || navigator.onLine;

  const refreshPendingCount = useCallback(async (session?: number) => {
    try {
      const commands = await listPendingCommands(tripId);
      if (session === undefined || session === sessionRef.current) setPendingCommandCount(commands.length);
    } catch {
      if (session === undefined || session === sessionRef.current) setPendingCommandCount(0);
    }
  }, [tripId]);

  const invalidateSession = useCallback((error: unknown) => {
    if (invalidatedRef.current) return;
    invalidatedRef.current = true;
    sessionRef.current += 1;
    tripRef.current = undefined;
    mutationQueueRef.current = Promise.resolve();
    savingRef.current = false;
    /* oxlint-disable react/set-state-in-effect -- authorization loss invalidates the active data session */
    setTrip(undefined);
    setLoadError(false);
    setAuthLost(true);
    setSyncState(isCloudbase ? "已同步" : "正在使用本地计划");
    setPendingCommandCount(0);
    setConflictPaused(false);
    /* oxlint-enable react/set-state-in-effect */
    onUnauthorized?.(error);
  }, [isCloudbase, onUnauthorized]);

  const applySnapshot = useCallback((snapshot: Trip, session: number) => {
    if (session !== sessionRef.current) return false;
    if (tripRef.current && snapshot.version <= tripRef.current.version) return false;

    const next = structuredClone(snapshot);
    tripRef.current = next;
    setTrip(next);
    void saveTripSnapshot(next).catch(() => undefined);
    return true;
  }, []);

  useEffect(() => {
    const session = sessionRef.current + 1;
    sessionRef.current = session;
    invalidatedRef.current = false;
    tripRef.current = undefined;
    mutationQueueRef.current = Promise.resolve();
    savingRef.current = false;
    connectionRef.current = "synced";
    /* oxlint-disable react/set-state-in-effect -- a repository identity change starts a new async session */
    setTrip(undefined);
    setLoadError(false);
    setAuthLost(false);
    setSyncState(isCloudbase ? "已同步" : "正在使用本地计划");
    setLoadedSession(undefined);
    if (!isOnline()) void refreshPendingCount(session);
    /* oxlint-enable react/set-state-in-effect */
    let active = true;
    let unsubscribe: (() => void) | undefined;

    try {
      unsubscribe = repository.subscribe(tripId, (change) => {
        if (!active) return;
        setLoadError(false);
        if (applySnapshot(change.trip, session) && !savingRef.current && isCloudbase) setSyncState("已同步");
      }, (state) => {
        if (!active || !isCloudbase) return;
        connectionRef.current = state;
        if (state === "reconnecting") setSyncState("正在重连");
        else if (!savingRef.current) setSyncState("已同步");
      }, (error) => {
        if (active && isUnauthorizedError(error)) invalidateSession(error);
      });
    } catch (error) {
      if (active && isUnauthorizedError(error)) invalidateSession(error);
      else if (active) setLoadError(true);
    }

    void repository
      .load(tripId)
      .then((loadedTrip) => {
        if (active) {
          applySnapshot(loadedTrip, session);
          setLoadedSession(session);
          if (isCloudbase && !savingRef.current && connectionRef.current === "synced") setSyncState("已同步");
        }
      })
      .catch((error) => {
        if (active && session === sessionRef.current && !tripRef.current) {
          if (isUnauthorizedError(error)) {
            invalidateSession(error);
            return;
          }
          if (isOnline()) {
            setLoadError(true);
            return;
          }
          void getTripSnapshot(tripId).then((cachedTrip) => {
            if (!active || session !== sessionRef.current) return;
            if (cachedTrip) {
              applySnapshot(cachedTrip, session);
              setSyncState("离线");
            } else {
              setLoadError(true);
            }
          }).catch(() => setLoadError(true));
        }
      });

    return () => {
      active = false;
      if (sessionRef.current === session) sessionRef.current += 1;
      unsubscribe?.();
    };
  }, [applySnapshot, invalidateSession, isCloudbase, refreshPendingCount, repository, tripId]);

  const replayQueuedCommands = useCallback(() => {
    const session = sessionRef.current;
    if (!isOnline() || invalidatedRef.current || !tripRef.current) return Promise.resolve();
    const existing = replayingRef.current;
    if (existing?.session === session) return existing.promise;

    const run = async () => {
      try {
        const result = await replayPendingCommands(async (command) => {
          if (session !== sessionRef.current || invalidatedRef.current) throw new Error("STALE_SESSION");
          const saved = "saveWithIdempotency" in repository && typeof repository.saveWithIdempotency === "function"
            ? await repository.saveWithIdempotency(command.patch, command.expectedVersion, command.idempotencyKey)
            : await repository.save(command.patch, command.expectedVersion);
          if (session === sessionRef.current && !invalidatedRef.current) applySnapshot(saved, session);
          return saved;
        }, tripId);
        if (session !== sessionRef.current || invalidatedRef.current) return;
        await refreshPendingCount(session);
        if (session !== sessionRef.current || invalidatedRef.current) return;
        setConflictPaused(result.status === "paused-conflict");
        if (result.status === "paused-conflict") setSyncState("同步冲突，等待处理");
        else if (result.status === "completed" && !savingRef.current) setSyncState(isCloudbase ? "已同步" : "正在使用本地计划");
      } catch {
        if (session === sessionRef.current && !invalidatedRef.current) await refreshPendingCount(session);
      }
    };
    const promise = run();
    replayingRef.current = { session, promise };
    void promise.finally(() => {
      if (replayingRef.current?.promise === promise) replayingRef.current = undefined;
    });
    return promise;
  }, [applySnapshot, isCloudbase, refreshPendingCount, repository, tripId]);

  useEffect(() => {
    if (loadedSession !== sessionRef.current || !tripRef.current || !isOnline()) return;
    void replayQueuedCommands();
  }, [loadedSession, replayQueuedCommands]);

  useEffect(() => {
    const handleOnline = () => { void replayQueuedCommands(); };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [replayQueuedCommands]);

  const mutateTrip = useCallback((mutation: TripMutation) => {
    const requestedSession = sessionRef.current;
    const task = mutationQueueRef.current.then(async () => {
      if (requestedSession !== sessionRef.current) return undefined;
      const current = tripRef.current;
      if (!current) return undefined;

      savingRef.current = true;
      setSyncState("正在保存");
      try {
        const next = mutation(structuredClone(current));
        if (!next) {
          savingRef.current = false;
          setSyncState(isCloudbase ? "已同步" : "正在使用本地计划");
          return current;
        }
        if (!isOnline()) {
          const optimistic = { ...next, version: current.version + 1 };
          await enqueuePendingCommand({
            tripId: optimistic.id,
            expectedVersion: current.version,
            patch: optimistic,
            createdAt: new Date().toISOString(),
            idempotencyKey: newIdempotencyKey(),
          });
          applySnapshot(optimistic, requestedSession);
          await refreshPendingCount(requestedSession);
          setConflictPaused(false);
          savingRef.current = false;
          setSyncState("离线");
          return optimistic;
        }
        const saved = await repository.save(next, current.version);
        if (requestedSession !== sessionRef.current) return undefined;
        applySnapshot(saved, requestedSession);
        savingRef.current = false;
        setSyncState(isCloudbase ? "已同步" : "正在使用本地计划");
        return saved;
      } catch (error) {
        savingRef.current = false;
        if (isUnauthorizedError(error)) {
          if (requestedSession === sessionRef.current) invalidateSession(error);
          return undefined;
        }
        if (requestedSession === sessionRef.current) {
          setSyncState("保存失败，请重试");
        }
        return undefined;
      }
    });

    mutationQueueRef.current = task.then(() => undefined, () => undefined);
    return task;
  }, [applySnapshot, invalidateSession, isCloudbase, refreshPendingCount, repository]);

  const saveTrip = useCallback(async (next: Trip) => {
    const saved = await mutateTrip(() => next);
    if (!saved) throw new Error("SAVE_FAILED");
    return saved;
  }, [mutateTrip]);

  if (loadError) {
    return <p role="alert">旅行计划加载失败，请刷新后重试。</p>;
  }

  if (authLost) {
    return <p role="alert">登录状态已失效，请重新登录。</p>;
  }

  if (!trip) {
    return <p role="status">正在加载旅行计划</p>;
  }

  return (
    <TripContext.Provider value={{ trip, saveTrip, mutateTrip, syncState, pendingCommandCount, conflictPaused }}>
      {children}
    </TripContext.Provider>
  );
}
