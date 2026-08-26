import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Trip } from "@travel/contracts";
import { expect, test, vi } from "vitest";
import App from "../../App";
import { LocalTripRepository } from "../../infrastructure/localTripRepository";
import { OverviewPage } from "./OverviewPage";

const eightDayTrip: Trip = {
  id: "trip-eight-days",
  title: "2026 十一深港澳珠旅行",
  startDate: "2026-10-03",
  endDate: "2026-10-10",
  travelers: [
    { id: "traveler-yiming", name: "一鸣" },
    { id: "traveler-meiyao", name: "美垚" },
  ],
  days: Array.from({ length: 8 }, (_, index) => ({
    id: `day-${index + 1}`,
    date: `2026-10-${String(index + 3).padStart(2, "0")}`,
    city: index === 0 ? "深圳" : "香港",
    itemIds: index === 0 ? ["place-window"] : [],
  })),
  unscheduledItemIds: [],
  version: 0,
};

const threeDayTrip: Trip = {
  ...eightDayTrip,
  id: "trip-three-days",
  endDate: "2026-10-05",
  days: eightDayTrip.days.slice(0, 3).map((day) => ({ ...day, itemIds: [] })),
};

test("renders every dynamic travel day and traveler", async () => {
  const onSelectDay = vi.fn();

  render(
    <OverviewPage
      trip={eightDayTrip}
      selectedDayId="day-1"
      onSelectDay={onSelectDay}
      onAddDay={() => undefined}
      onDuplicateDay={() => undefined}
      onDeleteDay={() => undefined}
      onMoveDay={() => undefined}
    />,
  );

  expect(screen.getAllByRole("tab", { name: /D\d/ })).toHaveLength(8);
  expect(screen.getByText("一鸣 / 美垚")).toBeVisible();
  expect(screen.getAllByText("待预报").length).toBeGreaterThan(0);
  expect(screen.getByText("预算数据尚未接入")).toBeVisible();
  expect(screen.getByText("预订数据尚未接入")).toBeVisible();
  expect(screen.queryByText("预算待完善")).not.toBeInTheDocument();
  expect(screen.queryByText("预订待完善")).not.toBeInTheDocument();
  expect(screen.getByRole("tab", { name: /D1/ })).toHaveAttribute("aria-selected", "true");

  await userEvent.click(screen.getByRole("tab", { name: /D3/ }));
  expect(onSelectDay).toHaveBeenCalledWith("day-3");
});

test("persists day controls and keeps removed items available to arrange", async () => {
  const user = userEvent.setup();
  const repository = new LocalTripRepository(eightDayTrip);

  render(
    <App
      repository={repository}
      tripId={eightDayTrip.id}
      createDayId={() => "day-ui-copy"}
    />,
  );

  expect(await screen.findByRole("button", { name: "新增一天" })).toBeVisible();
  expect(screen.getByRole("button", { name: "复制当天" })).toBeVisible();
  expect(screen.getByRole("button", { name: "删除当天" })).toBeVisible();

  await user.click(screen.getByRole("button", { name: "复制当天" }));
  await waitFor(() => expect(screen.getAllByRole("tab", { name: /D\d/ })).toHaveLength(9));
  await expect(repository.load(eightDayTrip.id)).resolves.toMatchObject({ version: 1 });

  await user.click(screen.getByRole("button", { name: "删除当天" }));
  expect(screen.getByText("确定删除 D1 吗？")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "确认删除" }));

  await waitFor(() => expect(screen.getAllByRole("tab", { name: /D\d/ })).toHaveLength(8));
  expect(screen.getByText("待安排内容（1）")).toBeVisible();
  expect(screen.getByText("place-window")).toBeVisible();
  await expect(repository.load(eightDayTrip.id)).resolves.toMatchObject({
    version: 2,
    unscheduledItemIds: ["place-window"],
  });

  await user.click(screen.getByRole("button", { name: "新增一天" }));
  await waitFor(() => expect(screen.getAllByRole("tab", { name: /D\d/ })).toHaveLength(9));
  await expect(repository.load(eightDayTrip.id)).resolves.toMatchObject({ version: 3 });
});

test("appends after the last calendar date without shifting dates across a deletion gap", async () => {
  const user = userEvent.setup();
  const repository = new LocalTripRepository(threeDayTrip);

  render(
    <App
      repository={repository}
      tripId={threeDayTrip.id}
      createDayId={() => "day-new"}
    />,
  );

  await user.click(await screen.findByRole("tab", { name: /D2/ }));
  await user.click(await screen.findByRole("button", { name: /返回行程总览/ }));
  await user.click(await screen.findByRole("button", { name: "删除当天" }));
  await user.click(screen.getByRole("button", { name: "确认删除" }));

  await waitFor(async () => {
    await expect(repository.load(threeDayTrip.id)).resolves.toMatchObject({
      version: 1,
      days: [
        { id: "day-1", date: "2026-10-03" },
        { id: "day-3", date: "2026-10-05" },
      ],
    });
  });

  await user.click(screen.getByRole("button", { name: "新增一天" }));

  await waitFor(async () => {
    await expect(repository.load(threeDayTrip.id)).resolves.toMatchObject({
      version: 2,
      endDate: "2026-10-06",
      days: [
        { id: "day-1", date: "2026-10-03" },
        { id: "day-3", date: "2026-10-05" },
        { id: "day-new", date: "2026-10-06", city: "", itemIds: [] },
      ],
    });
  });
});
