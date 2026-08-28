export const AUTH_EXCHANGE_STORAGE_KEY = "travel-auth-exchange-code";

type CallbackLocation = Pick<Location, "href" | "pathname" | "search" | "hash">;
type CallbackStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type CallbackHistory = { replaceState(data: unknown, unused: string, url?: string | URL | null): void };

export function stageAuthenticationExchangeFromUrl(location: CallbackLocation, storage: CallbackStorage, history: CallbackHistory) {
  const params = new URLSearchParams(location.search);
  const exchangeCode = params.get("exchange_code");
  if (!exchangeCode) return;
  storage.setItem(AUTH_EXCHANGE_STORAGE_KEY, exchangeCode);
  params.delete("exchange_code");
  const query = params.toString();
  history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
}

export function readStagedAuthenticationExchange(search: string, storage: CallbackStorage) {
  return new URLSearchParams(search).get("exchange_code") || storage.getItem(AUTH_EXCHANGE_STORAGE_KEY);
}

export function clearStagedAuthenticationExchange(storage: CallbackStorage) {
  storage.removeItem(AUTH_EXCHANGE_STORAGE_KEY);
}
