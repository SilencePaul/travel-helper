import { readFile } from "node:fs/promises";
import CloudBase from "@cloudbase/manager-node";
import { collectionRules } from "./cloudbaseSecurity.mjs";

const required = ["VITE_CLOUDBASE_ENV_ID", "TENCENTCLOUD_SECRET_ID", "TENCENTCLOUD_SECRET_KEY"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  process.stderr.write(`MISSING ${missing.join(" ")}\n`);
  process.exitCode = 1;
} else {
  const tripRule = JSON.parse(await readFile(new URL("../cloudbase/database.rules.json", import.meta.url), "utf8"));
  const manager = CloudBase.init({ envId: process.env.VITE_CLOUDBASE_ENV_ID, secretId: process.env.TENCENTCLOUD_SECRET_ID, secretKey: process.env.TENCENTCLOUD_SECRET_KEY });
  for (const { name, rule } of collectionRules(tripRule)) {
    await manager.commonService().call({ Action: "ModifySafeRule", Param: { EnvId: process.env.VITE_CLOUDBASE_ENV_ID, CollectionName: name, AclTag: "CUSTOM", Rule: JSON.stringify(rule) } });
  }
  process.stdout.write("CLOUDBASE_SECURITY=APPLIED\n");
}
