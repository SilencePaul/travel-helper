import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { BudgetItem } from "@travel/contracts";
import { OrdersPanel } from "./OrdersPanel";

const orders: BudgetItem[] = [{ id: "ticket", name: "山顶缆车", category: "ticket", estimated: 21600, paid: 0, currency: "HKD", status: "unpaid", dayId: "day-2" }];

test("sends status changes to its repository-backed callback", async () => {
  const user = userEvent.setup();
  const onStatusChange = vi.fn();
  render(<OrdersPanel orders={orders} onStatusChange={onStatusChange} />);
  await user.selectOptions(screen.getByLabelText("山顶缆车状态"), "paid");
  expect(onStatusChange).toHaveBeenCalledWith("ticket", "paid");
});

test("does not offer an invalid partial transition without a paid amount", () => {
  render(<OrdersPanel orders={orders} onStatusChange={() => undefined} />);
  const select = screen.getByLabelText("山顶缆车状态");
  expect(screen.getByRole("option", { name: "部分支付" })).toBeDisabled();
  expect(select).toHaveAccessibleDescription("请先录入介于 0 与预计金额之间的已付金额，才能标记为部分支付。");
});
