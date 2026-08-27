import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuthShell } from "./AuthShell";

describe("AuthShell", () => {
  it("renders the trip route and an accessible authentication card", () => {
    render(
      <AuthShell step="登录" title="浅浅计划，认真出发" description="使用飞书确认身份。">
        <button type="button">使用飞书继续</button>
      </AuthShell>,
    );

    expect(screen.getByRole("main", { name: "浅浅计划，认真出发" })).toBeInTheDocument();
    expect(screen.getByLabelText("深圳、香港、澳门、珠海旅行路线")).toBeInTheDocument();
    expect(screen.getByText("一鸣 × 美垚")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "使用飞书继续" })).toBeInTheDocument();
  });
});
