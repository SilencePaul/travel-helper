import { pathToFileURL } from "node:url";
import { createPrivateKey } from "node:crypto";

export const requiredNames = [
  "VITE_DATA_MODE",
  "VITE_CLOUDBASE_ENV_ID",
  "VITE_AUTH_SERVICE_URL",
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_REDIRECT_URI",
  "ADMIN_BOOTSTRAP_CODE",
  "CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS_BASE64",
  "TENCENTCLOUD_SECRET_ID",
  "TENCENTCLOUD_SECRET_KEY",
  "PUBLIC_APP_URL",
];

function validCustomLoginCredentials(encoded, expectedEnvId) {
  try {
    const normalized = encoded.trim();
    const bytes = Buffer.from(normalized, "base64");
    if (!bytes.length || bytes.toString("base64") !== normalized) return false;
    const credentials = JSON.parse(bytes.toString("utf8"));
    const structurallyValid = credentials && typeof credentials === "object" && !Array.isArray(credentials)
      && credentials.env_id === expectedEnvId?.trim()
      && typeof credentials.private_key_id === "string" && credentials.private_key_id.length > 0
      && typeof credentials.private_key === "string" && credentials.private_key.length > 0;
    if (!structurallyValid) return false;
    createPrivateKey(credentials.private_key);
    return true;
  } catch {
    return false;
  }
}

function parsedHttpsUrl(value) {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash ? url : undefined;
  } catch {
    return undefined;
  }
}

export function validateProductionConfig(environment) {
  const missing = requiredNames.filter((name) => !environment[name]?.trim());
  const invalid = [];
  if (environment.VITE_DATA_MODE?.trim() && environment.VITE_DATA_MODE.trim() !== "cloudbase") invalid.push("VITE_DATA_MODE");
  if (environment.CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS_BASE64?.trim()
    && !validCustomLoginCredentials(environment.CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS_BASE64, environment.VITE_CLOUDBASE_ENV_ID)) {
    invalid.push("CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS_BASE64");
  }
  const authUrl = environment.VITE_AUTH_SERVICE_URL?.trim() ? parsedHttpsUrl(environment.VITE_AUTH_SERVICE_URL) : undefined;
  if (environment.VITE_AUTH_SERVICE_URL?.trim()
    && (!authUrl || !["/", "/api/auth"].includes(authUrl.pathname.replace(/\/$/, "") || "/"))) invalid.push("VITE_AUTH_SERVICE_URL");
  if (environment.FEISHU_REDIRECT_URI?.trim()) {
    const expectedCallback = authUrl ? `${authUrl.origin}/api/auth/callback` : undefined;
    const redirect = parsedHttpsUrl(environment.FEISHU_REDIRECT_URI);
    if (!redirect || !expectedCallback || redirect.toString().replace(/\/$/, "") !== expectedCallback) invalid.push("FEISHU_REDIRECT_URI");
  }
  if (environment.PUBLIC_APP_URL?.trim()) {
    const publicUrl = parsedHttpsUrl(environment.PUBLIC_APP_URL);
    if (!publicUrl || publicUrl.origin !== environment.PUBLIC_APP_URL.trim()) invalid.push("PUBLIC_APP_URL");
  }
  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { ok, missing, invalid } = validateProductionConfig(process.env);
  process.stdout.write(ok ? "PASS\n" : missing.length ? `MISSING ${missing.join(" ")}\n` : `INVALID ${invalid.join(" ")}\n`);
  process.exitCode = ok ? 0 : 1;
}
