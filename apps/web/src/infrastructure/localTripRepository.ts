import {
  TripSchema,
  type Trip,
  type TripChange,
  type TripRepository,
} from "@travel/contracts";

export class LocalTripRepository implements TripRepository {
  readonly syncMode = "local" as const;
  private trip: Trip;
  private readonly listeners = new Set<(change: TripChange) => void>();
  private readonly pendingNotifications: Array<{
    change: TripChange;
    listeners: Array<(change: TripChange) => void>;
  }> = [];
  private isNotifying = false;

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
    const committed = structuredClone(saved);
    this.trip = committed;

    this.pendingNotifications.push({
      change: {
        trip: structuredClone(committed),
        actorName: "本地用户",
        changedAt: new Date().toISOString(),
      },
      listeners: [...this.listeners],
    });
    this.notifyPendingChanges();

    return structuredClone(committed);
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

  private notifyPendingChanges(): void {
    if (this.isNotifying) {
      return;
    }

    this.isNotifying = true;
    try {
      while (this.pendingNotifications.length > 0) {
        const notification = this.pendingNotifications.shift()!;
        for (const onChange of notification.listeners) {
          try {
            onChange({
              ...notification.change,
              trip: structuredClone(notification.change.trip),
            });
          } catch (error) {
            console.error("Local trip repository listener failed", error);
          }
        }
      }
    } finally {
      this.isNotifying = false;
    }
  }
}
