import type { Trip } from "@travel/contracts";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { DayStrip } from "./DayStrip";
import { getDayPanelId, getDayTabId } from "./dayTabIds";

export type OverviewPageProps = {
  trip: Trip;
  selectedDayId: string | undefined;
  onSelectDay: (dayId: string) => void;
  onAddDay: () => void | Promise<unknown>;
  onDuplicateDay: () => void | Promise<unknown>;
  onDeleteDay: () => void | Promise<unknown>;
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
  const [deleteDayId, setDeleteDayId] = useState<string>();
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const requestedIndex = trip.days.findIndex((day) => day.id === selectedDayId);
  const selectedIndex = requestedIndex >= 0 ? requestedIndex : trip.days.length > 0 ? 0 : -1;
  const selectedDay = trip.days[selectedIndex];
  const dialogOpen = deleteDayId === selectedDay?.id && Boolean(selectedDay);

  useEffect(() => {
    if (dialogOpen) cancelButtonRef.current?.focus();
  }, [dialogOpen]);

  function cancelDelete() {
    setDeleteDayId(undefined);
    deleteTriggerRef.current?.focus();
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelDelete();
      return;
    }
    if (event.key !== "Tab") return;
    if (!event.shiftKey && document.activeElement === cancelButtonRef.current) {
      event.preventDefault();
      confirmButtonRef.current?.focus();
    } else if (event.shiftKey && document.activeElement === confirmButtonRef.current) {
      event.preventDefault();
      cancelButtonRef.current?.focus();
    }
  }

  async function confirmDelete() {
    setDeleteDayId(undefined);
    await onDeleteDay();
    window.setTimeout(() => {
      document.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
    }, 0);
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
              onClick={() => setDeleteDayId(selectedDay?.id)}
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

        {dialogOpen && selectedDay ? (
          <div
            className="delete-confirmation"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={`delete-title-${selectedDay.id}`}
            aria-describedby={`delete-description-${selectedDay.id}`}
            onKeyDown={handleDialogKeyDown}
          >
            <div className="delete-copy">
              <h3 id={`delete-title-${selectedDay.id}`}>删除 D{selectedIndex + 1}</h3>
              <p id={`delete-description-${selectedDay.id}`}>确定删除 D{selectedIndex + 1} 吗？</p>
            </div>
            <div>
              <button
                ref={confirmButtonRef}
                type="button"
                className="danger-button"
                onClick={() => void confirmDelete()}
              >
                确认删除
              </button>
              <button ref={cancelButtonRef} type="button" onClick={cancelDelete}>取消</button>
            </div>
          </div>
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
