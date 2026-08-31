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

const NETWORK_PROBE_URL = "https://example.com/";

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

function validThreadId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(value);
}

function parseProbeEvidence(response, check) {
  if (!response || response.exitCode !== 0 || typeof response.stdout !== "string") throw new Error("probe failed");
  const lines = response.stdout.split(/\r?\n/u).filter((line) => line.trim());
  if (lines.length !== 1) throw new Error("invalid evidence");
  const evidence = JSON.parse(lines[0]);
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw new Error("invalid evidence");
  if (evidence.check !== check.name || evidence.observed !== check.expected) throw new Error("mismatched evidence");
  if (Object.hasOwn(check, "target") && evidence.target !== check.target) throw new Error("mismatched target");
  if (!Object.hasOwn(check, "target") && Object.hasOwn(evidence, "target")) throw new Error("unexpected target");
  if (check.name === "persistenceAvailable" && !validThreadId(evidence.codexThreadId ?? evidence.codexTaskId)) {
    throw new Error("missing persistent task");
  }
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
    if (!options || typeof options.probeAdapter !== "function") throw new Error("invalid probe");
    if (!normalizedAbsolutePath(options.codexPath)) throw new Error("invalid executable");
    if (!normalizedAbsolutePath(options.isolatedDir) || !normalizedAbsolutePath(options.projectDir)) throw new Error("invalid boundary");
    if (containsPath(options.projectDir, options.isolatedDir) || containsPath(options.isolatedDir, options.projectDir)) throw new Error("overlapping boundary");
    const probePaths = options.probePaths;
    if (!probePaths || !normalizedAbsolutePath(probePaths.isolatedFile) || !normalizedAbsolutePath(probePaths.outsideFile) || !normalizedAbsolutePath(probePaths.projectFile)) {
      throw new Error("invalid probe paths");
    }
    if (!containsPath(options.isolatedDir, probePaths.isolatedFile) || !containsPath(options.projectDir, probePaths.projectFile)) {
      throw new Error("misplaced probe path");
    }
    if (containsPath(options.isolatedDir, probePaths.outsideFile) || containsPath(options.projectDir, probePaths.outsideFile)) {
      throw new Error("outside probe is not outside");
    }
    const checks = [
      { name: "isolatedDirectoryReadable", target: probePaths.isolatedFile, expected: "readable" },
      { name: "outsideDirectoryUnreadable", target: probePaths.outsideFile, expected: "denied" },
      { name: "projectDirectoryUnreadable", target: probePaths.projectFile, expected: "denied" },
      { name: "httpsNetworkAvailable", target: NETWORK_PROBE_URL, expected: "available" },
      { name: "authenticationAvailable", expected: "authenticated" },
      { name: "persistenceAvailable", expected: "persistent" },
    ];
    const env = minimalCodexEnvironment(options.sourceEnv);
    for (const check of checks) {
      const response = await options.probeAdapter({
        executable: options.codexPath,
        cwd: options.isolatedDir,
        env,
        permissionOverrides: buildPermissionOverrides(),
        check,
      });
      parseProbeEvidence(response, check);
    }
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
