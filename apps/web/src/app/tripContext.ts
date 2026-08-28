import { createContext, useContext } from "react";
import type { Trip } from "@travel/contracts";

export type TripSyncState =
  | "正在使用本地计划"
  | "已同步"
  | "正在保存"
  | "正在重连"
  | "保存失败，请重试"
  | "离线"
  | "同步冲突，等待处理";

export type TripContextValue = {
  trip: Trip;
  saveTrip: (next: Trip) => Promise<Trip>;
  mutateTrip: (mutation: TripMutation) => Promise<Trip | undefined>;
  syncState: TripSyncState;
  pendingCommandCount: number;
  unassignedOfflineCount: number;
  conflictPaused: boolean;
};

export type TripMutation = (current: Trip) => Trip | undefined;

export const TripContext = createContext<TripContextValue | undefined>(undefined);

export function useTrip() {
  const value = useContext(TripContext);
  if (!value) {
    throw new Error("useTrip 必须在 TripProvider 内使用");
  }
  return value;
}
