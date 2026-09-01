import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultPublicRoot = join(repositoryRoot, "apps", "web", "public");
const defaultSiteUrl = "https://trip.yiming.ca";

export function validateBriefingSlug(slug) {
  if (typeof slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error("Briefing slug must contain lowercase letters, digits, and single hyphens only.");
  }
  return slug;
}

export async function prepareBriefing({ source, slug, publicRoot = defaultPublicRoot, siteUrl = defaultSiteUrl }) {
  const validSlug = validateBriefingSlug(slug);
  const sourcePath = resolve(source ?? "");
  if (extname(sourcePath).toLowerCase() !== ".html") {
    throw new Error("Briefing source must be an .html file.");
  }
  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isFile()) {
    throw new Error("Briefing source must be a file.");
  }

  const destination = join(resolve(publicRoot), "briefings", validSlug, "index.html");
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(sourcePath, destination);

  const [sourceBytes, destinationBytes] = await Promise.all([readFile(sourcePath), readFile(destination)]);
  const identical = sourceBytes.equals(destinationBytes);
  if (!identical) {
    throw new Error("Briefing copy verification failed.");
  }

  return {
    destination,
    identical,
    url: `${siteUrl.replace(/\/$/, "")}/briefings/${validSlug}/`,
  };
}

async function main() {
  const [source, slug] = process.argv.slice(2);
  if (!source || !slug) {
    console.error("Usage: node scripts/publish-briefing.mjs <source.html> <slug>");
    process.exitCode = 2;
    return;
  }
  const result = await prepareBriefing({ source, slug });
  console.log(`Prepared: ${result.destination}`);
  console.log(`Share URL: ${result.url}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}
