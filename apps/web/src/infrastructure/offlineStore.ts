import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { TripSchema, type Trip } from "@travel/contracts";

const DATABASE_NAME = "travel-planner-offline";
const DATABASE_VERSION = 2;

interface OfflineDatabase extends DBSchema {
  tripSnapshots: {
    key: string;
    value: Trip;
  };
  pendingCommands: {
    key: string;
    value: unknown;
  };
  quarantinedCommands: {
    key: string;
    value: unknown;
  };
}

let databasePromise: Promise<IDBPDatabase<OfflineDatabase>> | undefined;

export function openOfflineDatabase() {
  databasePromise ??= openDB<OfflineDatabase>(DATABASE_NAME, DATABASE_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains("tripSnapshots")) {
        database.createObjectStore("tripSnapshots");
      }
      if (!database.objectStoreNames.contains("pendingCommands")) {
        database.createObjectStore("pendingCommands");
      }
      if (!database.objectStoreNames.contains("quarantinedCommands")) {
        database.createObjectStore("quarantinedCommands");
      }
    },
  });
  return databasePromise;
}

function snapshotKey(actorUid: string, tripId: string) {
  if (actorUid.length < 4 || actorUid.length > 64) throw new TypeError("Invalid snapshot actor");
  return `${actorUid}:${tripId}`;
}

export async function saveTripSnapshot(actorUid: string, value: unknown): Promise<Trip> {
  const trip = TripSchema.parse(value);
  const database = await openOfflineDatabase();
  await database.put("tripSnapshots", structuredClone(trip), snapshotKey(actorUid, trip.id));
  return structuredClone(trip);
}

export async function getTripSnapshot(actorUid: string, tripId: string): Promise<Trip | undefined> {
  const database = await openOfflineDatabase();
  const key = snapshotKey(actorUid, tripId);
  const value = await database.get("tripSnapshots", key);
  if (value === undefined) return undefined;

  const result = TripSchema.safeParse(value);
  if (!result.success) {
    await database.delete("tripSnapshots", key);
    return undefined;
  }
  return structuredClone(result.data);
}

export async function deleteTripSnapshot(actorUid: string, tripId: string): Promise<void> {
  const database = await openOfflineDatabase();
  await database.delete("tripSnapshots", snapshotKey(actorUid, tripId));
}

export async function getUnassignedOfflineRecordCount(): Promise<number> {
  const database = await openOfflineDatabase();
  const [quarantinedKeys, snapshotKeys] = await Promise.all([
    database.getAllKeys("quarantinedCommands"),
    database.getAllKeys("tripSnapshots"),
  ]);
  const legacySnapshots = snapshotKeys.filter((key) => typeof key === "string" && !key.includes(":"));
  return quarantinedKeys.length + legacySnapshots.length;
}

export async function clearOfflineData(): Promise<void> {
  const database = await openOfflineDatabase();
  const transaction = database.transaction(["tripSnapshots", "pendingCommands", "quarantinedCommands"], "readwrite");
  await Promise.all([
    transaction.objectStore("tripSnapshots").clear(),
    transaction.objectStore("pendingCommands").clear(),
    transaction.objectStore("quarantinedCommands").clear(),
  ]);
  await transaction.done;
}

export { DATABASE_NAME as OFFLINE_DATABASE_NAME };
