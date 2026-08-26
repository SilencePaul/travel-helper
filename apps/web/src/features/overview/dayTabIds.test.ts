import { expect, test } from "vitest";
import { getDayPanelId, getDayTabId } from "./dayTabIds";

test("creates collision-safe whitespace-free IDs", () => {
  expect(getDayTabId("a b")).not.toBe(getDayTabId("a-20b"));
  expect(getDayPanelId("a b")).not.toBe(getDayPanelId("a-20b"));
  expect(getDayTabId("a b")).not.toMatch(/\s/);
  expect(getDayPanelId("a b")).not.toMatch(/\s/);
});
