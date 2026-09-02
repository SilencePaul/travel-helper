import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const siteUrl = "https://trip.yiming.ca";

export function responseMatchesBriefing(expected, actual) {
  return Buffer.from(expected).equals(Buffer.from(actual));
}

export async function verifyBriefing({ source, slug, timeoutSeconds = 300, fetchImpl = fetch, wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms)) }) {
  const expected = await readFile(resolve(source));
  const url = `${siteUrl}/briefings/${slug}/`;
  const deadline = Date.now() + (timeoutSeconds * 1000);
  let lastStatus = "no response";

  while (Date.now() <= deadline) {
    const response = await fetch(`${url}?deploy-check=${Date.now()}`, { redirect: "follow" });
    const actual = Buffer.from(await response.arrayBuffer());
    lastStatus = `HTTP ${response.status}, ${actual.length} bytes`;
    if (response.ok && responseMatchesBriefing(expected, actual)) {
      return { url, status: response.status };
    }
    await wait(5000);
  }
  throw new Error(`Timed out waiting for the deployed briefing (${lastStatus}).`);
}

async function main() {
  const [source, slug, timeoutInput] = process.argv.slice(2);
  if (!source || !slug) {
    console.error("Usage: node scripts/verify-briefing.mjs <source.html> <slug> [timeout-seconds]");
    process.exitCode = 2;
    return;
  }
  const timeoutSeconds = timeoutInput ? Number(timeoutInput) : 300;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("Timeout seconds must be a positive integer.");
  }
  const result = await verifyBriefing({ source, slug, timeoutSeconds });
  console.log(`Verified: ${result.url} (HTTP ${result.status})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}
