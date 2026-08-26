import type { BudgetCategory, Trip } from "@travel/contracts";
import type { OrderStatus } from "@travel/contracts";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { DayStrip } from "./DayStrip";
import { getDayPanelId, getDayTabId } from "./dayTabIds";
import { BudgetPanel } from "../budget/BudgetPanel";
import { OrdersPanel } from "../budget/OrdersPanel";

type AffectedOrder = { id: string; name: string; category: BudgetCategory; dayId: string };

export type OverviewPageProps = {
  trip: Trip;
  selectedDayId: string | undefined;
  onSelectDay: (dayId: string) => void;
  onAddDay: () => void | Promise<unknown>;
  onDuplicateDay: () => void | Promise<unknown>;
  onDeleteDay: (dayId: string) => void | Promise<unknown>;
  onMoveDay: (activeDayId: string, overDayId: string) => void | Promise<unknown>;
  isSaving?: boolean;
  onOpenHotels?: () => void;
  onChangeDateRange?: (startDate: string, endDate: string, confirmed: boolean) => Promise<{ affectedOrders: AffectedOrder[] }>;
  onOrderStatusChange?: (orderId: string, status: OrderStatus) => void | Promise<unknown>;
};

export function OverviewPage({
  trip,
  selectedDayId,
  onSelectDay,
  onAddDay,
  onDuplicateDay,
  onDeleteDay,
  onMoveDay,
  isSaving = false,
  onOpenHotels = () => undefined,
  onChangeDateRange,
  onOrderStatusChange = () => undefined,
}: OverviewPageProps) {
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; dayNumber: number }>();
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const [rangeStart, setRangeStart] = useState(trip.startDate);
  const [rangeEnd, setRangeEnd] = useState(trip.endDate);
  const [rangeWarning, setRangeWarning] = useState<{ startDate: string; endDate: string; orders: AffectedOrder[] }>();
  const [rangeError, setRangeError] = useState<string>();
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
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

  async function requestDateRange(confirmed = false) {
    if (!onChangeDateRange) return;
    setRangeError(undefined);
    try {
      const result = await onChangeDateRange(rangeStart, rangeEnd, confirmed);
      if (!confirmed && result.affectedOrders.length > 0) {
        setRangeWarning({ startDate: rangeStart, endDate: rangeEnd, orders: result.affectedOrders });
        return;
      }
      setRangeWarning(undefined);
    } catch (error) {
      setRangeError(error instanceof Error ? error.message : "日期修改失败，请重试");
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

  return (
    <main className="overview">
      <header className="hero">
        <div>
          <p className="eyebrow">{trip.title}</p>
          <h1>一鸣与美垚的旅行</h1>
          <p className="travelers">{trip.travelers.map((traveler) => traveler.name).join(" / ")}</p>
        </div>
        <dl className="trip-statuses">
          <div><dt>预算</dt><dd>{(trip.orders ?? []).length ? "已汇总订单" : "暂无订单数据"}</dd></div>
          <div><dt>预订</dt><dd>{(trip.orders ?? []).length ? "可在下方更新状态" : "尚未录入订单"}</dd></div>
        </dl>
        <button type="button" className="hotel-open" onClick={onOpenHotels}>酒店比较</button>
      </header>

      <section aria-labelledby="days-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">动态行程</p>
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
          </article>
        ) : (
          <p className="empty-state">请先新增一天</p>
        )}
      </section>

      {onChangeDateRange ? <section className="date-range" aria-labelledby="date-range-heading">
        <div><p className="eyebrow">日期</p><h2 id="date-range-heading">调整旅行日期</h2></div>
        <label>开始日期<input type="date" value={rangeStart} onChange={(event) => setRangeStart(event.target.value)} /></label>
        <label>结束日期<input type="date" value={rangeEnd} onChange={(event) => setRangeEnd(event.target.value)} /></label>
        <button type="button" onClick={() => void requestDateRange()} disabled={isSaving}>更新日期</button>
        {rangeError ? <p role="alert">{rangeError}</p> : null}
      </section> : null}

      {rangeWarning ? <dialog className="date-warning" open aria-modal="true" aria-labelledby="date-warning-title">
        <h2 id="date-warning-title">这些订单关联的旅行日将被移除</h2>
        <p>订单不会自动删除或改写。确认后只调整日期与行程日，请随后核对订单。</p>
        <ul>{rangeWarning.orders.map((order) => <li key={order.id}>{order.category === "hotel" ? "酒店" : "门票"} · {order.name}</li>)}</ul>
        <div><button type="button" className="danger-button" onClick={() => void requestDateRange(true)}>仍然调整日期</button><button type="button" onClick={() => setRangeWarning(undefined)}>保留当前日期</button></div>
      </dialog> : null}

      <div className="overview-sidepanels">
        <BudgetPanel trip={trip} />
        <OrdersPanel orders={trip.orders ?? []} onStatusChange={onOrderStatusChange} disabled={isSaving} />
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
