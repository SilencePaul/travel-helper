import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProductionAuthGate } from "./BrowserRoot";

const getCurrentUser = vi.fn();

vi.mock("../infrastructure/cloudbaseClient", () => ({
  getCloudbaseAuth: () => ({ getCurrentUser }),
}));

describe("ProductionAuthGate", () => {
  beforeEach(() => {
    getCurrentUser.mockResolvedValue(null);
  });

  it("does not mount trip content or a local repository before CloudBase auth", async () => {
    render(<ProductionAuthGate />);
    expect(await screen.findByRole("button", { name: "使用飞书登录" })).toBeInTheDocument();
    expect(screen.queryByText("正在加载旅行计划")).not.toBeInTheDocument();
  });
});
