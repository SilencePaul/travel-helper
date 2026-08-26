import type { Trip } from "@travel/contracts";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { DayStrip } from "./DayStrip";
import { getDayPanelId, getDayTabId } from "./dayTabIds";

export type OverviewPageProps = {
  trip: Trip;
  selectedDayId: string | undefined;
  onSelectDay: (dayId: string) => void;
  onAddDay: () => void | Promise<unknown>;
  onDuplicateDay: () => void | Promise<unknown>;
  onDeleteDay: (dayId: string) => void | Promise<unknown>;
  onMoveDay: (activeDayId: string, overDayId: string) => void | Promise<unknown>;
  isSaving?: boolean;
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
}: OverviewPageProps) {
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; dayNumber: number }>();
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
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
          <div><dt>预算</dt><dd>预算数据尚未接入</dd></div>
          <div><dt>预订</dt><dd>预订数据尚未接入</dd></div>
        </dl>
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
