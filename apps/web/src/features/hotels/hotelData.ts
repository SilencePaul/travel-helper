import hotelCatalog from "../../../../../content/hotels.json";
import { HotelSchema, type Hotel } from "@travel/contracts";

export const hongKongHotels: Hotel[] = HotelSchema.array().parse(hotelCatalog);
