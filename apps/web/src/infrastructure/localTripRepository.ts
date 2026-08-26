import {
  TripSchema,
  type Trip,
  type TripChange,
  type TripRepository,
} from "@travel/contracts";

export class LocalTripRepository implements TripRepository {
  private trip: Trip;
  private readonly listeners = new Set<(change: TripChange) => void>();

  constructor(seed: unknown) {
    this.trip = structuredClone(TripSchema.parse(seed));
  }

  async load(tripId: string): Promise<Trip> {
    this.assertTripId(tripId);
    return structuredClone(this.trip);
  }

  async save(next: Trip, expectedVersion: number): Promise<Trip> {
    this.assertTripId(next.id);

    if (expectedVersion !== this.trip.version) {
      throw new Error("VERSION_CONFLICT");
    }

    const saved = TripSchema.parse({ ...next, version: expectedVersion + 1 });
    this.trip = structuredClone(saved);

    const changedAt = new Date().toISOString();
    const listeners = [...this.listeners];
    for (const onChange of listeners) {
      onChange({
        trip: structuredClone(this.trip),
        actorName: "本地用户",
        changedAt,
      });
    }

    return structuredClone(this.trip);
  }

  subscribe(tripId: string, onChange: (change: TripChange) => void): () => void {
    this.assertTripId(tripId);
    this.listeners.add(onChange);

    return () => {
      this.listeners.delete(onChange);
    };
  }

  private assertTripId(tripId: string): void {
    if (tripId !== this.trip.id) {
      throw new Error("TRIP_NOT_FOUND");
    }
  }
}
