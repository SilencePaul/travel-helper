import { act, render, screen, waitFor } from "@testing-library/react";
import type { Trip, TripChange, TripRepository } from "@travel/contracts";
import { useEffect } from "react";
import { expect, test, vi } from "vitest";
import seed from "../../../../content/trip.seed.json";
import { TripProvider } from "./TripProvider";
import { useTrip, type TripContextValue } from "./tripContext";
import { UnauthorizedError } from "../infrastructure/cloudbaseTripRepository";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function versionedTrip(version: number, title = `version-${version}`): Trip {
  return { ...structuredClone(seed), orders: [], version, title };
}

class ControlledTripRepository implements TripRepository {
  readonly loadResult = deferred<Trip>();
  readonly saveRequests: Array<{
    next: Trip;
    expectedVersion: number;
    result: Deferred<Trip>;
  }> = [];
  readonly listeners = new Set<(change: TripChange) => void>();
  subscribeCalls = 0;
  unsubscribeCalls = 0;

  load(): Promise<Trip> {
    return this.loadResult.promise;
  }

  save(next: Trip, expectedVersion: number): Promise<Trip> {
    const result = deferred<Trip>();
    this.saveRequests.push({ next, expectedVersion, result });
    return result.promise;
  }

  subscribe(_tripId: string, onChange: (change: TripChange) => void) {
    this.subscribeCalls += 1;
    this.listeners.add(onChange);
    return () => {
      this.unsubscribeCalls += 1;
      this.listeners.delete(onChange);
    };
  }

  emit(trip: Trip) {
    for (const listener of this.listeners) {
      listener({ trip, actorName: "test", changedAt: new Date().toISOString() });
    }
  }
}

class MultiTripRepository implements TripRepository {
  readonly loads = new Map<string, Deferred<Trip>>();
  readonly listeners = new Map<string, Set<(change: TripChange) => void>>();
  unsubscribeCalls = 0;

  load(tripId: string) {
    const result = deferred<Trip>();
    this.loads.set(tripId, result);
    return result.promise;
  }

  async save(_next: Trip, _expectedVersion: number): Promise<Trip> {
    throw new Error("unused");
  }

  subscribe(tripId: string, onChange: (change: TripChange) => void) {
    const listeners = this.listeners.get(tripId) ?? new Set();
    listeners.add(onChange);
    this.listeners.set(tripId, listeners);
    return () => {
      this.unsubscribeCalls += 1;
      listeners.delete(onChange);
    };
  }

  emit(tripId: string, trip: Trip) {
    for (const listener of this.listeners.get(tripId) ?? []) {
      listener({ trip, actorName: "test", changedAt: new Date().toISOString() });
    }
  }
}

class UnauthorizedTripRepository extends ControlledTripRepository {
  unauthorized?: (error: unknown) => void;

  subscribe(_tripId: string, onChange: (change: TripChange) => void, _onConnectionState?: (state: "synced" | "reconnecting") => void, onUnauthorized?: (error: unknown) => void) {
    this.unauthorized = onUnauthorized;
    return super.subscribe(_tripId, onChange);
  }
}

function ProviderProbe({ onValue }: { onValue?: (value: TripContextValue) => void }) {
  const value = useTrip();
  useEffect(() => onValue?.(value), [onValue, value]);
  return (
    <>
      <span>{value.trip.title}</span>
      <span>{value.syncState}</span>
    </>
  );
}

test("subscribes before load and never regresses interleaved snapshots or mutations", async () => {
  const repository = new ControlledTripRepository();
  let context: TripContextValue | undefined;
  render(
    <TripProvider repository={repository} tripId={seed.id}>
      <ProviderProbe onValue={(value) => { context = value; }} />
    </TripProvider>,
  );

  expect(repository.subscribeCalls).toBe(1);
  act(() => repository.emit(versionedTrip(2)));
  expect(await screen.findByText("version-2")).toBeVisible();

  await act(async () => repository.loadResult.resolve(versionedTrip(0)));
  expect(screen.getByText("version-2")).toBeVisible();

  let firstMutation!: Promise<Trip | undefined>;
  let secondMutation!: Promise<Trip | undefined>;
  act(() => {
    firstMutation = context!.mutateTrip((trip) => ({ ...trip, title: "first" }));
    secondMutation = context!.mutateTrip((trip) => ({ ...trip, title: "second" }));
  });
  await waitFor(() => expect(repository.saveRequests).toHaveLength(1));
  expect(repository.saveRequests[0]).toMatchObject({ expectedVersion: 2 });

  act(() => repository.emit(versionedTrip(4)));
  await act(async () => repository.saveRequests[0]!.result.resolve(versionedTrip(3, "stale-save")));
  await waitFor(() => expect(repository.saveRequests).toHaveLength(2));
  expect(repository.saveRequests[1]).toMatchObject({
    expectedVersion: 4,
    next: { title: "second" },
  });
  expect(screen.getByText("version-4")).toBeVisible();

  await act(async () => repository.saveRequests[1]!.result.resolve(versionedTrip(5, "second")));
  await expect(firstMutation).resolves.toMatchObject({ version: 3 });
  await expect(secondMutation).resolves.toMatchObject({ version: 5 });
  expect(screen.getByText("second")).toBeVisible();
});

test("resets state and honors a replacement repository", async () => {
  const firstRepository = new ControlledTripRepository();
  const secondRepository = new ControlledTripRepository();
  let context: TripContextValue | undefined;
  const view = render(
    <TripProvider repository={firstRepository} tripId={seed.id}>
      <ProviderProbe onValue={(value) => { context = value; }} />
    </TripProvider>,
  );

  await act(async () => firstRepository.loadResult.resolve(versionedTrip(1, "first repository")));
  expect(await screen.findByText("first repository")).toBeVisible();
  let failedMutation!: Promise<Trip | undefined>;
  act(() => {
    failedMutation = context!.mutateTrip((trip) => ({ ...trip, title: "fails" }));
  });
  await waitFor(() => expect(firstRepository.saveRequests).toHaveLength(1));
  await act(async () => firstRepository.saveRequests[0]!.result.reject(new Error("offline")));
  await expect(failedMutation).resolves.toBeUndefined();
  expect(screen.getByText("保存失败，请重试")).toBeVisible();

  view.rerender(
    <TripProvider repository={secondRepository} tripId={seed.id}>
      <ProviderProbe onValue={(value) => { context = value; }} />
    </TripProvider>,
  );
  expect(screen.getByText("正在加载旅行计划")).toBeVisible();
  expect(firstRepository.unsubscribeCalls).toBe(1);
  expect(secondRepository.subscribeCalls).toBe(1);

  act(() => firstRepository.emit(versionedTrip(9, "stale repository")));
  await act(async () => secondRepository.loadResult.resolve(versionedTrip(0, "second repository")));
  expect(await screen.findByText("second repository")).toBeVisible();
  expect(screen.getByText("正在使用本地计划")).toBeVisible();
  expect(screen.queryByText("stale repository")).not.toBeInTheDocument();
});

test("starts a fresh loading session when tripId changes", async () => {
  const repository = new MultiTripRepository();
  const view = render(
    <TripProvider repository={repository} tripId="trip-a">
      <ProviderProbe />
    </TripProvider>,
  );
  await act(async () => repository.loads.get("trip-a")!.resolve(versionedTrip(1, "trip A")));
  expect(await screen.findByText("trip A")).toBeVisible();

  view.rerender(
    <TripProvider repository={repository} tripId="trip-b">
      <ProviderProbe />
    </TripProvider>,
  );
  expect(screen.getByText("正在加载旅行计划")).toBeVisible();
  expect(repository.unsubscribeCalls).toBe(1);
  act(() => repository.emit("trip-a", versionedTrip(9, "stale trip")));
  await act(async () => repository.loads.get("trip-b")!.resolve(versionedTrip(0, "trip B")));
  expect(await screen.findByText("trip B")).toBeVisible();
  expect(screen.queryByText("stale trip")).not.toBeInTheDocument();
});

test("clears a load error when a replacement repository starts loading", async () => {
  const failedRepository = new ControlledTripRepository();
  const healthyRepository = new ControlledTripRepository();
  const view = render(
    <TripProvider repository={failedRepository} tripId={seed.id}>
      <ProviderProbe />
    </TripProvider>,
  );
  await act(async () => failedRepository.loadResult.reject(new Error("offline")));
  expect(await screen.findByRole("alert")).toHaveTextContent("旅行计划加载失败");

  view.rerender(
    <TripProvider repository={healthyRepository} tripId={seed.id}>
      <ProviderProbe />
    </TripProvider>,
  );
  expect(screen.getByText("正在加载旅行计划")).toBeVisible();
  await act(async () => healthyRepository.loadResult.resolve(versionedTrip(0, "recovered")));
  expect(await screen.findByText("recovered")).toBeVisible();
});

test("ignores a delayed save result from a replaced repository", async () => {
  const firstRepository = new ControlledTripRepository();
  const secondRepository = new ControlledTripRepository();
  let context: TripContextValue | undefined;
  const view = render(
    <TripProvider repository={firstRepository} tripId={seed.id}>
      <ProviderProbe onValue={(value) => { context = value; }} />
    </TripProvider>,
  );
  await act(async () => firstRepository.loadResult.resolve(versionedTrip(1, "first")));
  let oldMutation!: Promise<Trip | undefined>;
  act(() => {
    oldMutation = context!.mutateTrip((trip) => ({ ...trip, title: "old save" }));
  });
  await waitFor(() => expect(firstRepository.saveRequests).toHaveLength(1));

  view.rerender(
    <TripProvider repository={secondRepository} tripId={seed.id}>
      <ProviderProbe onValue={(value) => { context = value; }} />
    </TripProvider>,
  );
  await act(async () => {
    firstRepository.saveRequests[0]!.result.resolve(versionedTrip(99, "stale save"));
    secondRepository.loadResult.resolve(versionedTrip(0, "current repository"));
  });

  await expect(oldMutation).resolves.toBeUndefined();
  expect(await screen.findByText("current repository")).toBeVisible();
  expect(screen.queryByText("stale save")).not.toBeInTheDocument();
});

test("clears a loaded trip when the repository reports authorization loss", async () => {
  const repository = new UnauthorizedTripRepository();
  const onUnauthorized = vi.fn();
  render(
    <TripProvider repository={repository} tripId={seed.id} onUnauthorized={onUnauthorized}>
      <ProviderProbe />
    </TripProvider>,
  );
  await act(async () => repository.loadResult.resolve(versionedTrip(1, "private itinerary")));
  expect(await screen.findByText("private itinerary")).toBeVisible();

  act(() => repository.unauthorized?.(Object.assign(new Error("provider detail"), { code: "UNAUTHORIZED" })));

  expect(screen.queryByText("private itinerary")).not.toBeInTheDocument();
  expect(onUnauthorized).toHaveBeenCalledWith(expect.objectContaining({ code: "UNAUTHORIZED" }));
});

test("clears the saving state when an in-flight save resolves after authorization loss", async () => {
  const repository = new UnauthorizedTripRepository();
  let context: TripContextValue | undefined;
  render(
    <TripProvider repository={repository} tripId={seed.id}>
      <ProviderProbe onValue={(value) => { context = value; }} />
    </TripProvider>,
  );
  await act(async () => repository.loadResult.resolve(versionedTrip(1, "private itinerary")));
  await screen.findByText("private itinerary");

  let save!: Promise<Trip | undefined>;
  act(() => { save = context!.mutateTrip((trip) => ({ ...trip, title: "revoked save" })); });
  await waitFor(() => expect(repository.saveRequests).toHaveLength(1));
  act(() => repository.unauthorized?.(new UnauthorizedError()));
  expect(screen.getByRole("alert")).toHaveTextContent("登录状态已失效");

  await act(async () => repository.saveRequests[0]!.result.resolve(versionedTrip(2, "stale save")));
  await expect(save).resolves.toBeUndefined();
});
