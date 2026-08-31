import { accessSync, constants } from "node:fs";
import { isAbsolute, normalize, relative, sep } from "node:path";

export const CODEX_ISOLATION_ERROR = "CODEX_ISOLATION_UNAVAILABLE";

const DEFAULT_CODEX_CANDIDATES = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
];

const PERMISSION_OVERRIDES = [
  'permissions.travel_research.filesystem={":minimal"="read",":workspace_roots"="read"}',
  "permissions.travel_research.network.enabled=true",
  'default_permissions="travel_research"',
];

const ALLOWED_ENVIRONMENT_KEYS = new Set([
  "PATH",
  "HOME",
  "CODEX_HOME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

const REQUIRED_PROBE_CHECKS = [
  "isolatedDirectoryReadable",
  "outsideDirectoryUnreadable",
  "projectDirectoryUnreadable",
  "httpsNetworkAvailable",
  "authenticationAvailable",
  "persistenceAvailable",
];

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

function executable(candidate) {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function normalizedAbsolutePath(value) {
  return typeof value === "string" && isAbsolute(value) && normalize(value) === value;
}

function containsPath(parent, child) {
  const pathFromParent = relative(parent, child);
  return pathFromParent === "" || (!isAbsolute(pathFromParent) && pathFromParent !== ".." && !pathFromParent.startsWith(`..${sep}`));
}

export function discoverCodexExecutable(options = {}) {
  const candidates = options.candidates ?? DEFAULT_CODEX_CANDIDATES;
  const isExecutable = options.isExecutable ?? executable;
  if (!Array.isArray(candidates) || typeof isExecutable !== "function") throw codedError("CODEX_NOT_AVAILABLE");
  for (const candidate of candidates) {
    if (!normalizedAbsolutePath(candidate)) continue;
    try {
      if (isExecutable(candidate)) return candidate;
    } catch {
      // An uncertain executable check is treated as unavailable.
    }
  }
  throw codedError("CODEX_NOT_AVAILABLE");
}

export function buildPermissionOverrides() {
  return [...PERMISSION_OVERRIDES];
}

export async function probeCodexIsolation(options) {
  try {
    if (!options || typeof options.runner !== "function") throw new Error("invalid probe");
    if (!normalizedAbsolutePath(options.isolatedDir) || !normalizedAbsolutePath(options.projectDir)) throw new Error("invalid boundary");
    if (containsPath(options.projectDir, options.isolatedDir) || containsPath(options.isolatedDir, options.projectDir)) throw new Error("overlapping boundary");
    const report = await options.runner({
      isolatedDir: options.isolatedDir,
      projectDir: options.projectDir,
      permissionOverrides: buildPermissionOverrides(),
      requiredChecks: [...REQUIRED_PROBE_CHECKS],
    });
    if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error("invalid report");
    if (REQUIRED_PROBE_CHECKS.some((check) => report[check] !== true)) throw new Error("incomplete report");
    return Object.fromEntries(REQUIRED_PROBE_CHECKS.map((check) => [check, true]));
  } catch {
    throw codedError(CODEX_ISOLATION_ERROR);
  }
}

export function minimalCodexEnvironment(source) {
  const environment = {};
  for (const [key, value] of Object.entries(source ?? {})) {
    if (ALLOWED_ENVIRONMENT_KEYS.has(key) && typeof value === "string") environment[key] = value;
  }
  return environment;
}
