function safeDayId(dayId: string) {
  return encodeURIComponent(dayId);
}

export function getDayTabId(dayId: string) {
  return `day-tab-${safeDayId(dayId)}`;
}

export function getDayPanelId(dayId: string) {
  return `day-panel-${safeDayId(dayId)}`;
}
