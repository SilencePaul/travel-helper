import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Trip, TripChange, TripRepository } from "@travel/contracts";
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
  orders: [],
  version: 0,
};

const threeDayTrip: Trip = {
  ...eightDayTrip,
  id: "trip-three-days",
  endDate: "2026-10-05",
  days: eightDayTrip.days.slice(0, 3).map((day) => ({ ...day, itemIds: [] })),
};

class DelayedSaveRepository implements TripRepository {
  readonly saveRequests: Array<{
    next: Trip;
    expectedVersion: number;
    resolve: (trip: Trip) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  private readonly listeners = new Set<(change: TripChange) => void>();
  private readonly trip: Trip;

  constructor(trip: Trip) {
    this.trip = trip;
  }

  async load() {
    return structuredClone(this.trip);
  }

  save(next: Trip, expectedVersion: number) {
    return new Promise<Trip>((resolve, reject) => {
      this.saveRequests.push({ next, expectedVersion, resolve, reject });
    });
  }

  subscribe(_tripId: string, onChange: (change: TripChange) => void) {
    this.listeners.add(onChange);
    return () => this.listeners.delete(onChange);
  }
}

function mockDayStripLayout() {
  const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
  const rect = (left: number, width: number, height = 146) => ({
    x: left,
    y: 0,
    top: 0,
    right: left + width,
    bottom: height,
    left,
    width,
    height,
    toJSON: () => ({}),
  }) as DOMRect;

  return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("day-strip")) return rect(0, 512);
      if (this.classList.contains("day-tab-wrap")) {
        const index = this.parentElement
          ? Array.from(this.parentElement.children).indexOf(this)
          : 0;
        return rect(index * 174, 164);
      }
      return originalGetBoundingClientRect.call(this);
    });
}

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
  expect(screen.getByRole("heading", { name: "两个人，一条向南的路线。" })).toBeVisible();
  expect(screen.getByText("一鸣 / 美垚")).toBeVisible();
  expect(screen.getAllByText("待预报").length).toBeGreaterThan(0);
  expect(screen.queryByText("暂无订单数据")).not.toBeInTheDocument();
  expect(screen.queryByText("尚未录入订单")).not.toBeInTheDocument();
  expect(screen.queryByText("预算待完善")).not.toBeInTheDocument();
  expect(screen.queryByText("预订待完善")).not.toBeInTheDocument();
  expect(screen.getByRole("tab", { name: /D1/ })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tab", { name: /D1/ })).toHaveAttribute("tabindex", "0");
  expect(screen.getByRole("tab", { name: /D2/ })).toHaveAttribute("tabindex", "-1");
  const panel = screen.getByRole("tabpanel");
  expect(screen.getByRole("tab", { name: /D1/ })).toHaveAttribute("aria-controls", panel.id);
  expect(panel).toHaveAttribute("aria-labelledby", screen.getByRole("tab", { name: /D1/ }).id);

  screen.getByRole("tab", { name: /D1/ }).focus();
  fireEvent.keyDown(screen.getByRole("tab", { name: /D1/ }), { key: "ArrowRight" });
  expect(screen.getByRole("tab", { name: /D2/ })).toHaveFocus();
  expect(screen.getByRole("tab", { name: /D1/ })).toHaveAttribute("tabindex", "-1");
  expect(screen.getByRole("tab", { name: /D2/ })).toHaveAttribute("tabindex", "0");
  fireEvent.keyDown(screen.getByRole("tab", { name: /D2/ }), { key: "End" });
  expect(screen.getByRole("tab", { name: /D8/ })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole("tab", { name: /D8/ }), { key: "Home" });
  expect(screen.getByRole("tab", { name: /D1/ })).toHaveFocus();

  await userEvent.click(screen.getByRole("tab", { name: /D3/ }));
  expect(onSelectDay).toHaveBeenCalledWith("day-3");
});

test("synchronizes the travel pass ticket with the selected day", () => {
  const returnTrip: Trip = {
    ...eightDayTrip,
    days: [
      { id: "day-1", date: "2026-10-03", city: "深圳", itemIds: [] },
      { id: "day-2", date: "2026-10-04", city: "香港", itemIds: [] },
      { id: "day-3", date: "2026-10-05", city: "香港", itemIds: [] },
      { id: "day-4", date: "2026-10-06", city: "澳门", itemIds: [] },
      { id: "day-5", date: "2026-10-07", city: "澳门 / 珠海", itemIds: [] },
      { id: "day-6", date: "2026-10-08", city: "珠海 / 北京", itemIds: [] },
    ],
  };
  const props = {
    trip: returnTrip,
    onSelectDay: () => undefined,
    onAddDay: () => undefined,
    onDuplicateDay: () => undefined,
    onDeleteDay: () => undefined,
    onMoveDay: () => undefined,
  };
  const view = render(<OverviewPage {...props} selectedDayId="day-1" />);

  expect(screen.getByLabelText("SZX 第一站·深圳")).toBeVisible();

  view.rerender(<OverviewPage {...props} selectedDayId="day-6" />);
  expect(screen.getByLabelText("ZUH 珠海出发")).toBeVisible();
  expect(screen.getByLabelText("PEK 返回·北京")).toBeVisible();
  expect(screen.getByText("D6 · 2026.10.08 · 珠海 / 北京")).toBeVisible();
});

test("keeps day selection on the travel pass and opens details separately", async () => {
  const user = userEvent.setup();
  const trip: Trip = {
    ...eightDayTrip,
    id: "trip-day-selection",
    endDate: "2026-10-08",
    days: eightDayTrip.days.slice(0, 6).map((day, index) => index === 5
      ? { ...day, city: "珠海 / 北京" }
      : day),
  };
  const repository = new LocalTripRepository(trip);
  window.history.replaceState({}, "", "/");
  try {
    render(<App repository={repository} tripId={trip.id} />);

    await user.click(await screen.findByRole("tab", { name: /D6/ }));

    expect(window.location.pathname).toBe("/");
    expect(screen.getByText("D6 · 2026.10.08 · 珠海 / 北京")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "查看当天详情" }));

    expect(window.location.pathname).toBe("/day/day-6");
    expect(await screen.findByRole("heading", { name: "珠海 / 北京" })).toBeVisible();
  } finally {
    window.history.replaceState({}, "", "/");
  }
});

test("exposes the travel actions in text navigation and calls their original callbacks", async () => {
  const user = userEvent.setup();
  const onOpenHotels = vi.fn();
  const onOpenDecisions = vi.fn();
  const onManageMembers = vi.fn();
  const onLogout = vi.fn();

  render(
    <OverviewPage
      trip={threeDayTrip}
      selectedDayId="day-1"
      onSelectDay={() => undefined}
      onAddDay={() => undefined}
      onDuplicateDay={() => undefined}
      onDeleteDay={() => undefined}
      onMoveDay={() => undefined}
      onOpenHotels={onOpenHotels}
      onOpenDecisions={onOpenDecisions}
      member={{ uid: "member-yiming", displayName: "一鸣", role: "admin", version: 0, createdAt: "2026-08-28T00:00:00.000Z" }}
      onManageMembers={onManageMembers}
      onLogout={onLogout}
    />,
  );

  const navigation = screen.getByRole("navigation", { name: "行程操作" });
  expect(screen.getByText("行程")).toHaveClass("text-navigation__current");
  expect(navigation).toHaveTextContent("酒店比较");
  expect(navigation).toHaveTextContent("共同决定");
  expect(navigation).toHaveTextContent("成员管理");
  expect(navigation).toHaveTextContent("退出登录");
  expect(screen.getByRole("button", { name: "新增一天" })).toBeVisible();
  expect(screen.getByRole("button", { name: "复制当天" })).toBeVisible();
  expect(screen.getByRole("button", { name: "删除当天" })).toBeVisible();
  expect(screen.getByRole("button", { name: "酒店比较" })).toHaveClass("control-button", "control-button--text");
  expect(screen.getByRole("button", { name: "新增一天" })).toHaveClass("control-button", "control-button--secondary");
  expect(screen.getByRole("button", { name: "删除当天" })).toHaveClass("control-button", "control-button--danger");

  await user.click(screen.getByRole("button", { name: "酒店比较" }));
  await user.click(screen.getByRole("button", { name: "共同决定" }));
  await user.click(screen.getByRole("button", { name: "成员管理" }));
  await user.click(screen.getByRole("button", { name: "退出登录" }));

  expect(onOpenHotels).toHaveBeenCalledOnce();
  expect(onOpenDecisions).toHaveBeenCalledOnce();
  expect(onManageMembers).toHaveBeenCalledOnce();
  expect(onLogout).toHaveBeenCalledOnce();
});

test("moves focus to the destination main after route navigation", async () => {
  const user = userEvent.setup();
  const repository = new LocalTripRepository(threeDayTrip);
  window.history.replaceState({}, "", "/");
  try {
    render(<App repository={repository} tripId={threeDayTrip.id} />);
    await user.click(await screen.findByRole("button", { name: "查看当天详情" }));

    const destination = await screen.findByRole("main");
    await waitFor(() => expect(destination).toHaveFocus());
    expect(destination).toHaveAttribute("tabindex", "-1");
  } finally {
    window.history.replaceState({}, "", "/");
  }
});

test("warns about removed hotel and ticket orders before a date reduction, then keeps the orders", async () => {
  const user = userEvent.setup();
  const tripWithOrders: Trip = {
    ...threeDayTrip,
    orders: [
      { id: "hotel-order", name: "香港酒店", category: "hotel", estimated: 100000, paid: 0, currency: "HKD", status: "unpaid", dayId: "day-3" },
      { id: "ticket-order", name: "山顶缆车", category: "ticket", estimated: 21600, paid: 0, currency: "HKD", status: "unpaid", dayId: "day-3" },
    ],
  };
  const repository = new LocalTripRepository(tripWithOrders);
  render(<App repository={repository} tripId={tripWithOrders.id} />);

  await screen.findByRole("button", { name: "更新日期" });
  fireEvent.change(screen.getByLabelText("结束日期"), { target: { value: "2026-10-04" } });
  await user.click(screen.getByRole("button", { name: "更新日期" }));

  const warningDialog = await screen.findByRole("dialog", { name: "这些订单关联的旅行日将被移除" });
  const keepDateButton = screen.getByRole("button", { name: "保留当前日期" });
  const confirmDateButton = screen.getByRole("button", { name: "仍然调整日期" });
  expect(warningDialog).toBeVisible();
  expect(warningDialog).toHaveAccessibleDescription("订单不会自动删除或改写。确认后只调整日期与行程日，请随后核对订单。");
  expect(keepDateButton).toHaveFocus();
  await user.keyboard("{Tab}");
  expect(confirmDateButton).toHaveFocus();
  await user.keyboard("{Shift>}{Tab}{/Shift}");
  expect(keepDateButton).toHaveFocus();
  let dialogWasOpenWhenTriggerFocused: boolean | undefined;
  const updateDateButton = screen.getByRole("button", { name: "更新日期" });
  updateDateButton.addEventListener("focus", () => { dialogWasOpenWhenTriggerFocused = warningDialog.hasAttribute("open"); }, { once: true });
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "这些订单关联的旅行日将被移除" })).not.toBeInTheDocument();
  await waitFor(() => expect(updateDateButton).toHaveFocus());
  expect(dialogWasOpenWhenTriggerFocused).toBe(false);
  await user.click(updateDateButton);
  await screen.findByRole("dialog", { name: "这些订单关联的旅行日将被移除" });
  expect(screen.getByText("酒店 · 香港酒店")).toBeVisible();
  expect(screen.getByText("门票 · 山顶缆车")).toBeVisible();
  await expect(repository.load(tripWithOrders.id)).resolves.toMatchObject({ version: 0, days: [{ id: "day-1" }, { id: "day-2" }, { id: "day-3" }] });

  await user.click(screen.getByRole("button", { name: "仍然调整日期" }));
  await waitFor(async () => {
    await expect(repository.load(tripWithOrders.id)).resolves.toMatchObject({
      version: 1,
      days: [{ id: "day-1" }, { id: "day-2" }],
      orders: [{ id: "hotel-order" }, { id: "ticket-order" }],
    });
  });
});

test("confirms the captured reviewed date range and keeps the warning retryable after a rejected save", async () => {
  const user = userEvent.setup();
  const tripWithOrders: Trip = {
    ...threeDayTrip,
    orders: [{ id: "hotel-order", name: "香港酒店", category: "hotel", estimated: 100000, paid: 0, currency: "HKD", status: "unpaid", dayId: "day-3" }],
  };
  const repository = new DelayedSaveRepository(tripWithOrders);
  render(<App repository={repository} tripId={tripWithOrders.id} />);

  await screen.findByRole("button", { name: "更新日期" });
  await user.clear(screen.getByLabelText("结束日期"));
  await user.type(screen.getByLabelText("结束日期"), "2026-10-04");
  await user.click(screen.getByRole("button", { name: "更新日期" }));
  await screen.findByRole("dialog", { name: "这些订单关联的旅行日将被移除" });

  // A background field change must not let confirmation apply an unreviewed range.
  await user.clear(screen.getByLabelText("结束日期"));
  await user.type(screen.getByLabelText("结束日期"), "2026-10-03");
  const confirmDateButton = screen.getByRole("button", { name: "仍然调整日期" });
  await user.click(confirmDateButton);
  await waitFor(() => expect(repository.saveRequests).toHaveLength(1));
  expect(repository.saveRequests[0]!.next.endDate).toBe("2026-10-04");
  expect(screen.getByRole("dialog", { name: "这些订单关联的旅行日将被移除" })).toHaveFocus();
  expect(confirmDateButton).toBeDisabled();

  await act(async () => repository.saveRequests[0]!.reject(new Error("offline")));
  const warningDialog = screen.getByRole("dialog", { name: "这些订单关联的旅行日将被移除" });
  expect(screen.getAllByRole("alert").at(-1)).toHaveTextContent("日期修改失败");
  expect(screen.getByLabelText("开始日期")).not.toHaveAttribute("aria-invalid");
  expect(screen.getByLabelText("结束日期")).not.toHaveAttribute("aria-invalid");
  expect(screen.getByLabelText("结束日期")).not.toHaveAccessibleDescription();
  expect(warningDialog).toBeVisible();
  await user.click(screen.getByRole("button", { name: "仍然调整日期" }));
  await waitFor(() => expect(repository.saveRequests).toHaveLength(2));
});

test("revalidates date input errors as either boundary changes", async () => {
  const onChangeDateRange = vi.fn(async () => ({ affectedOrders: [] }));
  const user = userEvent.setup();
  render(
    <OverviewPage
      trip={threeDayTrip}
      selectedDayId="day-1"
      onSelectDay={() => undefined}
      onAddDay={() => undefined}
      onDuplicateDay={() => undefined}
      onDeleteDay={() => undefined}
      onMoveDay={() => undefined}
      onChangeDateRange={onChangeDateRange}
    />,
  );
  const start = screen.getByLabelText("开始日期");
  const end = screen.getByLabelText("结束日期");

  fireEvent.change(end, { target: { value: "2026-10-02" } });
  await user.click(screen.getByRole("button", { name: "更新日期" }));
  expect(end).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByRole("alert")).toHaveTextContent("结束日期不能早于开始日期");

  fireEvent.change(start, { target: { value: "2026-10-01" } });
  expect(start).not.toHaveAttribute("aria-invalid");
  expect(end).not.toHaveAttribute("aria-invalid");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();

  fireEvent.change(start, { target: { value: "2026-10-06" } });
  await user.click(screen.getByRole("button", { name: "更新日期" }));
  expect(start).toHaveAttribute("aria-invalid", "true");
  fireEvent.change(end, { target: { value: "2026-10-07" } });
  expect(start).not.toHaveAttribute("aria-invalid");
  expect(end).not.toHaveAttribute("aria-invalid");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(onChangeDateRange).not.toHaveBeenCalled();
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
  expect(screen.queryByText("待安排内容（1）")).not.toBeInTheDocument();
  const afterSharedDelete = await repository.load(eightDayTrip.id);
  expect(afterSharedDelete).toMatchObject({
    version: 2,
    unscheduledItemIds: [],
  });
  expect(afterSharedDelete.days.flatMap((day) => day.itemIds)).toContain("place-window");

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

test("disables every mutation control and exposes failure while a save is pending", async () => {
  const user = userEvent.setup();
  const repository = new DelayedSaveRepository(threeDayTrip);
  render(<App repository={repository} tripId={threeDayTrip.id} />);

  await user.click(await screen.findByRole("button", { name: "新增一天" }));
  await waitFor(() => expect(repository.saveRequests).toHaveLength(1));

  expect(screen.getByRole("button", { name: "新增一天" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "复制当天" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "删除当天" })).toBeDisabled();
  for (const handle of screen.getAllByRole("button", { name: /拖动 D\d/ })) {
    expect(handle).toBeEnabled();
    expect(handle).toHaveAttribute("aria-disabled", "true");
  }

  await user.click(screen.getByRole("button", { name: "新增一天" }));
  await user.click(screen.getByRole("button", { name: "复制当天" }));
  expect(repository.saveRequests).toHaveLength(1);

  await act(async () => repository.saveRequests[0]!.reject(new Error("offline")));
  expect(await screen.findByText("保存失败，请重试")).toBeVisible();
});

test("restores direct-route selection and chooses the next day after middle deletion", async () => {
  const user = userEvent.setup();
  const repository = new LocalTripRepository(threeDayTrip);
  window.history.replaceState({}, "", "/day/day-2");
  render(<App repository={repository} tripId={threeDayTrip.id} />);

  await user.click(await screen.findByRole("button", { name: /返回行程总览/ }));
  expect(await screen.findByRole("tab", { name: /D2/ })).toHaveAttribute("aria-selected", "true");
  await user.click(screen.getByRole("button", { name: "删除当天" }));
  await user.click(screen.getByRole("button", { name: "确认删除" }));

  await waitFor(() => {
    const nextTab = screen.getByRole("tab", { name: /2026-10-05/ });
    expect(nextTab).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(nextTab).toHaveFocus();
  });
});

test("chooses the previous day after deleting the selected last day", async () => {
  const user = userEvent.setup();
  const repository = new LocalTripRepository(threeDayTrip);
  window.history.replaceState({}, "", "/day/day-3");
  render(<App repository={repository} tripId={threeDayTrip.id} />);

  await user.click(await screen.findByRole("button", { name: /返回行程总览/ }));
  expect(await screen.findByRole("tab", { name: /D3/ })).toHaveAttribute("aria-selected", "true");
  await user.click(await screen.findByRole("button", { name: "删除当天" }));
  await user.click(screen.getByRole("button", { name: "确认删除" }));

  await waitFor(() => {
    expect(screen.getByRole("tab", { name: /2026-10-04/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

test("moves uniquely removed item IDs into the unscheduled list", async () => {
  const user = userEvent.setup();
  const populatedTrip: Trip = {
    ...threeDayTrip,
    id: "trip-populated-day",
    days: threeDayTrip.days.map((day, index) => ({
      ...day,
      itemIds: index === 0 ? ["place-unique"] : [],
    })),
  };
  const repository = new LocalTripRepository(populatedTrip);
  window.history.replaceState({}, "", "/");
  render(<App repository={repository} tripId={populatedTrip.id} />);

  await user.click(await screen.findByRole("button", { name: "删除当天" }));
  await user.click(screen.getByRole("button", { name: "确认删除" }));

  expect(await screen.findByText("待安排内容（1）")).toBeVisible();
  expect(screen.getByText("place-unique")).toBeVisible();
});

test("traps confirmation focus, closes on Escape, and restores focus", async () => {
  const user = userEvent.setup();
  const onDeleteDay = vi.fn(async () => undefined);
  render(
    <OverviewPage
      trip={threeDayTrip}
      selectedDayId="day-2"
      onSelectDay={() => undefined}
      onAddDay={() => undefined}
      onDuplicateDay={() => undefined}
      onDeleteDay={onDeleteDay}
      onMoveDay={() => undefined}
    />,
  );
  const trigger = screen.getByRole("button", { name: "删除当天" });

  await user.click(trigger);
  const dialog = screen.getByRole("alertdialog", { name: /删除 D2/ });
  expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();

  await user.click(trigger);
  await user.keyboard("{Tab}");
  expect(screen.getByRole("button", { name: "确认删除" })).toHaveFocus();
  await user.keyboard("{Shift>}{Tab}{/Shift}");
  expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "确认删除" }));
  expect(onDeleteDay).toHaveBeenCalledOnce();
  await waitFor(() => expect(screen.getByRole("tab", { name: /D2/ })).toHaveFocus());
});

test("keeps a native modal open and focus contained until deletion completes", async () => {
  const user = userEvent.setup();
  let finishDelete!: () => void;
  const onDeleteDay = vi.fn(() => new Promise<void>((resolve) => {
    finishDelete = resolve;
  }));
  const whitespaceIdTrip: Trip = {
    ...threeDayTrip,
    days: threeDayTrip.days.map((day, index) =>
      index === 0 ? { ...day, id: "day with whitespace" } : day),
  };
  render(
    <OverviewPage
      trip={whitespaceIdTrip}
      selectedDayId="day with whitespace"
      onSelectDay={() => undefined}
      onAddDay={() => undefined}
      onDuplicateDay={() => undefined}
      onDeleteDay={onDeleteDay}
      onMoveDay={() => undefined}
    />,
  );

  await user.click(screen.getByRole("button", { name: "删除当天" }));
  const dialog = screen.getByRole("alertdialog", { name: /删除 D1/ });
  expect(dialog.tagName).toBe("DIALOG");
  expect(dialog).toHaveAttribute("open");
  const labelledBy = dialog.getAttribute("aria-labelledby")!;
  expect(labelledBy).not.toMatch(/\s/);
  expect(document.getElementById(labelledBy)).toHaveTextContent("删除 D1");

  await user.click(screen.getByRole("button", { name: "确认删除" }));
  expect(onDeleteDay).toHaveBeenCalledOnce();
  expect(screen.getByRole("alertdialog")).toBe(dialog);
  expect(dialog).toHaveAttribute("open");
  expect(dialog).toHaveFocus();
  await user.keyboard("{Escape}{Tab}");
  expect(screen.getByRole("alertdialog")).toBe(dialog);
  expect(dialog).toHaveFocus();

  await act(async () => finishDelete());
  await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  expect(screen.getByRole("tab", { name: /D1/ })).toHaveFocus();
});

test("retains the modal and reports a rejected deletion", async () => {
  const user = userEvent.setup();
  const onDeleteDay = vi.fn(async (_dayId: string) => {
    throw new Error("无法删除这个旅行日");
  });
  render(
    <OverviewPage
      trip={threeDayTrip}
      selectedDayId="day-2"
      onSelectDay={() => undefined}
      onAddDay={() => undefined}
      onDuplicateDay={() => undefined}
      onDeleteDay={onDeleteDay}
      onMoveDay={() => undefined}
    />,
  );

  await user.click(screen.getByRole("button", { name: "删除当天" }));
  await user.click(screen.getByRole("button", { name: "确认删除" }));

  expect(onDeleteDay).toHaveBeenCalledWith("day-2");
  expect(await screen.findByRole("alert")).toHaveTextContent("无法删除这个旅行日");
  expect(screen.getByRole("alertdialog", { name: /删除 D2/ })).toHaveAttribute("open");
  expect(screen.getByRole("alertdialog")).toHaveFocus();
});

test("does not delete a different day when an external update removes the modal target", async () => {
  const user = userEvent.setup();
  const repository = new LocalTripRepository(threeDayTrip);
  window.history.replaceState({}, "", "/");
  render(<App repository={repository} tripId={threeDayTrip.id} />);

  await user.click(await screen.findByRole("button", { name: "删除当天" }));
  const external = await repository.load(threeDayTrip.id);
  await act(async () => {
    await repository.save({
      ...external,
      startDate: external.days[1]!.date,
      days: external.days.slice(1),
    }, external.version);
  });
  await user.click(screen.getByRole("button", { name: "确认删除" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("旅行日已不存在");
  expect(screen.getByRole("alertdialog", { name: /删除 D1/ })).toHaveAttribute("open");
  await expect(repository.load(threeDayTrip.id)).resolves.toMatchObject({
    version: 1,
    days: [{ id: "day-2" }, { id: "day-3" }],
  });
});

test("syncs the roving tab stop to controlled selection changes", () => {
  const props = {
    trip: threeDayTrip,
    onSelectDay: () => undefined,
    onAddDay: () => undefined,
    onDuplicateDay: () => undefined,
    onDeleteDay: () => undefined,
    onMoveDay: () => undefined,
  };
  const view = render(<OverviewPage {...props} selectedDayId="day-1" />);
  expect(screen.getByRole("tab", { name: /D1/ })).toHaveAttribute("tabindex", "0");

  view.rerender(<OverviewPage {...props} selectedDayId="day-2" />);
  expect(screen.getByRole("tab", { name: /D1/ })).toHaveAttribute("tabindex", "-1");
  expect(screen.getByRole("tab", { name: /D2/ })).toHaveAttribute("tabindex", "0");

  screen.getByRole("tab", { name: /D2/ }).focus();
  fireEvent.keyDown(screen.getByRole("tab", { name: /D2/ }), { key: "ArrowRight" });
  expect(screen.getByRole("tab", { name: /D3/ })).toHaveAttribute("tabindex", "0");
  view.rerender(<OverviewPage {...props} trip={{ ...threeDayTrip }} selectedDayId="day-2" />);
  expect(screen.getByRole("tab", { name: /D3/ })).toHaveAttribute("tabindex", "0");

  view.rerender(<OverviewPage {...props} selectedDayId="day-1" />);
  view.rerender(<OverviewPage {...props} selectedDayId="day-2" />);
  expect(screen.getByRole("tab", { name: /D2/ })).toHaveAttribute("tabindex", "0");
  expect(screen.getByRole("tab", { name: /D3/ })).toHaveAttribute("tabindex", "-1");
});

test("persists a dnd-kit keyboard reorder by stable day ID", async () => {
  const layoutSpy = mockDayStripLayout();
  const user = userEvent.setup();
  const repository = new LocalTripRepository(threeDayTrip);
  window.history.replaceState({}, "", "/");
  try {
    render(<App repository={repository} tripId={threeDayTrip.id} />);

    const firstHandle = await screen.findByRole("button", { name: "拖动 D1" });
    firstHandle.focus();
    await user.keyboard(" ");
    await waitFor(() => expect(firstHandle).toHaveAttribute("aria-pressed", "true"));
    await user.keyboard("{ArrowRight}");
    await screen.findByText(/Draggable item day-1 was moved over droppable area day-2/);
    await user.keyboard(" ");

    await waitFor(async () => {
      await expect(repository.load(threeDayTrip.id)).resolves.toMatchObject({
        version: 1,
        days: [
          { id: "day-2", date: "2026-10-03" },
          { id: "day-1", date: "2026-10-04" },
          { id: "day-3", date: "2026-10-05" },
        ],
      });
    });
  } finally {
    layoutSpy.mockRestore();
  }
});

test("keeps the dropped drag handle focused throughout a delayed save", async () => {
  const layoutSpy = mockDayStripLayout();
  const user = userEvent.setup();
  const repository = new DelayedSaveRepository(threeDayTrip);
  window.history.replaceState({}, "", "/");
  try {
    render(<App repository={repository} tripId={threeDayTrip.id} />);
    const firstHandle = await screen.findByRole("button", { name: "拖动 D1" });
    firstHandle.focus();
    await user.keyboard(" ");
    await waitFor(() => expect(firstHandle).toHaveAttribute("aria-pressed", "true"));
    await user.keyboard("{ArrowRight}");
    await screen.findByText(/Draggable item day-1 was moved over droppable area day-2/);
    await user.keyboard(" ");
    await waitFor(() => expect(repository.saveRequests).toHaveLength(1));

    expect(screen.getByRole("button", { name: "拖动 D1" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "拖动 D1" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("button", { name: "拖动 D1" })).toHaveFocus();
    await act(async () => repository.saveRequests[0]!.resolve({
      ...repository.saveRequests[0]!.next,
      version: 1,
    }));
    expect(screen.getByRole("button", { name: "拖动 D2" })).toHaveFocus();
  } finally {
    layoutSpy.mockRestore();
  }
});
