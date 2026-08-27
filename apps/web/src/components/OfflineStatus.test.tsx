import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { OfflineStatus } from "./OfflineStatus";

beforeEach(() => {
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
});

it("announces offline mode and queued work", () => {
  render(<OfflineStatus pendingCount={2} />);
  fireEvent(window, new Event("offline"));

  expect(screen.getByRole("status")).toHaveTextContent("离线");
  expect(screen.getByRole("status")).toHaveTextContent("2 项修改待同步");
});

it("returns to online status after connectivity is restored", () => {
  render(<OfflineStatus />);
  fireEvent(window, new Event("offline"));
  fireEvent(window, new Event("online"));

  expect(screen.getByRole("status")).toHaveTextContent("在线");
});
