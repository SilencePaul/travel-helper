import {
  addDays,
  differenceInCalendarDays,
  formatISO,
  isValid,
  parseISO,
} from "date-fns";
import type { TravelDay } from "./trip";

export type ReconcileDaysResult = {
  days: TravelDay[];
  unscheduledItemIds: string[];
};

export type DayIdFactory = () => string;

function parseDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("日期格式无效");
  }

  const parsed = parseISO(date);
  if (!isValid(parsed) || formatISO(parsed, { representation: "date" }) !== date) {
    throw new Error("日期格式无效");
  }

  return parsed;
}

function assertDayDates(days: TravelDay[]) {
  days.forEach((day) => parseDate(day.date));
}

function assertUniqueDayDates(days: TravelDay[]) {
  const dates = new Set<string>();
  for (const day of days) {
    if (dates.has(day.date)) {
      throw new Error("日期不能重复");
    }
    dates.add(day.date);
  }
}

function createGeneratedDayId(date: string, existingIds: Set<string>) {
  const baseId = `day-${date}`;
  let id = baseId;
  let suffix = 2;
  while (existingIds.has(id)) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }
  existingIds.add(id);
  return id;
}

function assertIndex(index: number, length: number, allowEnd = false) {
  const maximum = allowEnd ? length : length - 1;
  if (!Number.isInteger(index) || index < 0 || index > maximum) {
    throw new Error("日期索引无效");
  }
}

function assertUnusedDayId(days: TravelDay[], id: string) {
  if (!id || days.some((day) => day.id === id)) {
    throw new Error("日期 ID 必须唯一且非空");
  }
}

function reassignDates(days: TravelDay[], start: string): TravelDay[] {
  const startDate = parseDate(start);
  assertDayDates(days);

  return days.map((day, index) => ({
    ...day,
    date: formatISO(addDays(startDate, index), { representation: "date" }),
  }));
}

export function reconcileDays(
  current: TravelDay[],
  start: string,
  end: string,
  existingUnscheduledItemIds: string[] = [],
): ReconcileDaysResult {
  const startDate = parseDate(start);
  const endDate = parseDate(end);
  const count = differenceInCalendarDays(endDate, startDate) + 1;
  if (count < 1) {
    throw new Error("结束日期不能早于开始日期");
  }

  assertDayDates(current);
  assertUniqueDayDates(current);
  const byDate = new Map(current.map((day) => [day.date, day]));
  const existingIds = new Set(current.map((day) => day.id));
  const dates = Array.from({ length: count }, (_, index) =>
    formatISO(addDays(startDate, index), { representation: "date" }),
  );
  const days = dates.map(
    (date, index) =>
      byDate.get(date) ?? {
        id: createGeneratedDayId(date, existingIds),
        date,
        city: index === 0 ? "待安排" : "",
        itemIds: [],
      },
  );
  const retained = new Set(dates);
  const unscheduledItemIds = current
    .filter((day) => !retained.has(day.date))
    .flatMap((day) => day.itemIds);

  return {
    days,
    unscheduledItemIds: [...new Set([...existingUnscheduledItemIds, ...unscheduledItemIds])],
  };
}

export function insertDay(
  current: TravelDay[],
  index: number,
  start: string,
  id: string,
): TravelDay[] {
  assertIndex(index, current.length, true);
  assertUnusedDayId(current, id);
  const days = current.slice();
  days.splice(index, 0, { id, date: start, city: "", itemIds: [] });

  return reassignDates(days, start);
}

export function appendDay(
  current: TravelDay[],
  start: string,
  id: string,
): TravelDay[] {
  const startDate = parseDate(start);
  assertDayDates(current);
  assertUniqueDayDates(current);
  assertUnusedDayId(current, id);
  const latestDate = current.reduce<string | undefined>(
    (latest, day) => !latest || day.date > latest ? day.date : latest,
    undefined,
  );
  const date = latestDate
    ? formatISO(addDays(parseDate(latestDate), 1), { representation: "date" })
    : formatISO(startDate, { representation: "date" });

  return [...current, { id, date, city: "", itemIds: [] }];
}

export function duplicateDay(
  current: TravelDay[],
  index: number,
  start: string,
  createId: DayIdFactory,
): TravelDay[] {
  assertIndex(index, current.length);
  const source = current[index];
  if (!source) {
    throw new Error("日期索引无效");
  }

  const id = createId();
  assertUnusedDayId(current, id);
  const days = current.slice();
  days.splice(index + 1, 0, { ...source, id, itemIds: [...source.itemIds] });

  return reassignDates(days, start);
}

export function moveDay(
  current: TravelDay[],
  fromIndex: number,
  toIndex: number,
  start: string,
): TravelDay[] {
  assertIndex(fromIndex, current.length);
  assertIndex(toIndex, current.length);
  const days = current.slice();
  const [moved] = days.splice(fromIndex, 1);
  if (!moved) {
    throw new Error("日期索引无效");
  }
  days.splice(toIndex, 0, moved);

  return reassignDates(days, start);
}

export function removeDay(
  current: TravelDay[],
  index: number,
  unscheduledItemIds: string[],
): ReconcileDaysResult {
  assertDayDates(current);
  assertIndex(index, current.length);
  const removed = current[index];
  if (!removed) {
    throw new Error("日期索引无效");
  }

  const days = current.filter((_, dayIndex) => dayIndex !== index);
  const scheduledItemIds = new Set(days.flatMap((day) => day.itemIds));

  return {
    days,
    unscheduledItemIds: [...new Set([...unscheduledItemIds, ...removed.itemIds])]
      .filter((itemId) => !scheduledItemIds.has(itemId)),
  };
}
