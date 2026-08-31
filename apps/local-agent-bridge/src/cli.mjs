#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { LocalAgentBridgeRuntime } from "./runtime.mjs";
import { startLocalAgentBridge } from "./server.mjs";

export function parseCliArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!["--app-url", "--agent-endpoint", "--port"].includes(key) || value === undefined || Object.hasOwn(values, key)) throw new Error("INVALID_ARGUMENTS");
    values[key] = value;
  }
  const port = values["--port"] === undefined ? 0 : Number(values["--port"]);
  if (!values["--app-url"] || !values["--agent-endpoint"] || port !== 0) throw new Error("INVALID_ARGUMENTS");
  return { appUrl: values["--app-url"], agentEndpoint: values["--agent-endpoint"], port };
}

export async function runCli(argv = process.argv.slice(2), output = process.stdout) {
  const options = parseCliArguments(argv);
  const runtime = new LocalAgentBridgeRuntime({ agentEndpoint: options.agentEndpoint });
  const bridge = await startLocalAgentBridge({
    appUrl: options.appUrl,
    port: options.port,
    runtime,
    onPrepared: (data) => output.write(`本机配对指纹：${data.pairingCodeFingerprint}\n`),
  });
  output.write(`请在浏览器中打开：${bridge.connectionUrl}\n`);
  let closing;
  const close = () => {
    closing ??= bridge.close()
      .then(() => { process.exitCode = 0; })
      .catch(() => { process.exitCode = 1; });
    return closing;
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
  return bridge;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(`本地 Agent Bridge 启动失败：${error?.code || error?.message || "UNKNOWN"}\n`);
    process.exitCode = 1;
  });
}
