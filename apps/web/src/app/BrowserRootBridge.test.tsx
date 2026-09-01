import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const received = vi.hoisted(() => ({ agentBridge: undefined as unknown }));
const recoverAuthenticatedMember = vi.hoisted(() => vi.fn());

vi.mock("../App", () => ({
  TripApp: (props: { agentBridge?: unknown }) => {
    received.agentBridge = props.agentBridge;
    return <div data-testid="trip-app" />;
  },
}));

vi.mock("../infrastructure/authSession", () => ({
  logout: vi.fn().mockResolvedValue(undefined),
  recoverAuthenticatedMember,
}));

import { BrowserRoot, ProductionAuthGate } from "./BrowserRoot";

describe("BrowserRoot Agent Bridge injection", () => {
  beforeEach(() => {
    received.agentBridge = undefined;
    recoverAuthenticatedMember.mockResolvedValue({ uid: "fs_admin", displayName: "一鸣", role: "admin", version: 1, createdAt: "2026-08-31T00:00:00.000Z" });
  });

  it("passes the startup-discovered bridge into the development TripApp", () => {
    const bridge = { prepare: vi.fn(), claim: vi.fn(), executeTravelResearch: vi.fn(), getResearchStatus: vi.fn(), resumeTravelResearch: vi.fn(), cancelResearch: vi.fn() };

    render(<BrowserRoot agentBridge={bridge} />);

    expect(screen.getByTestId("trip-app")).toBeInTheDocument();
    expect(received.agentBridge).toBe(bridge);
  });

  it("passes the same startup bridge through the production authentication gate", async () => {
    const bridge = { prepare: vi.fn(), claim: vi.fn(), executeTravelResearch: vi.fn(), getResearchStatus: vi.fn(), resumeTravelResearch: vi.fn(), cancelResearch: vi.fn() };

    render(<ProductionAuthGate agentBridge={bridge} />);

    expect(await screen.findByTestId("trip-app")).toBeInTheDocument();
    expect(received.agentBridge).toBe(bridge);
  });
});
