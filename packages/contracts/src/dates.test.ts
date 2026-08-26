import { describe, expect, it } from "vitest";
import {
  appendDay,
  duplicateDay,
  insertDay,
  moveDay,
  reconcileDays,
  removeDay,
} from "./dates";
import { TripSchema } from "./trip";

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

  it("rejects duplicate input dates before content can be overwritten", () => {
    expect(() =>
      reconcileDays(
        [
          { id: "day-1", date: "2026-10-03", city: "深圳", itemIds: ["place-1"] },
          { id: "day-2", date: "2026-10-03", city: "香港", itemIds: ["place-2"] },
        ],
        "2026-10-03",
        "2026-10-03",
      ),
    ).toThrow("日期不能重复");
  });

  it("creates IDs that do not collide with out-of-range input days", () => {
    const result = reconcileDays(
      [
        {
          id: "day-2026-10-04",
          date: "2026-10-05",
          city: "深圳",
          itemIds: [],
        },
      ],
      "2026-10-03",
      "2026-10-04",
    );

    expect(result.days.map((day) => day.id)).toEqual([
      "day-2026-10-03",
      "day-2026-10-04-2",
    ]);
  });

  it("appends removed items to existing unscheduled IDs without duplicates", () => {
    const result = reconcileDays(
      [
        { id: "day-1", date: "2026-10-03", city: "深圳", itemIds: ["place-1"] },
        {
          id: "day-2",
          date: "2026-10-04",
          city: "香港",
          itemIds: ["place-2", "place-3"],
        },
      ],
      "2026-10-03",
      "2026-10-03",
      ["place-existing", "place-2"],
    );

    expect(result.unscheduledItemIds).toEqual([
      "place-existing",
      "place-2",
      "place-3",
    ]);
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

  it("appends after the latest date without shifting existing days", () => {
    const gapped = [current[0]!, { ...current[1]!, date: "2026-10-05" }];

    const result = appendDay(gapped, "2026-10-03", "day-new");

    expect(result).toEqual([
      gapped[0],
      gapped[1],
      { id: "day-new", date: "2026-10-06", city: "", itemIds: [] },
    ]);
    expect(gapped.map((day) => day.date)).toEqual(["2026-10-03", "2026-10-05"]);
  });

  it("rejects malformed or duplicate existing dates before append", () => {
    expect(() => appendDay(
      [{ id: "bad", date: "not-a-date", city: "", itemIds: [] }],
      "2026-10-03",
      "day-new",
    )).toThrow("日期格式无效");
    expect(() => appendDay(
      [
        current[0]!,
        { ...current[1]!, date: current[0]!.date },
      ],
      "2026-10-03",
      "day-new",
    )).toThrow("日期不能重复");
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

  it("moves a day across non-adjacent positions", () => {
    const result = moveDay(
      [
        ...current,
        { id: "day-3", date: "2026-10-05", city: "澳门", itemIds: ["place-3"] },
      ],
      0,
      2,
      "2026-10-03",
    );

    expect(result.map((day) => day.id)).toEqual(["day-2", "day-3", "day-1"]);
    expect(result.map((day) => day.date)).toEqual([
      "2026-10-03",
      "2026-10-04",
      "2026-10-05",
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

  it("does not duplicate removed items already in unscheduled", () => {
    const result = removeDay(current, 1, ["place-existing", "place-2"]);

    expect(result.unscheduledItemIds).toEqual(["place-existing", "place-2"]);
  });

  it("keeps scheduled item IDs out of the unscheduled bucket", () => {
    const result = removeDay(
      [
        { ...current[0]!, itemIds: ["place-shared", "place-removed"] },
        { ...current[1]!, itemIds: ["place-shared"] },
      ],
      0,
      ["place-existing", "place-shared"],
    );

    expect(result.unscheduledItemIds).toEqual(["place-existing", "place-removed"]);
    const scheduledItemIds = new Set(result.days.flatMap((day) => day.itemIds));
    expect(result.unscheduledItemIds.every((itemId) => !scheduledItemIds.has(itemId))).toBe(true);
    expect(result.unscheduledItemIds).not.toContain("place-shared");
  });

  it("rejects invalid indices", () => {
    expect(() => insertDay(current, 3, "2026-10-03", "day-new")).toThrow(
      "日期索引无效",
    );
    expect(() => duplicateDay(current, -1, "2026-10-03", () => "day-new")).toThrow(
      "日期索引无效",
    );
    expect(() => moveDay(current, 0, 2, "2026-10-03")).toThrow("日期索引无效");
    expect(() => removeDay(current, 2, [])).toThrow("日期索引无效");
  });
});

describe("TripSchema", () => {
  const trip = {
    id: "trip-1",
    title: "国庆旅行",
    startDate: "2026-10-03",
    endDate: "2026-10-04",
    travelers: [{ id: "traveler-1", name: "一鸣" }],
    days: [
      { id: "day-1", date: "2026-10-03", city: "深圳", itemIds: [] },
      { id: "day-2", date: "2026-10-04", city: "香港", itemIds: [] },
    ],
    unscheduledItemIds: [],
    version: 0,
  };

  it("rejects duplicate persisted day IDs", () => {
    expect(() =>
      TripSchema.parse({
        ...trip,
        days: [
          trip.days[0],
          { ...trip.days[1], id: "day-1" },
        ],
      }),
    ).toThrow("日期 ID 不能重复");
  });

  it("rejects a trip whose end date is before its start date", () => {
    expect(() =>
      TripSchema.parse({
        ...trip,
        startDate: "2026-10-04",
        endDate: "2026-10-03",
      }),
    ).toThrow("结束日期不能早于开始日期");
  });
});
