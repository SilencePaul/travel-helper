import { createHash } from "node:crypto";

function one(result) {
  return Array.isArray(result?.data) ? result.data[0] : result?.data;
}

function codeHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function seedCloudBase({ db, trip, bootstrapCode }) {
  if (!db || typeof db.runTransaction !== "function") throw new Error("CLOUDBASE_TRANSACTION_UNAVAILABLE");
  if (!trip?.id || !bootstrapCode) throw new Error("INVALID_SEED_INPUT");
  return db.runTransaction(async (transaction) => {
    const trips = transaction.collection("trips");
    const indexes = transaction.collection("membership_index");
    const bootstrap = transaction.collection("auth_bootstrap");
    const currentTrip = one(await trips.doc(trip.id).get());
    if (!currentTrip) await trips.doc(trip.id).set({ ...trip, memberUids: [] });
    if (!one(await indexes.doc("admins").get())) await indexes.doc("admins").set({ adminUids: [] });
    if (!one(await indexes.doc("members").get())) await indexes.doc("members").set({ memberUids: [] });
    if (!one(await bootstrap.doc("singleton").get())) await bootstrap.doc("singleton").set({ codeHash: codeHash(bootstrapCode), consumed: false, adminUids: [] });
  });
}
