import type { Trip } from "./trip";

export type TripChange = { trip: Trip; actorName: string; changedAt: string };

export interface TripRepository {
  load(tripId: string): Promise<Trip>;
  save(next: Trip, expectedVersion: number): Promise<Trip>;
  subscribe(tripId: string, onChange: (change: TripChange) => void): () => void;
}
