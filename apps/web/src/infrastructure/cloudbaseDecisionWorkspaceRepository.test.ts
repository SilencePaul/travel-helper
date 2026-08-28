import { describe, expect, it, vi } from "vitest";
import { CloudBaseDecisionWorkspaceRepository } from "./cloudbaseDecisionWorkspaceRepository";

const workspace = {
  tripId: "trip-1",
  preferences: [],
  candidates: [],
  placements: [],
  evidence: [],
  feedback: [],
  confirmations: [],
  workspaceCursor: "0",
  fetchedAt: "2026-08-28T00:00:00.000Z",
};

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("CloudBaseDecisionWorkspaceRepository", () => {
  it("loads a server-owned workspace and saves an offline snapshot", async () => {
    const storage = memoryStorage();
    const callFunction = vi.fn().mockResolvedValue({ result: workspace });
    const repository = new CloudBaseDecisionWorkspaceRepository({ callFunction, storage });

    await expect(repository.load("trip-1")).resolves.toEqual(workspace);
    expect(callFunction).toHaveBeenCalledWith({ name: "trip-api", data: { action: "getDecisionWorkspace", tripId: "trip-1" } });
    expect(JSON.parse(storage.getItem("travel-decision-workspace:trip-1")!)).toEqual(workspace);
  });

  it("returns the last valid snapshot when the service is offline", async () => {
    const storage = memoryStorage();
    storage.setItem("travel-decision-workspace:trip-1", JSON.stringify(workspace));
    const repository = new CloudBaseDecisionWorkspaceRepository({ callFunction: vi.fn().mockRejectedValue(new Error("offline")), storage });

    await expect(repository.load("trip-1")).resolves.toEqual(workspace);
  });

  it("sends typed commands through trip-api and preserves conflict facts", async () => {
    const conflict = { ok: false as const, error: "VERSION_CONFLICT" as const, latest: { ...workspace, id: "preference-1", revision: 2, updatedAt: workspace.fetchedAt, ownerUid: "fs_member", answers: {}, status: "editing", updatedBy: "fs_member" } };
    const callFunction = vi.fn().mockResolvedValue({ result: conflict });
    const repository = new CloudBaseDecisionWorkspaceRepository({ callFunction, storage: memoryStorage() });
    const command = { action: "upsertPreference" as const, tripId: "trip-1", expectedRevision: 1, idempotencyKey: "request-001", answers: { pace: "slow" } };

    await expect(repository.command(command)).resolves.toEqual(conflict);
    expect(callFunction).toHaveBeenCalledWith({ name: "trip-api", data: command });
  });

  it("reads strictly newer decision events from the supplied cursor", async () => {
    const response = { events: [], cursor: 7 };
    const callFunction = vi.fn().mockResolvedValue({ result: response });
    const repository = new CloudBaseDecisionWorkspaceRepository({ callFunction, storage: memoryStorage() });

    await expect(repository.events("trip-1", 4)).resolves.toEqual(response);
    expect(callFunction).toHaveBeenCalledWith({ name: "trip-api", data: { action: "getDecisionEvents", tripId: "trip-1", afterCursor: 4 } });
  });
});
