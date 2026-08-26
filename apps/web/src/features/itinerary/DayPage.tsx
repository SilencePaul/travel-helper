import type { Trip } from "@travel/contracts";
import { Timeline } from "./Timeline";

type DayPageProps = {
  trip: Trip;
  dayId: string | undefined;
  onBack: () => void;
};

export function DayPage({ trip, dayId, onBack }: DayPageProps) {
  const dayIndex = trip.days.findIndex((day) => day.id === dayId);
  const day = trip.days[dayIndex];

  if (!day) {
    return (
      <main className="day-page narrow-page">
        <p className="eyebrow">行程未找到</p>
        <h1>这一天不在当前旅行计划中</h1>
        <button type="button" onClick={onBack}>返回行程总览</button>
      </main>
    );
  }

  return (
    <main className="day-page narrow-page">
      <button type="button" className="back-button" onClick={onBack}>
        ← 返回行程总览
      </button>
      <header>
        <p className="eyebrow">D{dayIndex + 1} · {day.date}</p>
        <h1>{day.city || "待安排"}</h1>
        <p className="weather-state">待预报</p>
      </header>
      <section aria-labelledby="timeline-heading">
        <h2 id="timeline-heading">当天行程</h2>
        <Timeline itemIds={day.itemIds} />
      </section>
    </main>
  );
}
