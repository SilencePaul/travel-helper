import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { BudgetItem } from "@travel/contracts";
import { OrdersPanel } from "./OrdersPanel";

const orders: BudgetItem[] = [{ id: "ticket", name: "山顶缆车", category: "ticket", estimated: 21600, paid: 0, currency: "HKD", status: "unpaid", dayId: "day-2" }];
const secondOrder: BudgetItem = { ...orders[0]!, id: "ferry", name: "港澳船票" };

test("sends status changes to its repository-backed callback", async () => {
  const user = userEvent.setup();
  const onStatusChange = vi.fn();
  render(<OrdersPanel orders={[{ ...orders[0]!, paid: 8000, status: "partial" }]} onStatusChange={onStatusChange} />);
  await user.selectOptions(screen.getByLabelText("山顶缆车状态"), "paid");
  expect(onStatusChange).toHaveBeenCalledWith("ticket", "paid");
});

test("does not offer an invalid partial transition without a paid amount", () => {
  render(<OrdersPanel orders={orders} onStatusChange={() => undefined} />);
  const select = screen.getByLabelText("山顶缆车状态");
  expect(screen.getByRole("option", { name: "部分支付" })).toBeDisabled();
  expect(select).toHaveAccessibleDescription("请先录入实际已付金额，才能标记为部分支付。");
});

test("retains a paid-amount draft and reports an inline error when persistence rejects", async () => {
  const user = userEvent.setup();
  render(<OrdersPanel orders={orders} onStatusChange={() => undefined} onPaidChange={async () => { throw new Error("offline"); }} />);
  const input = screen.getByLabelText("山顶缆车已付金额");
  await user.clear(input);
  await user.type(input, "80");
  await user.click(screen.getByRole("button", { name: "保存 山顶缆车 金额" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("保存付款金额失败");
  expect(input).toHaveValue(80);
});

test("does not save a paid-amount draft merely by blurring the field", async () => {
  const user = userEvent.setup();
  const onPaidChange = vi.fn();
  render(<OrdersPanel orders={orders} onStatusChange={() => undefined} onPaidChange={onPaidChange} />);
  const input = screen.getByLabelText("山顶缆车已付金额");
  await user.clear(input);
  await user.type(input, "80");
  await user.tab();
  expect(onPaidChange).not.toHaveBeenCalled();
});

test("maps amount controls to the shared field and primary action contract", () => {
  render(<OrdersPanel orders={orders} onStatusChange={() => undefined} onPaidChange={() => undefined} />);

  expect(screen.getByLabelText("山顶缆车已付金额")).toHaveClass("control-field");
  expect(screen.getByLabelText("山顶缆车状态")).toHaveClass("control-field");
  expect(screen.getByRole("button", { name: "保存 山顶缆车 金额" })).toHaveClass("control-button", "control-button--primary");
});

test("owns validation, busy, and persistence feedback within the affected order row", async () => {
  let finishSave!: () => void;
  const onPaidChange = vi.fn(() => new Promise<void>((resolve) => { finishSave = resolve; }));
  const user = userEvent.setup();
  render(<OrdersPanel orders={[orders[0]!, secondOrder]} onStatusChange={() => undefined} onPaidChange={onPaidChange} />);

  const firstInput = screen.getByLabelText("山顶缆车已付金额");
  fireEvent.change(firstInput, { target: { value: "1.234" } });
  await user.click(screen.getByRole("button", { name: "保存 山顶缆车 金额" }));

  expect(firstInput).toHaveAttribute("aria-invalid", "true");
  expect(firstInput).toHaveAccessibleDescription("请输入最多两位小数的非负已付金额");
  expect(screen.getByLabelText("港澳船票已付金额")).not.toHaveAttribute("aria-invalid");
  expect(screen.getAllByRole("alert")).toHaveLength(1);

  fireEvent.change(firstInput, { target: { value: "80" } });
  await user.click(screen.getByRole("button", { name: "保存 山顶缆车 金额" }));
  const firstRow = firstInput.closest("li");
  expect(firstRow).toHaveAttribute("aria-busy", "true");
  expect(screen.getByRole("button", { name: "保存 山顶缆车 金额" })).toHaveTextContent("正在保存");
  expect(screen.getByLabelText("山顶缆车状态")).toBeDisabled();

  finishSave();
  expect(await screen.findByText("付款金额已保存")).toBeVisible();
  expect(firstRow).toHaveAttribute("aria-busy", "false");
});

test("returns a reverted amount draft to idle without announcing a save", () => {
  render(<OrdersPanel orders={[{ ...orders[0]!, paid: 8000 }]} onStatusChange={() => undefined} onPaidChange={() => undefined} />);
  const input = screen.getByLabelText("山顶缆车已付金额");
  const row = input.closest("li");

  fireEvent.change(input, { target: { value: "90" } });
  expect(row).toHaveAttribute("data-order-state", "dirty");
  fireEvent.change(input, { target: { value: "80.00" } });

  expect(row).toHaveAttribute("data-order-state", "idle");
  expect(screen.queryByText("付款金额已保存")).not.toBeInTheDocument();
});

test("keeps concurrent order saves independently busy until each settles", async () => {
  const resolvers = new Map<string, () => void>();
  const onPaidChange = vi.fn((orderId: string) => new Promise<void>((resolve) => resolvers.set(orderId, resolve)));
  const user = userEvent.setup();
  render(<OrdersPanel orders={[orders[0]!, secondOrder]} onStatusChange={() => undefined} onPaidChange={onPaidChange} />);

  fireEvent.change(screen.getByLabelText("山顶缆车已付金额"), { target: { value: "80" } });
  fireEvent.change(screen.getByLabelText("港澳船票已付金额"), { target: { value: "60" } });
  await user.click(screen.getByRole("button", { name: "保存 山顶缆车 金额" }));
  await user.click(screen.getByRole("button", { name: "保存 港澳船票 金额" }));

  const firstRow = screen.getByLabelText("山顶缆车已付金额").closest("li");
  const secondRow = screen.getByLabelText("港澳船票已付金额").closest("li");
  expect(firstRow).toHaveAttribute("aria-busy", "true");
  expect(secondRow).toHaveAttribute("aria-busy", "true");
  expect(screen.getByRole("button", { name: "保存 山顶缆车 金额" })).toHaveTextContent("正在保存");
  expect(screen.getByRole("button", { name: "保存 港澳船票 金额" })).toHaveTextContent("正在保存");

  await act(async () => resolvers.get("ticket")?.());
  await waitFor(() => expect(firstRow).toHaveAttribute("aria-busy", "false"));
  expect(secondRow).toHaveAttribute("aria-busy", "true");
  expect(screen.getByLabelText("港澳船票状态")).toBeDisabled();

  await act(async () => resolvers.get("ferry")?.());
  await waitFor(() => expect(secondRow).toHaveAttribute("aria-busy", "false"));
});

test("rejects an amount whose cent value is not a safe integer", async () => {
  const onPaidChange = vi.fn();
  const user = userEvent.setup();
  render(<OrdersPanel orders={orders} onStatusChange={() => undefined} onPaidChange={onPaidChange} />);
  const input = screen.getByLabelText("山顶缆车已付金额");

  fireEvent.change(input, { target: { value: "90071992547409.92" } });
  await user.click(screen.getByRole("button", { name: "保存 山顶缆车 金额" }));

  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(input).toHaveAccessibleDescription("金额过大，无法安全保存到分");
  expect(onPaidChange).not.toHaveBeenCalled();
});

test("keeps two persistence rejections scoped to their own order rows", async () => {
  const user = userEvent.setup();
  render(<OrdersPanel orders={[orders[0]!, secondOrder]} onStatusChange={() => undefined} onPaidChange={async () => { throw new Error("provider detail"); }} />);
  const firstInput = screen.getByLabelText("山顶缆车已付金额");
  const secondInput = screen.getByLabelText("港澳船票已付金额");

  fireEvent.change(firstInput, { target: { value: "80" } });
  fireEvent.change(secondInput, { target: { value: "60" } });
  await user.click(screen.getByRole("button", { name: "保存 山顶缆车 金额" }));
  expect(firstInput).toHaveAccessibleDescription("保存付款金额失败，请重试");
  expect(secondInput).not.toHaveAccessibleDescription();

  await user.click(screen.getByRole("button", { name: "保存 港澳船票 金额" }));
  expect(secondInput).toHaveAccessibleDescription("保存付款金额失败，请重试");
  expect(screen.getAllByRole("alert")).toHaveLength(2);
});
