import { BrowserRouter, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { useState } from "react";
import {
  appendDay,
  duplicateDay,
  moveDay,
  removeDay,
  type TravelDay,
  type Trip,
  type TripRepository,
} from "@travel/contracts";
import { TripProvider } from "./app/TripProvider";
import { useTrip } from "./app/tripContext";
import { DayPage } from "./features/itinerary/DayPage";
import { OverviewPage } from "./features/overview/OverviewPage";
import "./styles/global.css";

type AppProps = {
  repository?: TripRepository;
  createDayId?: () => string;
  tripId?: string;
};

function uniqueDayId(days: TravelDay[], requestedId: string) {
  const baseId = requestedId || "day-ui";
  const existingIds = new Set(days.map((day) => day.id));
  let candidate = baseId;
  let suffix = 2;
  while (existingIds.has(candidate)) {
    candidate = `${baseId}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function withDayRange(trip: Trip, days: TravelDay[], unscheduledItemIds = trip.unscheduledItemIds) {
  return {
    ...trip,
    days,
    startDate: days[0]?.date ?? trip.startDate,
    endDate: days.at(-1)?.date ?? trip.startDate,
    unscheduledItemIds,
  };
}

function TripRoutes({ createDayId = () => "day-ui" }: Pick<AppProps, "createDayId">) {
  const { trip, mutateTrip, syncState } = useTrip();
  const navigate = useNavigate();
  const [requestedDayId, setRequestedDayId] = useState<string>();
  const selectedDayId = trip.days.some((day) => day.id === requestedDayId)
    ? requestedDayId
    : trip.days[0]?.id;

  function addDay() {
    return mutateTrip((current) => {
      const id = uniqueDayId(current.days, createDayId());
      const days = appendDay(current.days, current.startDate, id);
      return withDayRange(current, days);
    });
  }

  function duplicateSelectedDay() {
    return mutateTrip((current) => {
      const selectedIndex = current.days.findIndex((day) => day.id === selectedDayId);
      if (selectedIndex < 0) return undefined;
      const days = duplicateDay(
        current.days,
        selectedIndex,
        current.startDate,
        () => uniqueDayId(current.days, createDayId()),
      );
      return withDayRange(current, days);
    });
  }

  async function deleteDay(dayId: string) {
    let adjacentDayId: string | undefined;
    let rejectionMessage: string | undefined;
    const saved = await mutateTrip((current) => {
      const dayIndex = current.days.findIndex((day) => day.id === dayId);
      if (dayIndex < 0) {
        rejectionMessage = "旅行日已不存在，请取消并重新选择";
        return undefined;
      }
      if (current.days.length <= 1) {
        rejectionMessage = "行程至少需要保留一天";
        return undefined;
      }
      adjacentDayId = current.days[dayIndex + 1]?.id ?? current.days[dayIndex - 1]?.id;
      const result = removeDay(current.days, dayIndex, current.unscheduledItemIds);
      return withDayRange(current, result.days, result.unscheduledItemIds);
    });
    if (rejectionMessage) throw new Error(rejectionMessage);
    if (!saved) throw new Error("删除失败，请重试");
    if (saved && adjacentDayId) setRequestedDayId(adjacentDayId);
  }

  function reorderDays(activeDayId: string, overDayId: string) {
    return mutateTrip((current) => {
      const fromIndex = current.days.findIndex((day) => day.id === activeDayId);
      const toIndex = current.days.findIndex((day) => day.id === overDayId);
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return undefined;
      const days = moveDay(current.days, fromIndex, toIndex, current.startDate);
      return withDayRange(current, days);
    });
  }

  return (
    <div className="app-shell">
      <div className="sync-bar" role="status">{syncState}</div>
      <Routes>
        <Route
          path="/"
          element={
            <OverviewPage
              trip={trip}
              selectedDayId={selectedDayId}
              onSelectDay={(dayId) => {
                setRequestedDayId(dayId);
                navigate(`/day/${encodeURIComponent(dayId)}`);
              }}
              onAddDay={addDay}
              onDuplicateDay={duplicateSelectedDay}
              onDeleteDay={deleteDay}
              onMoveDay={reorderDays}
              isSaving={syncState === "正在保存"}
            />
          }
        />
        <Route
          path="/day/:dayId"
          element={
            <DayRoute
              trip={trip}
              onBack={(dayId) => {
                setRequestedDayId(dayId);
                navigate("/");
              }}
            />
          }
        />
        <Route path="*" element={<DayPage trip={trip} dayId={undefined} onBack={() => navigate("/")} />} />
      </Routes>
    </div>
  );
}

function DayRoute({ trip, onBack }: { trip: Trip; onBack: (dayId: string | undefined) => void }) {
  const { dayId } = useParams();
  return <DayPage trip={trip} dayId={dayId} onBack={() => onBack(dayId)} />;
}

export default function App({ repository, createDayId, tripId }: AppProps) {
  return (
    <TripProvider repository={repository} tripId={tripId}>
      <BrowserRouter>
        <TripRoutes createDayId={createDayId} />
      </BrowserRouter>
    </TripProvider>
  );
}
