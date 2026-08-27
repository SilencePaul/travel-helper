import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { TripSchema, type Trip } from "@travel/contracts";

const DATABASE_NAME = "travel-planner-offline";
const DATABASE_VERSION = 1;

interface OfflineDatabase extends DBSchema {
  tripSnapshots: {
    key: string;
    value: Trip;
  };
  pendingCommands: {
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
    },
  });
  return databasePromise;
}

export async function saveTripSnapshot(value: unknown): Promise<Trip> {
  const trip = TripSchema.parse(value);
  const database = await openOfflineDatabase();
  await database.put("tripSnapshots", structuredClone(trip), trip.id);
  return structuredClone(trip);
}

export async function getTripSnapshot(tripId: string): Promise<Trip | undefined> {
  const database = await openOfflineDatabase();
  const value = await database.get("tripSnapshots", tripId);
  if (value === undefined) return undefined;

  const result = TripSchema.safeParse(value);
  if (!result.success) {
    await database.delete("tripSnapshots", tripId);
    return undefined;
  }
  return structuredClone(result.data);
}

export async function deleteTripSnapshot(tripId: string): Promise<void> {
  const database = await openOfflineDatabase();
  await database.delete("tripSnapshots", tripId);
}

export async function clearOfflineData(): Promise<void> {
  const database = await openOfflineDatabase();
  const transaction = database.transaction(["tripSnapshots", "pendingCommands"], "readwrite");
  await Promise.all([
    transaction.objectStore("tripSnapshots").clear(),
    transaction.objectStore("pendingCommands").clear(),
  ]);
  await transaction.done;
}

export { DATABASE_NAME as OFFLINE_DATABASE_NAME };
