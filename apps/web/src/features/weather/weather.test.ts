import { describe, expect, it } from "vitest";
import { forecastLabel, forecastStatusForDate, loadForecast, parseForecast } from "./weather";

describe("forecastStatusForDate", () => {
  it("shows when a future travel date enters the 16-day forecast window", () => {
    expect(forecastStatusForDate("2026-10-03", new Date("2026-08-27T12:00:00+08:00"))).toEqual({
      kind: "not-ready",
      availableOn: "2026-09-18",
    });
  });
});

describe("loadForecast", () => {
  it("requests a 16-day daily forecast for a supported travel city", async () => {
    const fetchMock: typeof fetch = async (url) => {
      expect(String(url)).toContain("latitude=22.3193");
      expect(String(url)).toContain("precipitation_probability_max");
      return new Response(JSON.stringify({ daily: {
        time: ["2026-10-03"], precipitation_probability_max: [30], temperature_2m_min: [24], temperature_2m_max: [30], weather_code: [2],
      } }));
    };
    await expect(loadForecast("香港", "2026-10-03", fetchMock, new Date("2026-10-01T12:00:00+08:00"))).resolves.toMatchObject({
      kind: "forecast", precipitationProbability: 30,
    });
  });
});

describe("parseForecast", () => {
  it("uses the daily maximum precipitation probability for the matching day", () => {
    expect(parseForecast({
      daily: {
        time: ["2026-10-03", "2026-10-04"],
        precipitation_probability_max: [70, 10],
        temperature_2m_min: [24.3, 25.1],
        temperature_2m_max: [29.8, 30.2],
        weather_code: [61, 1],
      },
    }, "2026-10-03")).toEqual({
      kind: "forecast",
      precipitationProbability: 70,
      temperatureMin: 24,
      temperatureMax: 30,
      weatherCode: 61,
    });
  });
});

describe("forecastLabel", () => {
  it("does not label an unavailable date as pending without a date", () => {
    expect(forecastLabel({ kind: "not-ready", availableOn: "2026-09-18" })).toBe("9月18日起可预报");
  });
});
