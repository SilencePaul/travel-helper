import { render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { hongKongHotels } from "./hotelData";
import { AmapHotelMap } from "./AmapHotelMap";

it("creates real AMap markers from hotel coordinates and centers the selected hotel", async () => {
  const marker = vi.fn(); const setCenter = vi.fn();
  const api = { Map: class { destroy = vi.fn(); setFitView = vi.fn(); setCenter = setCenter; }, Marker: class { constructor(options: unknown) { marker(options); } on() {} } };
  render(<AmapHotelMap hotels={hongKongHotels} selectedId="park-hotel-hong-kong" onSelect={() => undefined} mapLoader={async () => api} />);
  await waitFor(() => expect(marker).toHaveBeenCalledTimes(2));
  expect(marker).toHaveBeenCalledWith(expect.objectContaining({ position: [114.1722, 22.2972] }));
  expect(marker).toHaveBeenCalledWith(expect.objectContaining({ position: [114.1747, 22.2989], zIndex: 200, content: expect.stringContaining("is-selected") }));
  await waitFor(() => expect(setCenter).toHaveBeenCalledWith([114.1747, 22.2989]));
});
