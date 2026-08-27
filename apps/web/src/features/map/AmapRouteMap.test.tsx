import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Trip } from "@travel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DayPage } from "../itinerary/DayPage";
import { missingAmapBrowserCredentials } from "./amapLoader";
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
  orders: [],
  version: 0,
};

const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");

afterEach(() => {
  if (originalScrollIntoView) Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

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
        mapLoader={() => Promise.reject(new Error(missingAmapBrowserCredentials))}
      />,
    );

    expect(await screen.findByText("“未完成路段”缺少完整道路路径，未绘制直线替代路线。")).toBeVisible();
    expect(await screen.findByText("浏览器地图凭据未配置，暂无法加载高德地图。")).toBeVisible();
  });

  it("does not route across an unresolved itinerary item", async () => {
    const routeService = { getSegments: vi.fn() };
    const unresolvedTrip = { ...trip, days: [{ ...trip.days[0]!, itemIds: ["peak", "not-a-known-poi", "central-pier"] }] };

    render(<DayPage trip={unresolvedTrip} dayId="hong-kong-day" onBack={() => undefined} routeService={routeService} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("有未识别地点，无法串联道路路线：not-a-known-poi");
    expect(routeService.getSegments).not.toHaveBeenCalled();
  });

  it("passes the current day city to the route provider", async () => {
    const routeService = { getSegments: vi.fn(async () => []) };

    render(<DayPage trip={trip} dayId="hong-kong-day" onBack={() => undefined} routeService={routeService} />);

    await waitFor(() => expect(routeService.getSegments).toHaveBeenCalledWith(expect.objectContaining({
      dayId: "hong-kong-day",
      city: "香港",
      placeIds: ["peak", "central-pier"],
      modeByLeg: ["transit"],
    })));
  });

  it("clears a resolved route when the same known endpoints gain an unresolved item", async () => {
    const routeService = { getSegments: vi.fn(async () => [{
      id: "known-route", fromPlaceId: "peak", toPlaceId: "central-pier", mode: "transit" as const,
      distanceMeters: 1800, durationMinutes: 15, summary: "高德公共交通路线",
      path: [{ lng: 114.15, lat: 22.27, coordinateSystem: "GCJ02" as const }, { lng: 114.16, lat: 22.28, coordinateSystem: "GCJ02" as const }, { lng: 114.166177, lat: 22.284364, coordinateSystem: "GCJ02" as const }],
    }]) };
    const view = render(<DayPage trip={trip} dayId="hong-kong-day" onBack={() => undefined} routeService={routeService} />);

    expect(await screen.findByText(/高德公共交通路线/)).toBeVisible();
    view.rerender(<DayPage trip={{ ...trip, days: [{ ...trip.days[0]!, itemIds: ["peak", "missing", "central-pier"] }] }} dayId="hong-kong-day" onBack={() => undefined} routeService={routeService} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("missing");
    expect(screen.queryByText(/高德公共交通路线/)).not.toBeInTheDocument();
  });

  it("draws the provider path verbatim and syncs a real AMap marker after a deferred loader resolves", async () => {
    const markerCallbacks: Array<() => void> = [];
    const polyline = vi.fn();
    const setCenter = vi.fn();
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    const mapApi = {
      Map: class { destroy = vi.fn(); setFitView = vi.fn(); setCenter = setCenter; },
      Polyline: class { constructor(options: unknown) { polyline(options); } },
      Marker: class { on(_event: string, callback: () => void) { markerCallbacks.push(callback); } },
    };
    let resolveMap: ((value: typeof mapApi) => void) | undefined;
    const mapLoader = vi.fn(() => new Promise<typeof mapApi>((resolve) => { resolveMap = resolve; }));
    const mapAdapter: MapInteractionAdapter = { focusPlace: vi.fn() };
    const routeService = {
      getSegments: vi.fn(async () => [{
        id: "provider-route",
        fromPlaceId: "peak",
        toPlaceId: "central-pier",
        mode: "transit" as const,
        distanceMeters: 1800,
        durationMinutes: 15,
        summary: "高德公共交通路线",
        path: [
          { lng: 114.15, lat: 22.27, coordinateSystem: "GCJ02" as const },
          { lng: 114.16, lat: 22.28, coordinateSystem: "GCJ02" as const },
          { lng: 114.166177, lat: 22.284364, coordinateSystem: "GCJ02" as const },
        ],
      }]),
    };

    render(<DayPage trip={trip} dayId="hong-kong-day" onBack={() => undefined} mapAdapter={mapAdapter} mapLoader={mapLoader} routeService={routeService} />);
    await waitFor(() => expect(mapLoader).toHaveBeenCalledTimes(2));
    await userEvent.setup().click(screen.getByRole("button", { name: "太平山顶" }));
    resolveMap?.(mapApi);

    await waitFor(() => expect(polyline).toHaveBeenCalledWith(expect.objectContaining({
      path: [[114.15, 22.27], [114.16, 22.28], [114.166177, 22.284364]],
    })));
    await waitFor(() => expect(setCenter).toHaveBeenCalledWith([114.150192, 22.270851]));
    markerCallbacks[0]!();
    await waitFor(() => expect(screen.getByRole("button", { name: "太平山顶" })).toHaveAttribute("aria-current", "location"));
    expect(mapAdapter.focusPlace).toHaveBeenCalledWith("peak");
    expect(scrollIntoView).toHaveBeenCalled();
  });
});
