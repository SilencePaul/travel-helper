import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareBriefing, validateBriefingSlug } from "./publish-briefing.mjs";

test("accepts a URL-safe briefing slug", () => {
  assert.equal(validateBriefingSlug("probation-review"), "probation-review");
});

test("rejects nested or unsafe briefing slugs", () => {
  for (const slug of ["", "../escape", "team/review", "Review", "review_2026", "."]) {
    assert.throws(() => validateBriefingSlug(slug), /slug/i);
  }
});

test("copies an HTML briefing byte-for-byte into its public route", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "travel-briefing-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const source = join(sandbox, "source.html");
  const publicRoot = join(sandbox, "public");
  const content = "<!doctype html><title>Briefing</title><script>window.next=1</script>";
  await writeFile(source, content);

  const result = await prepareBriefing({
    source,
    slug: "quarterly-review",
    publicRoot,
    siteUrl: "https://trip.example",
  });

  assert.equal(result.url, "https://trip.example/briefings/quarterly-review/");
  assert.equal(await readFile(result.destination, "utf8"), content);
  assert.equal(result.identical, true);
});

test("rejects a non-HTML source without creating a public route", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "travel-briefing-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const source = join(sandbox, "source.txt");
  await writeFile(source, "not html");

  await assert.rejects(
    prepareBriefing({ source, slug: "unsafe-source", publicRoot: join(sandbox, "public") }),
    /\.html/i,
  );
});
