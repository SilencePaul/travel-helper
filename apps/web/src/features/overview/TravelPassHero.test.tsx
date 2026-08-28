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

test("renders the editorial heading and continuous labelled southbound route", () => {
  const { container } = render(<TravelPassHero trip={trip} member={member} />);

  expect(screen.getByRole("heading", { name: "两个人，一条向南的路线。" })).toBeVisible();
  expect(container.querySelector(".travel-pass-hero__heading-emphasis")).toHaveTextContent("一条向南的路线。");

  const route = screen.getByLabelText("北京出发，经深圳、香港、澳门、珠海，返回北京的路线");
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

test("prints the first applicable day on the ticket with pass details and structural hooks", () => {
  render(<TravelPassHero trip={trip} member={member} />);

  expect(screen.getByText("TRIP PASS")).toBeVisible();
  expect(screen.getByText("PRIVATE JOURNEY")).toBeVisible();
  expect(screen.getByText("PEK 北京出发")).toBeVisible();
  expect(screen.getByText("SZX 第一站·深圳")).toBeVisible();
  expect(screen.getByText("D1 · 2026.10.03 · 深圳")).toBeVisible();
  expect(screen.getByText("一鸣 / 美垚")).toBeVisible();
  expect(screen.getByText(/PASS NO\. SOUTHB/)).toBeVisible();
  expect(screen.getByTestId("travel-pass-perforation")).toBeInTheDocument();
  expect(screen.getAllByTestId("travel-pass-notch")).toHaveLength(2);
  expect(screen.getByTestId("travel-pass-stamp")).toHaveTextContent("D1");
});

test("uses the trip start date and first city fallback without creating a PEK-to-PEK leg", () => {
  const noDaysTrip: Trip = { ...trip, startDate: "2026-10-03", days: [] };

  render(<TravelPassHero trip={noDaysTrip} />);

  expect(screen.getByText("SZX 第一站·深圳")).toBeVisible();
  expect(screen.getByText("D1 · 2026.10.03 · 深圳")).toBeVisible();
  expect(screen.queryByText("PEK 第一站·北京")).not.toBeInTheDocument();
});
