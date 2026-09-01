import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = resolve(repositoryRoot, "apps", "web");
const requireFromWeb = createRequire(resolve(webRoot, "package.json"));

export function assertCloudflareNodeVersion(version) {
  if (!/^v22\./.test(version)) {
    throw new Error(`Cloudflare Pages build requires Node 22; received ${version}. Use Node 22 before publishing.`);
  }
}

export function buildWebForCloudflare({ nodePath = process.execPath } = {}) {
  const version = execFileSync(nodePath, ["--version"], { encoding: "utf8" }).trim();
  assertCloudflareNodeVersion(version);
  const tscPath = requireFromWeb.resolve("typescript/bin/tsc");
  const vitePackagePath = requireFromWeb.resolve("vite/package.json");
  const vitePath = resolve(dirname(vitePackagePath), "bin", "vite.js");

  execFileSync(nodePath, [tscPath, "-b"], { cwd: webRoot, stdio: "inherit" });
  execFileSync(nodePath, [vitePath, "build"], { cwd: webRoot, stdio: "inherit" });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    buildWebForCloudflare();
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}
