import {
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { Trip, TripRepository } from "@travel/contracts";
import seed from "../../../../content/trip.seed.json";
import { LocalTripRepository } from "../infrastructure/localTripRepository";
import { TripContext, type TripSyncState } from "./tripContext";

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
  const [repository] = useState<TripRepository>(
    () => injectedRepository ?? new LocalTripRepository(seed),
  );
  const [trip, setTrip] = useState<Trip>();
  const [loadError, setLoadError] = useState(false);
  const [syncState, setSyncState] = useState<TripSyncState>("正在使用本地计划");

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;

    void repository
      .load(tripId)
      .then((loadedTrip) => {
        if (!active) return;
        setTrip(loadedTrip);
        unsubscribe = repository.subscribe(tripId, (change) => {
          if (active) setTrip(change.trip);
        });
      })
      .catch(() => {
        if (active) setLoadError(true);
      });

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [repository, tripId]);

  const saveTrip = useCallback(
    async (next: Trip) => {
      setSyncState("正在保存");
      try {
        const saved = await repository.save(next, next.version);
        setTrip(saved);
        setSyncState("正在使用本地计划");
        return saved;
      } catch (error) {
        setSyncState("保存失败，请重试");
        throw error;
      }
    },
    [repository],
  );

  if (loadError) {
    return <p role="alert">旅行计划加载失败，请刷新后重试。</p>;
  }

  if (!trip) {
    return <p role="status">正在加载旅行计划</p>;
  }

  return (
    <TripContext.Provider value={{ trip, saveTrip, syncState }}>
      {children}
    </TripContext.Provider>
  );
}
