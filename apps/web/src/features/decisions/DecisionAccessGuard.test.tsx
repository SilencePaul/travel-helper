import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { DecisionAccessGuard } from "./DecisionAccessGuard";

test("explains the shared-trip requirement and returns to the itinerary", () => {
  const onBack = vi.fn();

  render(<DecisionAccessGuard onBack={onBack} />);

  expect(screen.getByRole("heading", { name: "共同决定，需要两张同行票" })).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("两位成员登录同一个共享行程");
  expect(screen.queryByText("已登录")).not.toBeInTheDocument();
  expect(screen.getAllByText("待验证", { selector: ".decision-access-travelers span" })).toHaveLength(2);

  fireEvent.click(screen.getByRole("button", { name: "返回行程" }));

  expect(onBack).toHaveBeenCalledOnce();
});
