import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Trip } from "@travel/contracts";
import { HotelComparePage } from "./HotelComparePage";

const trip: Trip = {
  id: "trip", title: "测试行程", startDate: "2026-10-03", endDate: "2026-10-08", version: 0, travelers: [], unscheduledItemIds: [], orders: [],
  days: [
    { id: "d1", date: "2026-10-03", city: "深圳", itemIds: [] },
    { id: "d2", date: "2026-10-04", city: "香港", itemIds: [] },
    { id: "d3", date: "2026-10-05", city: "香港", itemIds: ["peak", "star-ferry"] },
    { id: "d4", date: "2026-10-06", city: "澳门", itemIds: [] },
    { id: "d5", date: "2026-10-07", city: "澳门 / 珠海", itemIds: [] },
    { id: "d6", date: "2026-10-08", city: "珠海 / 北京", itemIds: [] },
  ],
};

describe("HotelComparePage", () => {
  it("selects a hotel, synchronizes the marker, and exposes sourced snapshot caveats", async () => {
    const onSelectHotel = vi.fn();
    const routeService = { getSegments: vi.fn(async () => ({ segments: [{ id: "provider", fromPlaceId: "a", toPlaceId: "b", mode: "transit" as const, distanceMeters: 1200, durationMinutes: 18, summary: "高德公共交通路线", path: [] }], failures: [] })) };
    const user = userEvent.setup();
    onSelectHotel.mockResolvedValue(true);
    render(<HotelComparePage trip={trip} routeService={routeService} onSelectHotel={onSelectHotel} onBack={() => undefined} />);

    expect(screen.getByTestId("hotel-nights")).toHaveTextContent("2 晚");
    await user.click(screen.getAllByRole("button", { name: "选择此酒店" }).at(-1)!);

    expect(onSelectHotel).toHaveBeenCalledWith("park-hotel-hong-kong");
    expect(screen.getByRole("button", { name: "在地图中定位 香港百乐酒店" })).toHaveAttribute("aria-current", "location");
    expect(screen.getByTestId("hotel-total")).toHaveTextContent("CNY 2266.09");
    await waitFor(() => expect(screen.getByText(/太平山顶 18 分钟/)).toBeVisible());
    expect(screen.getByTestId("hotel-commute")).toHaveTextContent("待高德路线确认");
    expect(screen.getAllByText(/非 2026 十一实时可订价/)).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Booking.com · 香港百乐酒店价格与房型（新窗口）" })).toHaveAttribute("href", "https://www.booking.com/hotel/hk/parkhotel.zh-tw.html");
  });

  it("does not invent a commute when AMap has no response", async () => {
    render(<HotelComparePage trip={trip} routeService={{ getSegments: vi.fn(async () => { throw new Error("unavailable"); }) }} onSelectHotel={() => true} onBack={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId("hotel-commute")).toHaveTextContent("待高德路线确认"));
  });

  it("rolls a hotel marker back when the persisted selection is rejected", async () => {
    const user = userEvent.setup();
    render(<HotelComparePage trip={trip} onSelectHotel={async () => false} onBack={() => undefined} />);
    await user.click(screen.getAllByRole("button", { name: "选择此酒店" }).at(-1)!);
    await waitFor(() => expect(screen.getByRole("button", { name: "在地图中定位 九龙酒店" })).toHaveAttribute("aria-current", "location"));
  });

  it("reconciles a later persisted hotel selection from a trip subscription", async () => {
    const view = render(<HotelComparePage trip={trip} onSelectHotel={() => true} onBack={() => undefined} />);
    view.rerender(<HotelComparePage trip={{ ...trip, days: trip.days.map((day) => day.city === "香港" ? { ...day, hotelId: "park-hotel-hong-kong" } : day) }} onSelectHotel={() => true} onBack={() => undefined} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "在地图中定位 香港百乐酒店" })).toHaveAttribute("aria-current", "location"));
  });

  it("recalculates selected stay nights when the trip has more assigned hotel days", () => {
    const extended: Trip = {
      ...trip,
      endDate: "2026-10-10",
      days: [...trip.days.map((day) => day.city === "香港" ? { ...day, hotelId: "kowloon-hotel" } : day), 
        { id: "d7", date: "2026-10-09", city: "香港", itemIds: [], hotelId: "kowloon-hotel" },
        { id: "d8", date: "2026-10-10", city: "香港", itemIds: [], hotelId: "kowloon-hotel" },
      ],
    };
    render(<HotelComparePage trip={extended} onSelectHotel={() => true} onBack={() => undefined} />);
    expect(screen.getByTestId("hotel-nights")).toHaveTextContent("4 晚");
  });
});
