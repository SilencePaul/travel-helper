import { render, screen } from "@testing-library/react";
import type { Member, Trip } from "@travel/contracts";
import { expect, test } from "vitest";
import { TravelPassHero } from "./TravelPassHero";

const trip: Trip = {
  id: "southbound-2026",
  title: "2026 十一深港澳珠旅行",
  startDate: "2026-10-03",
  endDate: "2026-10-10",
  travelers: [
    { id: "yiming", name: "一鸣" },
    { id: "meiyao", name: "美垚" },
  ],
  days: [
    { id: "day-1", date: "2026-10-03", city: "深圳", itemIds: [] },
    { id: "day-2", date: "2026-10-04", city: "香港", itemIds: [] },
    { id: "day-3", date: "2026-10-05", city: "香港", itemIds: [] },
    { id: "day-4", date: "2026-10-06", city: "澳门", itemIds: [] },
    { id: "day-5", date: "2026-10-07", city: "澳门 / 珠海", itemIds: [] },
    { id: "day-6", date: "2026-10-08", city: "珠海 / 北京", itemIds: [] },
  ],
  unscheduledItemIds: [],
  orders: [],
  version: 0,
};

const member: Member = {
  uid: "member-yiming",
  displayName: "一鸣",
  role: "admin",
  version: 0,
  createdAt: "2026-08-28T00:00:00.000Z",
};

function activeStations(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll('[data-station][data-active="true"]'),
    (station) => station.getAttribute("data-station"),
  );
}

test("renders the editorial heading and continuous labelled southbound route", () => {
  const { container } = render(<TravelPassHero trip={trip} member={member} />);

  expect(screen.getByRole("heading", { name: "两个人，一条向南的路线。" })).toBeVisible();
  expect(container.querySelector(".travel-pass-hero__heading-emphasis")).toHaveTextContent("一条向南的路线。");

  const route = screen.getByRole("img", { name: /北京出发，经深圳、香港、澳门、珠海，返回北京的路线/ });
  const stations = route.querySelectorAll("[data-station]");
  expect(Array.from(stations, (station) => station.getAttribute("data-station"))).toEqual([
    "PEK 北京",
    "SZX 深圳",
    "HKG 香港",
    "MFM 澳门",
    "ZUH 珠海",
    "PEK 北京",
  ]);
  expect(stations[0]).toHaveClass("travel-pass-hero__station--endpoint");
  expect(stations[5]).toHaveClass("travel-pass-hero__station--endpoint");
  expect(stations[1]).toHaveClass("travel-pass-hero__station--stop");

  const wave = screen.getByTestId("travel-route-wave");
  expect(wave).toHaveAttribute("stroke-dasharray");
  expect(wave.getAttribute("d")).toMatch(/C[^A-Z]*720 102$/);
});

test.each([
  ["深圳", "SZX 深圳"],
  ["香港", "HKG 香港"],
  ["澳门", "MFM 澳门"],
  ["珠海", "ZUH 珠海"],
])("highlights only the %s station for a single-city day", (city, station) => {
  const singleCityTrip: Trip = {
    ...trip,
    days: [{ id: "only-day", date: "2026-10-03", city, itemIds: [] }],
  };

  const { container } = render(<TravelPassHero trip={singleCityTrip} />);

  expect(activeStations(container)).toEqual([station]);
});

test("highlights both Macau and Zhuhai for day 5", () => {
  const { container } = render(<TravelPassHero trip={trip} selectedDayId="day-5" />);

  expect(activeStations(container)).toEqual(["MFM 澳门", "ZUH 珠海"]);
  expect(screen.getByRole("img", { name: "北京出发，经深圳、香港、澳门、珠海，返回北京的路线；当前 D5，澳门、珠海已高亮" })).toBeVisible();
});

test("highlights Zhuhai and only the returning Beijing endpoint for day 6", () => {
  const { container } = render(<TravelPassHero trip={trip} selectedDayId="day-6" />);

  expect(activeStations(container)).toEqual(["ZUH 珠海", "PEK 北京"]);
  const beijingStations = container.querySelectorAll('[data-station="PEK 北京"]');
  expect(beijingStations[0]).not.toHaveAttribute("data-active");
  expect(beijingStations[1]).toHaveAttribute("data-active", "true");
  expect(screen.getByRole("img", { name: "北京出发，经深圳、香港、澳门、珠海，返回北京的路线；当前 D6，珠海、北京已高亮" })).toBeVisible();
});

test("updates active route stations when the selected day changes", () => {
  const { container, rerender } = render(<TravelPassHero trip={trip} selectedDayId="day-1" />);

  expect(activeStations(container)).toEqual(["SZX 深圳"]);
  expect(screen.getByRole("img", { name: "北京出发，经深圳、香港、澳门、珠海，返回北京的路线；当前 D1，深圳已高亮" })).toBeVisible();

  rerender(<TravelPassHero trip={trip} selectedDayId="day-5" />);

  expect(container.querySelector('[data-station="SZX 深圳"]')).not.toHaveAttribute("data-active");
  expect(activeStations(container)).toEqual(["MFM 澳门", "ZUH 珠海"]);
  expect(screen.getByRole("img", { name: "北京出发，经深圳、香港、澳门、珠海，返回北京的路线；当前 D5，澳门、珠海已高亮" })).toBeVisible();

  rerender(<TravelPassHero trip={trip} selectedDayId="day-6" />);

  expect(activeStations(container)).toEqual(["ZUH 珠海", "PEK 北京"]);
  const beijingStations = container.querySelectorAll('[data-station="PEK 北京"]');
  expect(beijingStations[0]).not.toHaveAttribute("data-active");
  expect(beijingStations[1]).toHaveAttribute("data-active", "true");
  expect(container.querySelector('[data-station="MFM 澳门"]')).not.toHaveAttribute("data-active");
  expect(screen.getByRole("img", { name: "北京出发，经深圳、香港、澳门、珠海，返回北京的路线；当前 D6，珠海、北京已高亮" })).toBeVisible();
});

test("falls back to day 1 for both the ticket and active station when the selected day is invalid", () => {
  const { container } = render(<TravelPassHero trip={trip} selectedDayId="missing-day" />);

  expect(screen.getByText("D1 · 2026.10.03 · 深圳")).toBeVisible();
  expect(activeStations(container)).toEqual(["SZX 深圳"]);
});

test("does not highlight a route station for an unknown city", () => {
  const unknownCityTrip: Trip = {
    ...trip,
    days: [{ id: "day-guangzhou", date: "2026-10-03", city: "广州", itemIds: [] }],
  };

  const { container } = render(<TravelPassHero trip={unknownCityTrip} />);

  expect(activeStations(container)).toEqual([]);
  expect(screen.getByRole("img", { name: "北京出发，经深圳、香港、澳门、珠海，返回北京的路线" })).toBeVisible();
});

test("does not treat an inherited cityCodes key as a route station", () => {
  const inheritedKeyTrip: Trip = {
    ...trip,
    days: [{ id: "day-constructor", date: "2026-10-03", city: "constructor", itemIds: [] }],
  };

  const { container } = render(<TravelPassHero trip={inheritedKeyTrip} />);

  expect(activeStations(container)).toEqual([]);
  expect(screen.getByRole("img", { name: "北京出发，经深圳、香港、澳门、珠海，返回北京的路线" })).toBeVisible();
});

test("announces and highlights a repeated city only once", () => {
  const repeatedCityTrip: Trip = {
    ...trip,
    days: [{ id: "day-repeated-macau", date: "2026-10-03", city: "澳门 / 澳门", itemIds: [] }],
  };

  const { container } = render(<TravelPassHero trip={repeatedCityTrip} />);

  expect(activeStations(container)).toEqual(["MFM 澳门"]);
  expect(screen.getByRole("img", { name: "北京出发，经深圳、香港、澳门、珠海，返回北京的路线；当前 D1，澳门已高亮" })).toBeVisible();
});

test("prints the first applicable day on the ticket with pass details and structural hooks", () => {
  const { container } = render(<TravelPassHero trip={trip} member={member} />);

  expect(screen.getByText("TRIP PASS")).toBeVisible();
  expect(screen.getByText("PRIVATE JOURNEY")).toBeVisible();
  expect(screen.getByLabelText("PEK 北京出发")).toBeVisible();
  expect(screen.getByLabelText("SZX 第一站·深圳")).toBeVisible();
  expect(container.querySelector(".travel-pass-hero__leg-code")).toHaveTextContent("PEK");
  expect(container.querySelector(".travel-pass-hero__leg-caption")).toHaveTextContent("北京出发");
  expect(screen.getByText("D1 · 2026.10.03 · 深圳")).toBeVisible();
  expect(screen.getByText("一鸣 / 美垚")).toBeVisible();
  expect(screen.getByText(/PASS NO\. SOUTHB/)).toBeVisible();
  expect(screen.getByTestId("travel-pass-perforation")).toBeInTheDocument();
  expect(screen.getAllByTestId("travel-pass-notch")).toHaveLength(2);
  expect(screen.getByTestId("travel-pass-stamp")).toHaveTextContent("D1");
});

test("uses the trip start date and first city fallback without creating a PEK-to-PEK leg", () => {
  const noDaysTrip: Trip = { ...trip, startDate: "2026-10-03", days: [] };

  const { container } = render(<TravelPassHero trip={noDaysTrip} />);

  expect(screen.getByLabelText("SZX 第一站·深圳")).toBeVisible();
  expect(screen.getByText("D1 · 2026.10.03 · 深圳")).toBeVisible();
  expect(screen.queryByLabelText("PEK 第一站·北京")).not.toBeInTheDocument();
  expect(activeStations(container)).toEqual(["SZX 深圳"]);
  expect(screen.getByRole("img", { name: "北京出发，经深圳、香港、澳门、珠海，返回北京的路线；当前 D1，深圳已高亮" })).toBeVisible();
});

test("uses the selected final day to print the ZUH-to-PEK return leg and date", () => {
  const returnTrip: Trip = {
    ...trip,
    endDate: "2026-10-08",
  };

  render(<TravelPassHero trip={returnTrip} selectedDayId="day-6" />);

  expect(screen.getByLabelText("ZUH 珠海出发")).toBeVisible();
  expect(screen.getByLabelText("PEK 返回·北京")).toBeVisible();
  expect(screen.getByText("D6 · 2026.10.08 · 珠海 / 北京")).toBeVisible();
  expect(screen.getByTestId("travel-pass-stamp")).toHaveTextContent("D6");
});
