import type { TripRepository } from "@travel/contracts";
import { useState } from "react";
import seed from "../../../../content/trip.seed.json";
import App from "../App";
import { LocalTripRepository } from "../infrastructure/localTripRepository";

function createBrowserTestRepository(): TripRepository | undefined {
  if (!import.meta.env.DEV) return undefined;
  const delayMs = Number(new URLSearchParams(window.location.search).get("__testSaveDelayMs"));
  if (!Number.isFinite(delayMs) || delayMs <= 0) return undefined;

  const localRepository = new LocalTripRepository(seed);
  return {
    load: (tripId) => localRepository.load(tripId),
    subscribe: (tripId, onChange) => localRepository.subscribe(tripId, onChange),
    save: async (trip, expectedVersion) => {
      await new Promise((resolve) => window.setTimeout(resolve, delayMs));
      return localRepository.save(trip, expectedVersion);
    },
  };
}

export function BrowserRoot() {
  const [repository] = useState(createBrowserTestRepository);
  return <App repository={repository} />;
}
