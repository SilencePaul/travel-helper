import type { BudgetCategory, Member, Trip } from "@travel/contracts";
import type { OrderStatus } from "@travel/contracts";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { DayStrip } from "./DayStrip";
import { getDayPanelId, getDayTabId } from "./dayTabIds";
import { TravelPassHero } from "./TravelPassHero";
import { BudgetPanel } from "../budget/BudgetPanel";
import { OrdersPanel } from "../budget/OrdersPanel";
import { WeatherSummary } from "../weather/WeatherSummary";

type AffectedOrder = { id: string; name: string; category: BudgetCategory; dayId: string };

export type OverviewPageProps = {
  trip: Trip;
  selectedDayId: string | undefined;
  onSelectDay: (dayId: string) => void;
  onOpenSelectedDay?: (dayId: string) => void;
  onAddDay: () => void | Promise<unknown>;
  onDuplicateDay: () => void | Promise<unknown>;
  onDeleteDay: (dayId: string) => void | Promise<unknown>;
  onMoveDay: (activeDayId: string, overDayId: string) => void | Promise<unknown>;
  isSaving?: boolean;
  onOpenHotels?: () => void;
  member?: Member;
  onManageMembers?: () => void;
  onLogout?: () => void | Promise<void>;
  onChangeDateRange?: (startDate: string, endDate: string, confirmed: boolean, reviewedOrderIds?: string[]) => Promise<{ affectedOrders: AffectedOrder[] }>;
  onOrderStatusChange?: (orderId: string, status: OrderStatus) => void | Promise<unknown>;
  onOrderPaymentChange?: (orderId: string, paid: number) => void | Promise<unknown>;
};

export function OverviewPage({
  trip,
  selectedDayId,
  onSelectDay,
  onOpenSelectedDay,
  onAddDay,
  onDuplicateDay,
  onDeleteDay,
  onMoveDay,
  isSaving = false,
  onOpenHotels = () => undefined,
  member,
  onManageMembers,
  onLogout,
  onChangeDateRange,
  onOrderStatusChange = () => undefined,
  onOrderPaymentChange,
}: OverviewPageProps) {
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; dayNumber: number }>();
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const [rangeStart, setRangeStart] = useState(trip.startDate);
  const [rangeEnd, setRangeEnd] = useState(trip.endDate);
  const [rangeWarning, setRangeWarning] = useState<{ startDate: string; endDate: string; orders: AffectedOrder[] }>();
  const [rangeError, setRangeError] = useState<string>();
  const [rangeSaving, setRangeSaving] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [accountError, setAccountError] = useState<string>();
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  const rangeDialogRef = useRef<HTMLDialogElement>(null);
  const dateTriggerRef = useRef<HTMLButtonElement>(null);
  const rangeCancelRef = useRef<HTMLButtonElement>(null);
  const deleteTitleId = useId();
  const deleteDescriptionId = useId();
  const requestedIndex = trip.days.findIndex((day) => day.id === selectedDayId);
  const selectedIndex = requestedIndex >= 0 ? requestedIndex : trip.days.length > 0 ? 0 : -1;
  const selectedDay = trip.days[selectedIndex];
  const dialogOpen = Boolean(deleteTarget);

  useEffect(() => {
    if (!dialogOpen) return;
    const dialog = deleteDialogRef.current;
    if (!dialog) return;
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    cancelButtonRef.current?.focus();
  }, [dialogOpen]);

  useEffect(() => {
    /* oxlint-disable react/set-state-in-effect -- the form mirrors a persisted trip replacement. */
    setRangeStart(trip.startDate);
    setRangeEnd(trip.endDate);
    /* oxlint-enable react/set-state-in-effect */
  }, [trip.startDate, trip.endDate]);

  useEffect(() => {
    if (!rangeWarning) return;
    const dialog = rangeDialogRef.current;
    if (!dialog) return;
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    rangeCancelRef.current?.focus();
    return () => { if (dialog.open) dialog.close?.(); };
  }, [rangeWarning]);

  async function requestDateRange(confirmed = false) {
    if (!onChangeDateRange) return;
    setRangeError(undefined);
    const reviewedRange = confirmed ? rangeWarning : undefined;
    const requestedStartDate = reviewedRange?.startDate ?? rangeStart;
    const requestedEndDate = reviewedRange?.endDate ?? rangeEnd;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedStartDate) || !/^\d{4}-\d{2}-\d{2}$/.test(requestedEndDate)) {
      setRangeError("请输入有效的开始与结束日期");
      return;
    }
    if (requestedEndDate < requestedStartDate) {
      setRangeError("结束日期不能早于开始日期");
      return;
    }
    if (confirmed) setRangeSaving(true);
    try {
      const result = await onChangeDateRange(requestedStartDate, requestedEndDate, confirmed, reviewedRange?.orders.map((order) => order.id));
      if (result.affectedOrders.length > 0) {
        setRangeWarning({ startDate: requestedStartDate, endDate: requestedEndDate, orders: result.affectedOrders });
        return;
      }
      setRangeWarning(undefined);
      requestAnimationFrame(() => dateTriggerRef.current?.focus());
    } catch (error) {
      setRangeError(error instanceof Error ? error.message : "日期修改失败，请重试");
    } finally {
      if (confirmed) setRangeSaving(false);
    }
  }

  function closeDeleteDialog() {
    const dialog = deleteDialogRef.current;
    if (!dialog?.open) return;
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }

  function cancelDelete() {
    if (isDeleting) return;
    closeDeleteDialog();
    setDeleteTarget(undefined);
    setDeleteError(undefined);
    deleteTriggerRef.current?.focus();
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (isDeleting) {
        deleteDialogRef.current?.focus();
        return;
      }
      cancelDelete();
      return;
    }
    if (event.key !== "Tab") return;
    if (isDeleting) {
      event.preventDefault();
      deleteDialogRef.current?.focus();
      return;
    }
    if (!event.shiftKey && document.activeElement === cancelButtonRef.current) {
      event.preventDefault();
      confirmButtonRef.current?.focus();
    } else if (event.shiftKey && document.activeElement === confirmButtonRef.current) {
      event.preventDefault();
      cancelButtonRef.current?.focus();
    }
  }

  async function confirmDelete() {
    setIsDeleting(true);
    setDeleteError(undefined);
    deleteDialogRef.current?.focus();
    try {
      await onDeleteDay(deleteTarget!.id);
      closeDeleteDialog();
      setDeleteTarget(undefined);
      window.setTimeout(() => {
        document.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
      }, 0);
    } catch (error) {
      setDeleteError(error instanceof Error && error.message
        ? error.message
        : "删除失败，请重试");
      deleteDialogRef.current?.focus();
    } finally {
      setIsDeleting(false);
    }
  }

  async function signOut() {
    if (!onLogout || signingOut) return;
    setSigningOut(true);
    setAccountError(undefined);
    try { await onLogout(); } catch { setAccountError("退出失败，请重试"); } finally { setSigningOut(false); }
  }

  return (
    <main className="overview">
      <TravelPassHero trip={trip} member={member} selectedDayId={selectedDay?.id} />
      <nav className="text-navigation" aria-label="行程操作">
        <span className="text-navigation__current" aria-current="page">行程</span>
        {member ? <span className="signed-in-user">已登录：{member.displayName}</span> : null}
        <button type="button" onClick={onOpenHotels}>酒店比较</button>
        {onManageMembers ? <button type="button" onClick={onManageMembers}>成员管理</button> : null}
        {onLogout ? <button type="button" onClick={() => void signOut()} disabled={signingOut}>{signingOut ? "正在退出" : "退出登录"}</button> : null}
        {accountError ? <span role="alert">{accountError}</span> : null}
      </nav>

      <section aria-labelledby="days-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">ROUTE MANIFEST</p>
            <h2 id="days-heading">每日计划</h2>
          </div>
          <div className="day-actions">
            <button type="button" onClick={onAddDay} disabled={isSaving}>新增一天</button>
            <button type="button" onClick={onDuplicateDay} disabled={!selectedDay || isSaving}>
              复制当天
            </button>
            <button
              ref={deleteTriggerRef}
              type="button"
              className="danger-button"
              onClick={() => {
                setIsDeleting(false);
                setDeleteError(undefined);
                if (selectedDay) {
                  setDeleteTarget({ id: selectedDay.id, dayNumber: selectedIndex + 1 });
                }
              }}
              disabled={!selectedDay || trip.days.length <= 1 || isSaving}
            >
              删除当天
            </button>
          </div>
        </div>

        <DayStrip
          days={trip.days}
          selectedDayId={selectedDay?.id}
          onSelectDay={onSelectDay}
          onMoveDay={onMoveDay}
          disabled={isSaving}
        />

        {dialogOpen && deleteTarget ? (
          <dialog
            ref={deleteDialogRef}
            className="delete-confirmation"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={deleteTitleId}
            aria-describedby={deleteDescriptionId}
            aria-busy={isDeleting}
            tabIndex={-1}
            onCancel={(event) => {
              event.preventDefault();
              cancelDelete();
            }}
            onKeyDown={handleDialogKeyDown}
          >
            <div className="delete-copy">
              <h3 id={deleteTitleId}>删除 D{deleteTarget.dayNumber}</h3>
              <p id={deleteDescriptionId}>确定删除 D{deleteTarget.dayNumber} 吗？</p>
              {deleteError ? <p role="alert">{deleteError}</p> : null}
            </div>
            <div>
              <button
                ref={confirmButtonRef}
                type="button"
                className="danger-button"
                onClick={() => void confirmDelete()}
                disabled={isDeleting}
              >
                {isDeleting ? "正在删除" : "确认删除"}
              </button>
              <button ref={cancelButtonRef} type="button" onClick={cancelDelete} disabled={isDeleting}>
                取消
              </button>
            </div>
          </dialog>
        ) : null}

        {selectedDay ? (
          <article
            id={getDayPanelId(selectedDay.id)}
            className="selected-day"
            role="tabpanel"
            aria-labelledby={getDayTabId(selectedDay.id)}
          >
            <p className="eyebrow">当前选中</p>
            <h3>D{selectedIndex + 1} · {selectedDay.city || "待安排"}</h3>
            <p>{selectedDay.date} · 待预报</p>
            {onOpenSelectedDay ? <button type="button" onClick={() => onOpenSelectedDay(selectedDay.id)}>查看当天详情</button> : null}
          </article>
        ) : (
          <p className="empty-state">请先新增一天</p>
        )}
      </section>

      <WeatherSummary days={trip.days} />

      {onChangeDateRange ? <section className="date-range" aria-labelledby="date-range-heading">
        <div><p className="eyebrow">日期</p><h2 id="date-range-heading">调整旅行日期</h2></div>
        <label>开始日期<input type="date" value={rangeStart} aria-describedby={rangeError ? "date-range-error" : undefined} onChange={(event) => setRangeStart(event.target.value)} /></label>
        <label>结束日期<input type="date" value={rangeEnd} aria-describedby={rangeError ? "date-range-error" : undefined} onChange={(event) => setRangeEnd(event.target.value)} /></label>
        <button ref={dateTriggerRef} type="button" onClick={() => void requestDateRange()} disabled={isSaving || rangeSaving}>更新日期</button>
        {rangeError ? <p id="date-range-error" role="alert">{rangeError}</p> : null}
      </section> : null}

      {rangeWarning ? <dialog ref={rangeDialogRef} className="date-warning" aria-modal="true" aria-labelledby="date-warning-title" aria-busy={rangeSaving} onCancel={(event) => { event.preventDefault(); if (!rangeSaving) { setRangeWarning(undefined); dateTriggerRef.current?.focus(); } }}>
        <h2 id="date-warning-title">这些订单关联的旅行日将被移除</h2>
        <p>订单不会自动删除或改写。确认后只调整日期与行程日，请随后核对订单。</p>
        <ul>{rangeWarning.orders.map((order) => <li key={order.id}>{order.category === "hotel" ? "酒店" : "门票"} · {order.name}</li>)}</ul>
        {rangeError ? <p role="alert">{rangeError}</p> : null}
        <div><button type="button" className="danger-button" onClick={() => void requestDateRange(true)} disabled={rangeSaving || isSaving}>{rangeSaving ? "正在调整" : "仍然调整日期"}</button><button ref={rangeCancelRef} type="button" onClick={() => { setRangeWarning(undefined); dateTriggerRef.current?.focus(); }} disabled={rangeSaving}>保留当前日期</button></div>
      </dialog> : null}

      <div className="overview-sidepanels">
        <BudgetPanel trip={trip} />
        <OrdersPanel orders={trip.orders ?? []} onStatusChange={onOrderStatusChange} onPaidChange={onOrderPaymentChange} disabled={isSaving} />
      </div>

      {trip.unscheduledItemIds.length > 0 ? (
        <section className="unscheduled" aria-labelledby="unscheduled-heading">
          <h2 id="unscheduled-heading">待安排内容（{trip.unscheduledItemIds.length}）</h2>
          <ul>
            {trip.unscheduledItemIds.map((itemId) => <li key={itemId}>{itemId}</li>)}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
