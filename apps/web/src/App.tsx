import { BrowserRouter, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { useLayoutEffect, useRef, useState } from "react";
import {
  appendDay,
  duplicateDay,
  moveDay,
  removeDay,
  reconcileDays,
  getDateRangeOrderWarning,
  transitionOrderStatus,
  applyOrderPayment,
  type OrderStatus,
  type TravelDay,
  type Trip,
  type TripRepository,
  type DecisionWorkspaceRepository,
  type Member,
} from "@travel/contracts";
import type { RouteService } from "./features/map/types";
import { TripProvider } from "./app/TripProvider";
import { useTrip } from "./app/tripContext";
import { DayPage } from "./features/itinerary/DayPage";
import { OverviewPage } from "./features/overview/OverviewPage";
import { HotelComparePage } from "./features/hotels/HotelComparePage";
import "./styles/global.css";
import { MemberManagementPage } from "./features/members/MemberManagementPage";
import { OfflineStatus } from "./components/OfflineStatus";
import { CloudBaseDecisionWorkspaceRepository } from "./infrastructure/cloudbaseDecisionWorkspaceRepository";
import { DecisionAccessGuard } from "./features/decisions/DecisionAccessGuard";
import { DecisionWorkspacePage } from "./features/decisions/DecisionWorkspacePage";

type AppProps = {
  repository?: TripRepository;
  decisionRepository?: DecisionWorkspaceRepository;
  createDayId?: () => string;
  tripId?: string;
  routeService?: RouteService;
  member?: Member;
  onUnauthorized?: (error: unknown) => void;
  onLogout?: () => void | Promise<void>;
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

function RouteFocus() {
  const { pathname, search } = useLocation();
  const mounted = useRef(false);
  useLayoutEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const frame = requestAnimationFrame(() => {
      const destination = document.querySelector<HTMLElement>(".app-shell main");
      if (!destination) return;
      destination.tabIndex = -1;
      destination.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [pathname, search]);
  return null;
}

function TripRoutes({ createDayId = () => "day-ui", routeService, member, onUnauthorized, onLogout, decisionRepository, enforceAdmin, showOfflineStatus }: Pick<AppProps, "createDayId" | "routeService" | "member" | "onUnauthorized" | "onLogout" | "decisionRepository"> & { enforceAdmin: boolean; showOfflineStatus: boolean }) {
  const { trip, mutateTrip, syncState, pendingCommandCount, unassignedOfflineCount, conflictPaused } = useTrip();
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

  function selectHotel(hotelId: string) {
    return mutateTrip((current) => ({
      ...current,
      days: current.days.map((day) => day.city.includes("香港") ? { ...day, hotelId } : day),
    })).then((saved) => Boolean(saved));
  }

  function changeDateRange(startDate: string, endDate: string, confirmed: boolean, reviewedOrderIds?: string[]) {
    let updatedWarning: ReturnType<typeof getDateRangeOrderWarning> | undefined;
    return mutateTrip((current) => {
      const currentWarning = getDateRangeOrderWarning(current, startDate, endDate);
      if (!confirmed && currentWarning.length > 0) {
        updatedWarning = currentWarning;
        return undefined;
      }
      if (confirmed && currentWarning.some((order) => !reviewedOrderIds?.includes(order.id))) {
        updatedWarning = currentWarning;
        return undefined;
      }
      const result = reconcileDays(current.days, startDate, endDate, current.unscheduledItemIds);
      return {
        ...current,
        startDate,
        endDate,
        days: result.days,
        unscheduledItemIds: result.unscheduledItemIds,
        // Keep orders exactly as entered: a warning requires a deliberate human review.
        orders: current.orders ?? [],
      };
    }).then((saved) => {
      if (updatedWarning) return { affectedOrders: updatedWarning };
      if (!saved) throw new Error("日期修改失败，请重试");
      return { affectedOrders: [] };
    });
  }

  function changeOrderStatus(orderId: string, status: OrderStatus) {
    return mutateTrip((current) => {
      const target = (current.orders ?? []).find((order) => order.id === orderId);
      if (!target) return undefined;
      return { ...current, orders: current.orders.map((order) => order.id === orderId ? transitionOrderStatus(order, status) : order) };
    });
  }

  function changeOrderPayment(orderId: string, paid: number) {
    return mutateTrip((current) => {
      const target = (current.orders ?? []).find((order) => order.id === orderId);
      if (!target) throw new Error("订单不存在，无法更新付款金额");
      return { ...current, orders: current.orders.map((order) => order.id === orderId ? applyOrderPayment(order, paid) : order) };
    }).then((saved) => {
      if (!saved) throw new Error("保存付款金额失败，请重试");
      return saved;
    });
  }

  return (
    <div className="app-shell">
      <div className="sync-bar" role="status">{syncState}</div>
      {showOfflineStatus ? <OfflineStatus pendingCount={pendingCommandCount} unassignedCount={unassignedOfflineCount} conflictPaused={conflictPaused} /> : null}
      <RouteFocus />
      <Routes>
        <Route
          path="/"
          element={
            <OverviewPage
              trip={trip}
              selectedDayId={selectedDayId}
              onSelectDay={setRequestedDayId}
              onOpenSelectedDay={(dayId) => navigate(`/day/${encodeURIComponent(dayId)}`)}
              onAddDay={addDay}
              onDuplicateDay={duplicateSelectedDay}
              onDeleteDay={deleteDay}
              onMoveDay={reorderDays}
              isSaving={syncState === "正在保存"}
              onOpenHotels={() => navigate("/hotels")}
              onOpenDecisions={() => navigate("/decisions")}
              member={member}
              onManageMembers={member?.role === "admin" ? () => navigate("/admin/members") : undefined}
              onLogout={onLogout}
              onChangeDateRange={changeDateRange}
              onOrderStatusChange={changeOrderStatus}
              onOrderPaymentChange={changeOrderPayment}
            />
          }
        />
        <Route path="/hotels" element={<HotelComparePage trip={trip} routeService={routeService} onSelectHotel={selectHotel} onBack={() => navigate("/")} />} />
        <Route path="/decisions" element={decisionRepository && member
          ? <DecisionWorkspacePage repository={decisionRepository} trip={trip} member={member} onBack={() => navigate("/")} />
          : <DecisionAccessGuard onBack={() => navigate("/")} />} />
        <Route path="/admin/members" element={enforceAdmin && member?.role !== "admin" ? <p role="alert">无权访问</p> : <MemberManagementPage onUnauthorized={onUnauthorized} onBack={() => navigate("/", { replace: true })} />} />
        <Route
          path="/day/:dayId"
          element={
            <DayRoute
              trip={trip}
              routeService={routeService}
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

function DayRoute({ trip, onBack, routeService }: { trip: Trip; onBack: (dayId: string | undefined) => void; routeService?: RouteService }) {
  const { dayId } = useParams();
  return <DayPage trip={trip} dayId={dayId} onBack={() => onBack(dayId)} routeService={routeService} />;
}

export function TripApp({ repository, decisionRepository, createDayId, tripId, routeService, member, onUnauthorized, onLogout }: AppProps) {
  const enforceAdmin = repository?.syncMode === "cloudbase" || !import.meta.env.DEV;
  const [defaultDecisionRepository] = useState<DecisionWorkspaceRepository | undefined>(() => decisionRepository ?? (import.meta.env.VITE_DATA_MODE === "cloudbase" ? new CloudBaseDecisionWorkspaceRepository() : undefined));
  return (
    <TripProvider repository={repository} tripId={tripId} actorUid={member?.uid} onUnauthorized={onUnauthorized}>
      <TripRoutes createDayId={createDayId} routeService={routeService} member={member} onUnauthorized={onUnauthorized} onLogout={onLogout} decisionRepository={decisionRepository ?? defaultDecisionRepository} enforceAdmin={enforceAdmin} showOfflineStatus={repository === undefined} />
    </TripProvider>
  );
}

export default function App(props: AppProps) {
  return (
    <BrowserRouter>
      <TripApp {...props} />
    </BrowserRouter>
  );
}
