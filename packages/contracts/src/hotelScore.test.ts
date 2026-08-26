import { describe, expect, it } from "vitest";
import { scoreHotels, stayNightsForHotel } from "./hotelScore";
import type { Hotel } from "./hotel";
import type { Trip } from "./trip";

const source = {
  label: "测试来源",
  url: "https://example.com/hotel",
  platform: "测试平台",
  checkedAt: "2026-08-26T08:00:00.000Z",
};

const nearHotel: Hotel = {
  id: "near", name: "近酒店", address: "香港", amapPoiId: "poi-near", coordinate: { lng: 114.17, lat: 22.3, coordinateSystem: "GCJ02" }, locationSource: source,
  neighborhood: "尖沙咀", nightlyPrice: { snapshotTotalMinor: 360000, snapshotNights: 3, currency: "HKD", scope: "含税费及其他费用的参考快照", source },
  roomArea: "18–48 平方米", breakfast: "以订单页为准", cancellation: "以订单页为准", stationWalk: "步行约 3 分钟", strengths: ["近景点"], drawbacks: ["房间较紧凑"],
};
const cheapFarHotel: Hotel = { ...nearHotel, id: "far", name: "远酒店", nightlyPrice: { ...nearHotel.nightlyPrice, snapshotTotalMinor: 270000 } };
const commutes = { near: [{ date: "2026-10-04", firstPlace: "码头", lastPlace: "山顶", outboundMinutes: 12, returnMinutes: 15, distanceMeters: 2800, status: "confirmed" as const }], far: [{ date: "2026-10-04", firstPlace: "码头", lastPlace: "山顶", outboundMinutes: 35, returnMinutes: 40, distanceMeters: 6200, status: "confirmed" as const }] };

describe("scoreHotels", () => {
  it("labels the hotel with the lowest total commute as most energy-saving", () => {
    const result = scoreHotels([nearHotel, cheapFarHotel], { nights: 3, commutesByHotel: commutes });
    expect(result.find((item) => item.id === nearHotel.id)?.badges).toContain("最省体力");
  });

  it("uses tax-inclusive stay total instead of headline nightly price", () => {
    const result = scoreHotels([{ ...nearHotel, nightlyPrice: { ...nearHotel.nightlyPrice, snapshotTotalMinor: 468000 } }], { nights: 3 });
    expect(result[0]?.stayTotalMinor).toBe(468000);
  });

  it("withholds commute score and energy badge until every provider leg is confirmed", () => {
    const result = scoreHotels([nearHotel], { nights: 3, commutesByHotel: { near: [{ ...commutes.near[0]!, status: "pending" }] } });
    expect(result[0]).toMatchObject({ commuteComplete: false, commuteScore: undefined });
    expect(result[0]?.badges).not.toContain("最省体力");
  });

  it("calculates nights from selected hotel dates rather than a fixed trip length", () => {
    const trip: Trip = {
      id: "trip", title: "测试", startDate: "2026-10-03", endDate: "2026-10-10", travelers: [], version: 0, unscheduledItemIds: [],
      days: [
        { id: "d1", date: "2026-10-03", city: "深圳", itemIds: [] },
        { id: "d2", date: "2026-10-04", city: "香港", itemIds: [], hotelId: "near" },
        { id: "d3", date: "2026-10-05", city: "香港", itemIds: [], hotelId: "near" },
        { id: "d4", date: "2026-10-06", city: "香港", itemIds: [], hotelId: "near" },
        { id: "d5", date: "2026-10-07", city: "香港", itemIds: [], hotelId: "near" },
        { id: "d6", date: "2026-10-08", city: "香港", itemIds: [], hotelId: "near" },
        { id: "d7", date: "2026-10-09", city: "澳门", itemIds: [] },
        { id: "d8", date: "2026-10-10", city: "珠海", itemIds: [] },
      ],
    };
    expect(stayNightsForHotel(trip, "near")).toBe(5);
  });
});
