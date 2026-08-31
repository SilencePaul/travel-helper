import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseCliArguments } from "./cli.mjs";

test("CLI accepts only explicit app URL, Agent endpoint and a valid port", () => {
  assert.deepEqual(parseCliArguments([
    "--app-url", "https://trip.example",
    "--agent-endpoint", "https://api.example/api/agent",
    "--port", "0",
  ]), {
    appUrl: "https://trip.example",
    agentEndpoint: "https://api.example/api/agent",
    port: 0,
  });
  assert.throws(() => parseCliArguments(["--app-url", "https://trip.example", "--port", "wildcard"]), /INVALID_ARGUMENTS/);
  assert.throws(() => parseCliArguments(["--app-url", "https://trip.example", "--agent-endpoint", "https://api.example/api/agent", "--port", "43120"]), /INVALID_ARGUMENTS/);
  assert.throws(() => parseCliArguments(["--app-url", "https://trip.example", "--app-url", "https://other.example", "--agent-endpoint", "https://api.example/api/agent"]), /INVALID_ARGUMENTS/);
  assert.throws(() => parseCliArguments(["--app-url", "https://trip.example", "--unknown", "value"]), /INVALID_ARGUMENTS/);
});

test("the real CLI prints a connection URL and pairing fingerprint, then exits on SIGTERM", async (context) => {
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("./cli.mjs", import.meta.url)),
    "--app-url", "https://trip.example/decisions",
    "--agent-endpoint", "https://api.example/api/agent",
    "--port", "0",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  context.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (value) => { stdout += value; });
  child.stderr.on("data", (value) => { stderr += value; });
  const waitForOutput = (pattern) => new Promise((resolve, reject) => {
    const inspect = () => {
      const match = stdout.match(pattern);
      if (!match) return false;
      cleanup();
      resolve(match);
      return true;
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", inspect);
      child.off("exit", onExit);
    };
    const onExit = () => {
      cleanup();
      reject(new Error(`CLI exited before expected output: ${stderr}`));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for CLI output: ${stdout} ${stderr}`));
    }, 5_000);
    child.stdout.on("data", inspect);
    child.once("exit", onExit);
    inspect();
  });

  const connectionMatch = await waitForOutput(/请在浏览器中打开：(https:\/\/\S+)/);
  const connectionUrl = new URL(connectionMatch[1]);
  const bridgeOrigin = new URLSearchParams(connectionUrl.hash.slice(1)).get("agentBridge");
  assert.match(bridgeOrigin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const response = await fetch(`${bridgeOrigin}/v1/agent-runs/prepare`, {
    method: "POST",
    headers: { origin: connectionUrl.origin, "content-type": "application/json" },
    body: JSON.stringify({ scope: ["submitProposalBatch"] }),
  });
  assert.equal(response.status, 200);
  const prepared = await response.json();
  const fingerprintMatch = await waitForOutput(/本机配对指纹：([A-F0-9]{4} · [A-F0-9]{4})/);
  assert.equal(fingerprintMatch[1], prepared.data.pairingCodeFingerprint);

  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  child.kill("SIGTERM");
  assert.deepEqual(await exited, { code: 0, signal: null });
});
