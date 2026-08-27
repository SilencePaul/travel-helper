import { pathToFileURL } from "node:url";

export const requiredNames = [
  "VITE_CLOUDBASE_ENV_ID",
  "VITE_AUTH_SERVICE_URL",
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_REDIRECT_URI",
  "ADMIN_BOOTSTRAP_CODE",
  "AUTH_SESSION_SECRET",
  "TENCENTCLOUD_SECRET_ID",
  "TENCENTCLOUD_SECRET_KEY",
  "PUBLIC_APP_URL",
];

export function validateProductionConfig(environment) {
  const missing = requiredNames.filter((name) => !environment[name]?.trim());
  return { ok: missing.length === 0, missing };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { ok, missing } = validateProductionConfig(process.env);
  process.stdout.write(ok ? "PASS\n" : `MISSING ${missing.join(" ")}\n`);
  process.exitCode = ok ? 0 : 1;
}
