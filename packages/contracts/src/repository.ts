import type { Trip } from "./trip";

export type TripChange = { trip: Trip; actorName: string; changedAt: string };
export type TripConnectionState = "synced" | "reconnecting";
export type TripUnauthorizedHandler = (error: unknown) => void;

export interface TripRepository {
  readonly syncMode?: "local" | "cloudbase";
  load(tripId: string): Promise<Trip>;
  save(next: Trip, expectedVersion: number): Promise<Trip>;
  subscribe(tripId: string, onChange: (change: TripChange) => void, onConnectionState?: (state: TripConnectionState) => void, onUnauthorized?: TripUnauthorizedHandler): () => void;
}
