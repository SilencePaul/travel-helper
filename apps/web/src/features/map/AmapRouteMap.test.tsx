import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Trip } from "@travel/contracts";
import { describe, expect, it, vi } from "vitest";
import { DayPage } from "../itinerary/DayPage";
import { AmapRouteMap } from "./AmapRouteMap";
import type { MapInteractionAdapter } from "./types";

const trip: Trip = {
  id: "trip-test",
  title: "测试旅行",
  startDate: "2026-10-05",
  endDate: "2026-10-05",
  travelers: [{ id: "yiming", name: "一鸣" }],
  days: [{ id: "hong-kong-day", date: "2026-10-05", city: "香港", itemIds: ["peak", "central-pier"] }],
  unscheduledItemIds: [],
  version: 0,
};

describe("AmapRouteMap", () => {
  it("focuses the selected timeline place on the injected map adapter", async () => {
    const user = userEvent.setup();
    const mapAdapter: MapInteractionAdapter = { focusPlace: vi.fn() };

    render(<DayPage trip={trip} dayId="hong-kong-day" onBack={() => undefined} mapAdapter={mapAdapter} />);

    await user.click(screen.getByRole("button", { name: "太平山顶" }));

    expect(screen.getByRole("button", { name: "太平山顶" })).toHaveAttribute("aria-current", "location");
    expect(mapAdapter.focusPlace).toHaveBeenCalledOnce();
    expect(mapAdapter.focusPlace).toHaveBeenCalledWith("peak");
  });

  it("states why a short provider path is not drawn as a direct line", async () => {
    render(
      <AmapRouteMap
        places={[]}
        segments={[{
          id: "incomplete",
          fromPlaceId: "a",
          toPlaceId: "b",
          mode: "walking",
          distanceMeters: 1,
          durationMinutes: 1,
          summary: "未完成路段",
          path: [],
        }]}
        onSelectPlace={() => undefined}
      />,
    );

    expect(await screen.findByText("“未完成路段”缺少完整道路路径，未绘制直线替代路线。")).toBeVisible();
    expect(await screen.findByText("浏览器地图凭据未配置，暂无法加载高德地图。")).toBeVisible();
  });
});
