import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type RefCallback,
} from "react";
import type { TravelDay } from "@travel/contracts";
import { getDayPanelId, getDayTabId } from "./dayTabIds";

type DayStripProps = {
  days: TravelDay[];
  selectedDayId: string | undefined;
  onSelectDay: (dayId: string) => void;
  onMoveDay: (activeDayId: string, overDayId: string) => void;
  disabled?: boolean;
};

type SortableDayProps = {
  day: TravelDay;
  dayNumber: number;
  selected: boolean;
  tabStop: boolean;
  onSelectDay: (dayId: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  tabRef: RefCallback<HTMLButtonElement>;
  handleRef: RefCallback<HTMLButtonElement>;
  disabled: boolean;
};

function SortableDay({
  day,
  dayNumber,
  selected,
  tabStop,
  onSelectDay,
  onKeyDown,
  tabRef,
  handleRef,
  disabled,
}: SortableDayProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: day.id, disabled });
  const style: CSSProperties = {
    transform: transform
      ? `translate3d(${String(transform.x)}px, ${String(transform.y)}px, 0)`
      : undefined,
    transition,
    zIndex: isDragging ? 1 : undefined,
  };

  return (
    <li ref={setNodeRef} className="day-tab-wrap" style={style}>
      <button
        ref={tabRef}
        id={getDayTabId(day.id)}
        type="button"
        role="tab"
        aria-selected={selected}
        aria-controls={getDayPanelId(day.id)}
        tabIndex={tabStop ? 0 : -1}
        className="day-tab"
        data-current={selected ? "true" : undefined}
        onClick={() => onSelectDay(day.id)}
        onKeyDown={onKeyDown}
      >
        <strong>D{dayNumber}</strong>
        <span>{day.date}</span>
        <span>{day.city || "待安排"}</span>
        <small>待预报</small>
      </button>
      <button
        ref={handleRef}
        type="button"
        className="drag-handle"
        aria-label={`拖动 D${dayNumber}`}
        {...attributes}
        {...(disabled ? {} : listeners)}
        aria-disabled={disabled}
      >
        拖动
      </button>
    </li>
  );
}

export function DayStrip({
  days,
  selectedDayId,
  onSelectDay,
  onMoveDay,
  disabled = false,
}: DayStripProps) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const handleRefs = useRef(new Map<string, HTMLButtonElement>());
  const lastDroppedDayIdRef = useRef<string | undefined>(undefined);
  const [rovingState, setRovingState] = useState({
    selectedDayId,
    requestedTabStopId: selectedDayId,
  });
  if (rovingState.selectedDayId !== selectedDayId) {
    setRovingState({
      selectedDayId,
      requestedTabStopId: selectedDayId,
    });
  }
  const requestedTabStopId = rovingState.selectedDayId === selectedDayId
    ? rovingState.requestedTabStopId
    : selectedDayId;
  const tabStopId = days.some((day) => day.id === requestedTabStopId)
    ? requestedTabStopId
    : selectedDayId;
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useLayoutEffect(() => {
    const dayId = lastDroppedDayIdRef.current;
    if (!dayId) return;
    handleRefs.current.get(dayId)?.focus();
    if (!disabled) lastDroppedDayIdRef.current = undefined;
  }, [days, disabled]);

  function handleDragEnd(event: DragEndEvent) {
    if (!disabled && event.over && event.active.id !== event.over.id) {
      const activeDayId = String(event.active.id);
      lastDroppedDayIdRef.current = activeDayId;
      onMoveDay(activeDayId, String(event.over.id));
    }
  }

  function handleTabKeyDown(index: number, event: KeyboardEvent<HTMLButtonElement>) {
    let targetIndex: number | undefined;
    if (event.key === "ArrowRight") targetIndex = (index + 1) % days.length;
    if (event.key === "ArrowLeft") targetIndex = (index - 1 + days.length) % days.length;
    if (event.key === "Home") targetIndex = 0;
    if (event.key === "End") targetIndex = days.length - 1;
    if (targetIndex === undefined) return;
    event.preventDefault();
    setRovingState({
      selectedDayId,
      requestedTabStopId: days[targetIndex]?.id,
    });
    tabRefs.current[targetIndex]?.focus();
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={days.map((day) => day.id)} strategy={horizontalListSortingStrategy}>
        <ol className="day-strip" role="tablist" aria-label="旅行日期">
          {days.map((day, index) => (
            <SortableDay
              key={day.id}
              day={day}
              dayNumber={index + 1}
              selected={day.id === selectedDayId}
              tabStop={day.id === tabStopId}
              onSelectDay={onSelectDay}
              onKeyDown={(event) => handleTabKeyDown(index, event)}
              tabRef={(element) => {
                tabRefs.current[index] = element;
              }}
              handleRef={(element) => {
                if (element) handleRefs.current.set(day.id, element);
                else handleRefs.current.delete(day.id);
              }}
              disabled={disabled}
            />
          ))}
        </ol>
      </SortableContext>
    </DndContext>
  );
}
