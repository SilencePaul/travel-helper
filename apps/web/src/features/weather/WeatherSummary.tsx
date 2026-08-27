import type { TravelDay } from "@travel/contracts";
import { useEffect, useMemo, useState } from "react";
import { forecastLabel, forecastStatusForDate, loadForecast, type ForecastStatus } from "./weather";

type WeatherSummaryProps = { days: TravelDay[]; compact?: boolean };

export function WeatherSummary({ days, compact = false }: WeatherSummaryProps) {
  const initialWeather = useMemo<Record<string, ForecastStatus>>(() => Object.fromEntries(days.map((day) => [day.id, forecastStatusForDate(day.date)])), [days]);
  const [weather, setWeather] = useState<Record<string, ForecastStatus | undefined>>({});
  useEffect(() => {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
    const readyDays = days.filter((day) => {
      const status = initialWeather[day.id];
      return status?.kind === "not-ready" && status.availableOn === today;
    });
    if (readyDays.length === 0) return;
    let active = true;
    void Promise.all(readyDays.map(async (day) => [day.id, await loadForecast(day.city, day.date)] as const)).then((entries) => {
      if (active) setWeather((current) => ({ ...current, ...Object.fromEntries(entries) }));
    }).catch(() => { if (active) setWeather({}); });
    return () => { active = false; };
  }, [days, initialWeather]);

  if (compact) {
    const status = days[0] ? weather[days[0].id] ?? initialWeather[days[0].id] : undefined;
    return <p className="weather-state">{status ? forecastLabel(status) : "正在获取天气"}</p>;
  }
  return (
    <section className="weather-summary" aria-labelledby="weather-heading">
      <div><p className="eyebrow">天气</p><h2 id="weather-heading">降雨提醒</h2></div>
      <p>预报开放后显示每日最高降雨概率与温度；临近出发再安排户外项目。</p>
      <ul>{days.map((day, index) => <li key={day.id}><b>D{index + 1} · {day.city || "待定"}</b><span>{weather[day.id] ?? initialWeather[day.id] ? forecastLabel(weather[day.id] ?? initialWeather[day.id]!) : "正在获取天气"}</span></li>)}</ul>
    </section>
  );
}
