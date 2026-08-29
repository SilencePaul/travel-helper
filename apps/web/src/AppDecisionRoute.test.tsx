import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { DecisionWorkspaceRepository, Member } from "@travel/contracts";
import { expect, test, vi } from "vitest";
import seed from "../../../content/trip.seed.json";
import { TripApp } from "./App";
import { LocalTripRepository } from "./infrastructure/localTripRepository";

test("the trip navigation exposes the authenticated decision workspace route", async () => {
  const workspace = { tripId: seed.id, preferences: [], candidates: [], placements: [], evidence: [], feedback: [], confirmations: [], workspaceCursor: "0", fetchedAt: "2026-08-28T00:00:00.000Z" };
  const decisionRepository = { load: vi.fn().mockResolvedValue(workspace), command: vi.fn(), events: vi.fn(), subscribe: vi.fn(() => () => undefined) } satisfies DecisionWorkspaceRepository;
  const member = { uid: "fs_admin", displayName: "一鸣", role: "admin", version: 1, createdAt: "2026-08-28T00:00:00.000Z" } satisfies Member;

  render(<MemoryRouter initialEntries={["/decisions"]}><TripApp repository={new LocalTripRepository(seed)} decisionRepository={decisionRepository} member={member} /></MemoryRouter>);

  expect(await screen.findByRole("heading", { name: "两个人的偏好，正在汇成一张路线" })).toBeVisible();
  expect(decisionRepository.load).toHaveBeenCalledWith(seed.id);
});

test("the decision route stays protected until a shared trip member is available", async () => {
  render(<MemoryRouter initialEntries={["/decisions"]}><TripApp repository={new LocalTripRepository(seed)} /></MemoryRouter>);

  expect(await screen.findByRole("heading", { name: "共同决定，需要两张同行票" })).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "返回行程" }));

  expect(await screen.findByRole("heading", { name: "两个人，一条向南的路线。" })).toBeVisible();
});
