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
import { CloudBaseTripRepository } from "../infrastructure/cloudbaseTripRepository";
import {
  TripContext,
  type TripMutation,
  type TripSyncState,
} from "./tripContext";

type TripProviderProps = {
  children: ReactNode;
  repository?: TripRepository;
  tripId?: string;
};

export function TripProvider({
  children,
  repository: injectedRepository,
  tripId = seed.id,
}: TripProviderProps) {
  const [defaultRepository] = useState<TripRepository>(() => injectedRepository ?? (import.meta.env.VITE_DATA_MODE === "cloudbase" ? new CloudBaseTripRepository() : new LocalTripRepository(seed)));
  const repository = injectedRepository ?? defaultRepository;
  const isCloudbase = repository.syncMode === "cloudbase";
  const [trip, setTrip] = useState<Trip>();
  const [loadError, setLoadError] = useState(false);
  const [syncState, setSyncState] = useState<TripSyncState>(isCloudbase ? "已同步" : "正在使用本地计划");
  const tripRef = useRef<Trip | undefined>(undefined);
  const sessionRef = useRef(0);
  const mutationQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const savingRef = useRef(false);
  const connectionRef = useRef<"synced" | "reconnecting">("synced");

  const applySnapshot = useCallback((snapshot: Trip, session: number) => {
    if (session !== sessionRef.current) return false;
    if (tripRef.current && snapshot.version <= tripRef.current.version) return false;

    const next = structuredClone(snapshot);
    tripRef.current = next;
    setTrip(next);
    return true;
  }, []);

  useEffect(() => {
    const session = sessionRef.current + 1;
    sessionRef.current = session;
    tripRef.current = undefined;
    mutationQueueRef.current = Promise.resolve();
    savingRef.current = false;
    connectionRef.current = "synced";
    /* oxlint-disable react/set-state-in-effect -- a repository identity change starts a new async session */
    setTrip(undefined);
    setLoadError(false);
    setSyncState(isCloudbase ? "已同步" : "正在使用本地计划");
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
      });
    } catch {
      setLoadError(true);
    }

    void repository
      .load(tripId)
      .then((loadedTrip) => {
        if (active) {
          applySnapshot(loadedTrip, session);
          if (isCloudbase && !savingRef.current && connectionRef.current === "synced") setSyncState("已同步");
        }
      })
      .catch(() => {
        if (active && session === sessionRef.current && !tripRef.current) {
          setLoadError(true);
        }
      });

    return () => {
      active = false;
      if (sessionRef.current === session) sessionRef.current += 1;
      unsubscribe?.();
    };
  }, [applySnapshot, isCloudbase, repository, tripId]);

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
        const saved = await repository.save(next, current.version);
        if (requestedSession !== sessionRef.current) return undefined;
        applySnapshot(saved, requestedSession);
        savingRef.current = false;
        setSyncState(isCloudbase ? "已同步" : "正在使用本地计划");
        return saved;
      } catch {
        savingRef.current = false;
        if (requestedSession === sessionRef.current) {
          setSyncState("保存失败，请重试");
        }
        return undefined;
      }
    });

    mutationQueueRef.current = task.then(() => undefined, () => undefined);
    return task;
  }, [applySnapshot, isCloudbase, repository]);

  const saveTrip = useCallback(async (next: Trip) => {
    const saved = await mutateTrip(() => next);
    if (!saved) throw new Error("SAVE_FAILED");
    return saved;
  }, [mutateTrip]);

  if (loadError) {
    return <p role="alert">旅行计划加载失败，请刷新后重试。</p>;
  }

  if (!trip) {
    return <p role="status">正在加载旅行计划</p>;
  }

  return (
    <TripContext.Provider value={{ trip, saveTrip, mutateTrip, syncState }}>
      {children}
    </TripContext.Provider>
  );
}
