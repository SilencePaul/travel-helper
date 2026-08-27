export type ForecastStatus =
  | { kind: "not-ready"; availableOn: string }
  | { kind: "forecast"; precipitationProbability: number; temperatureMin: number; temperatureMax: number; weatherCode: number };

const maxForecastDays = 16;

const cityCoordinates: Record<string, { latitude: number; longitude: number }> = {
  深圳: { latitude: 22.5431, longitude: 114.0579 },
  香港: { latitude: 22.3193, longitude: 114.1694 },
  澳门: { latitude: 22.1987, longitude: 113.5439 },
  珠海: { latitude: 22.271, longitude: 113.5767 },
};

function dateOnly(value: Date) {
  return value.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function forecastStatusForDate(date: string, now = new Date()): ForecastStatus {
  const today = dateOnly(now);
  if (date > addDays(today, maxForecastDays - 1)) return { kind: "not-ready", availableOn: addDays(date, -(maxForecastDays - 1)) };
  return { kind: "not-ready", availableOn: today };
}

type ForecastPayload = {
  daily?: {
    time?: string[];
    precipitation_probability_max?: number[];
    temperature_2m_min?: number[];
    temperature_2m_max?: number[];
    weather_code?: number[];
  };
};

export function parseForecast(payload: ForecastPayload, date: string): ForecastStatus | undefined {
  const index = payload.daily?.time?.indexOf(date) ?? -1;
  if (index < 0) return undefined;
  const precipitationProbability = payload.daily?.precipitation_probability_max?.[index];
  const temperatureMin = payload.daily?.temperature_2m_min?.[index];
  const temperatureMax = payload.daily?.temperature_2m_max?.[index];
  const weatherCode = payload.daily?.weather_code?.[index];
  if (![precipitationProbability, temperatureMin, temperatureMax, weatherCode].every(Number.isFinite)) return undefined;
  return { kind: "forecast", precipitationProbability: Math.round(precipitationProbability!), temperatureMin: Math.round(temperatureMin!), temperatureMax: Math.round(temperatureMax!), weatherCode: Math.round(weatherCode!) };
}

export function forecastLabel(status: ForecastStatus) {
  if (status.kind === "not-ready") {
    const [, month, day] = status.availableOn.split("-");
    return `${Number(month)}月${Number(day)}日起可预报`;
  }
  return `降雨 ${status.precipitationProbability}% · ${status.temperatureMin}–${status.temperatureMax}°C`;
}

export async function loadForecast(city: string, date: string, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<ForecastStatus | undefined> {
  const pending = forecastStatusForDate(date, now);
  if (pending.kind === "not-ready" && pending.availableOn !== dateOnly(now)) return pending;
  const coordinate = Object.entries(cityCoordinates).find(([name]) => city.includes(name))?.[1];
  if (!coordinate) return undefined;
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(coordinate.latitude));
  url.searchParams.set("longitude", String(coordinate.longitude));
  url.searchParams.set("daily", "temperature_2m_min,temperature_2m_max,precipitation_probability_max,weather_code");
  url.searchParams.set("timezone", "Asia/Shanghai");
  url.searchParams.set("forecast_days", String(maxForecastDays));
  const response = await fetchImpl(url);
  if (!response.ok) return undefined;
  return parseForecast(await response.json() as ForecastPayload, date);
}
