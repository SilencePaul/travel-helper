import { BrowserRouter, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { useState } from "react";
import {
  duplicateDay,
  insertDay,
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
  const { trip, saveTrip, syncState } = useTrip();
  const navigate = useNavigate();
  const [requestedDayId, setRequestedDayId] = useState<string>();
  const selectedDayId = trip.days.some((day) => day.id === requestedDayId)
    ? requestedDayId
    : trip.days[0]?.id;

  function persist(next: Trip) {
    void saveTrip(next).catch(() => undefined);
  }

  function addDay() {
    const id = uniqueDayId(trip.days, createDayId());
    const days = insertDay(trip.days, trip.days.length, trip.startDate, id);
    persist(withDayRange(trip, days));
  }

  function duplicateSelectedDay() {
    const selectedIndex = trip.days.findIndex((day) => day.id === selectedDayId);
    if (selectedIndex < 0) return;
    const days = duplicateDay(
      trip.days,
      selectedIndex,
      trip.startDate,
      () => uniqueDayId(trip.days, createDayId()),
    );
    persist(withDayRange(trip, days));
  }

  function deleteSelectedDay() {
    const selectedIndex = trip.days.findIndex((day) => day.id === selectedDayId);
    if (selectedIndex < 0 || trip.days.length <= 1) return;
    const result = removeDay(trip.days, selectedIndex, trip.unscheduledItemIds);
    persist(withDayRange(trip, result.days, result.unscheduledItemIds));
  }

  function reorderDays(activeDayId: string, overDayId: string) {
    const fromIndex = trip.days.findIndex((day) => day.id === activeDayId);
    const toIndex = trip.days.findIndex((day) => day.id === overDayId);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
    const days = moveDay(trip.days, fromIndex, toIndex, trip.startDate);
    persist(withDayRange(trip, days));
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
              onDeleteDay={deleteSelectedDay}
              onMoveDay={reorderDays}
              isSaving={syncState === "正在保存"}
            />
          }
        />
        <Route path="/day/:dayId" element={<DayRoute trip={trip} />} />
        <Route path="*" element={<DayPage trip={trip} dayId={undefined} onBack={() => navigate("/")} />} />
      </Routes>
    </div>
  );
}

function DayRoute({ trip }: { trip: Trip }) {
  const { dayId } = useParams();
  const navigate = useNavigate();
  return <DayPage trip={trip} dayId={dayId} onBack={() => navigate("/")} />;
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
