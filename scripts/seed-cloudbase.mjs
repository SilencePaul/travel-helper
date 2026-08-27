import { createRequire } from "node:module";
import seed from "../content/trip.seed.json" with { type: "json" };
import { seedCloudBase } from "./cloudbaseSeed.mjs";

const required = ["VITE_CLOUDBASE_ENV_ID", "TENCENTCLOUD_SECRET_ID", "TENCENTCLOUD_SECRET_KEY", "ADMIN_BOOTSTRAP_CODE"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  process.stderr.write(`MISSING ${missing.join(" ")}\n`);
  process.exitCode = 1;
} else {
  const require = createRequire(new URL("../functions/auth-service/package.json", import.meta.url));
  const { init } = require("@cloudbase/node-sdk");
  const cloudbase = init({ env: process.env.VITE_CLOUDBASE_ENV_ID, secretId: process.env.TENCENTCLOUD_SECRET_ID, secretKey: process.env.TENCENTCLOUD_SECRET_KEY });
  const db = cloudbase.database();
  for (const name of ["trips", "membership_index", "auth_bootstrap", "auth_oauth_states", "auth_sessions", "members", "trip_audits", "trip_idempotency"]) {
    try { await db.createCollection(name); } catch (error) {
      if (error?.code !== "DATABASE_COLLECTION_ALREADY_EXIST") throw error;
    }
  }
  await seedCloudBase({ db, trip: seed, bootstrapCode: process.env.ADMIN_BOOTSTRAP_CODE });
  process.stdout.write(`SEEDED ${seed.id}\n`);
}
