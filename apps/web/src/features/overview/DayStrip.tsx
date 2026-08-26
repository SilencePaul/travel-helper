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
import type { CSSProperties } from "react";
import type { TravelDay } from "@travel/contracts";

type DayStripProps = {
  days: TravelDay[];
  selectedDayId: string | undefined;
  onSelectDay: (dayId: string) => void;
  onMoveDay: (activeDayId: string, overDayId: string) => void;
};

type SortableDayProps = {
  day: TravelDay;
  dayNumber: number;
  selected: boolean;
  onSelectDay: (dayId: string) => void;
};

function SortableDay({ day, dayNumber, selected, onSelectDay }: SortableDayProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: day.id });
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
        type="button"
        role="tab"
        aria-selected={selected}
        className="day-tab"
        onClick={() => onSelectDay(day.id)}
      >
        <strong>D{dayNumber}</strong>
        <span>{day.date}</span>
        <span>{day.city || "待安排"}</span>
        <small>待预报</small>
      </button>
      <button
        type="button"
        className="drag-handle"
        aria-label={`拖动 D${dayNumber}`}
        {...attributes}
        {...listeners}
      >
        拖动
      </button>
    </li>
  );
}

export function DayStrip({ days, selectedDayId, onSelectDay, onMoveDay }: DayStripProps) {
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    if (event.over && event.active.id !== event.over.id) {
      onMoveDay(String(event.active.id), String(event.over.id));
    }
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={days.map((day) => day.id)} strategy={horizontalListSortingStrategy}>
        <ol className="day-strip" role="tablist" aria-label="旅行日期">
          {days.map((day, index) => (
            <SortableDay
              key={day.id}
              day={day}
              dayNumber={index + 1}
              selected={day.id === selectedDayId}
              onSelectDay={onSelectDay}
            />
          ))}
        </ol>
      </SortableContext>
    </DndContext>
  );
}
