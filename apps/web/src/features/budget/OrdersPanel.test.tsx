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
