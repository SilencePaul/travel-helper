import { describe, expect, it } from "vitest";
import {
  duplicateDay,
  insertDay,
  moveDay,
  reconcileDays,
  removeDay,
} from "./dates";

describe("reconcileDays", () => {
  it.each([
    ["2026-10-03", "2026-10-06", ["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06"]],
    ["2026-10-03", "2026-10-08", ["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]],
    ["2026-10-03", "2026-10-10", ["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10"]],
  ])("builds an inclusive range", (start, end, dates) => {
    expect(reconcileDays([], start, end).days.map((day) => day.date)).toEqual(dates);
  });

  it("keeps removed content in the unscheduled bucket", () => {
    const current = [
      { id: "day-1", date: "2026-10-03", city: "深圳", itemIds: ["place-1"] },
      { id: "day-2", date: "2026-10-04", city: "香港", itemIds: ["place-2"] },
    ];
    const result = reconcileDays(current, "2026-10-03", "2026-10-03");
    expect(result.days.map((day) => day.id)).toEqual(["day-1"]);
    expect(result.unscheduledItemIds).toEqual(["place-2"]);
  });

  it("rejects malformed or backwards ranges", () => {
    expect(() => reconcileDays([], "not-a-date", "2026-10-03")).toThrow(
      "日期格式无效",
    );
    expect(() => reconcileDays([], "2026-10-04", "2026-10-03")).toThrow(
      "结束日期不能早于开始日期",
    );
  });
});

describe("manual day operations", () => {
  const current = [
    { id: "day-1", date: "2026-10-03", city: "深圳", itemIds: ["place-1"] },
    { id: "day-2", date: "2026-10-04", city: "香港", itemIds: ["place-2"] },
  ];

  it("inserts a blank day without changing the source", () => {
    const result = insertDay(current, 1, "2026-10-03", "day-new");

    expect(result.map((day) => day.id)).toEqual(["day-1", "day-new", "day-2"]);
    expect(result.map((day) => day.date)).toEqual([
      "2026-10-03",
      "2026-10-04",
      "2026-10-05",
    ]);
    expect(result[1]).toMatchObject({ city: "", itemIds: [] });
    expect(current).toEqual([
      { id: "day-1", date: "2026-10-03", city: "深圳", itemIds: ["place-1"] },
      { id: "day-2", date: "2026-10-04", city: "香港", itemIds: ["place-2"] },
    ]);
  });

  it("duplicates with an injected stable ID and independent item IDs", () => {
    const result = duplicateDay(current, 0, "2026-10-03", () => "day-copy");

    expect(result.map((day) => day.id)).toEqual(["day-1", "day-copy", "day-2"]);
    expect(result[1]!.itemIds).toEqual(["place-1"]);
    expect(result[1]!.itemIds).not.toBe(current[0]!.itemIds);
    expect(current).toEqual([
      { id: "day-1", date: "2026-10-03", city: "深圳", itemIds: ["place-1"] },
      { id: "day-2", date: "2026-10-04", city: "香港", itemIds: ["place-2"] },
    ]);
  });

  it("moves a day without changing its stable ID or duplicating dates", () => {
    const result = moveDay(current, 0, 1, "2026-10-03");

    expect(result.map((day) => day.id)).toEqual(["day-2", "day-1"]);
    expect(result.map((day) => day.date)).toEqual(["2026-10-03", "2026-10-04"]);
    expect(new Set(result.map((day) => day.date)).size).toBe(result.length);
    expect(current).toEqual([
      { id: "day-1", date: "2026-10-03", city: "深圳", itemIds: ["place-1"] },
      { id: "day-2", date: "2026-10-04", city: "香港", itemIds: ["place-2"] },
    ]);
  });

  it("removes a populated day and returns its items to unscheduled", () => {
    const result = removeDay(current, 1, ["place-existing"]);

    expect(result.days.map((day) => day.id)).toEqual(["day-1"]);
    expect(result.unscheduledItemIds).toEqual(["place-existing", "place-2"]);
    expect(current).toEqual([
      { id: "day-1", date: "2026-10-03", city: "深圳", itemIds: ["place-1"] },
      { id: "day-2", date: "2026-10-04", city: "香港", itemIds: ["place-2"] },
    ]);
  });
});
