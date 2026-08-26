import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Trip } from "@travel/contracts";
import { HotelComparePage } from "./HotelComparePage";

const trip: Trip = {
  id: "trip", title: "测试行程", startDate: "2026-10-03", endDate: "2026-10-08", version: 0, travelers: [], unscheduledItemIds: [],
  days: [
    { id: "d1", date: "2026-10-03", city: "深圳", itemIds: [] },
    { id: "d2", date: "2026-10-04", city: "香港", itemIds: [] },
    { id: "d3", date: "2026-10-05", city: "香港", itemIds: [] },
    { id: "d4", date: "2026-10-06", city: "澳门", itemIds: [] },
    { id: "d5", date: "2026-10-07", city: "澳门 / 珠海", itemIds: [] },
    { id: "d6", date: "2026-10-08", city: "珠海 / 北京", itemIds: [] },
  ],
};

describe("HotelComparePage", () => {
  it("selects a hotel, synchronizes the marker, and exposes sourced snapshot caveats", async () => {
    const onSelectHotel = vi.fn();
    const user = userEvent.setup();
    render(<HotelComparePage trip={trip} onSelectHotel={onSelectHotel} onBack={() => undefined} />);

    expect(screen.getByTestId("hotel-nights")).toHaveTextContent("2 晚");
    await user.click(screen.getAllByRole("button", { name: "选择此酒店" }).at(-1)!);

    expect(onSelectHotel).toHaveBeenCalledWith("park-hotel-hong-kong");
    expect(screen.getByRole("button", { name: "香港百乐酒店" })).toHaveAttribute("aria-current", "location");
    expect(screen.getByTestId("hotel-total")).toHaveTextContent("CNY 2266.08");
    expect(screen.getAllByText(/非 2026 十一实时可订价/)).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: /Booking\.com/ })[1]).toHaveAttribute("href", "https://www.booking.com/hotel/hk/parkhotel.zh-tw.html");
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
    render(<HotelComparePage trip={extended} onSelectHotel={() => undefined} onBack={() => undefined} />);
    expect(screen.getByTestId("hotel-nights")).toHaveTextContent("4 晚");
  });
});
