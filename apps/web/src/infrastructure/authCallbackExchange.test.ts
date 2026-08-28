import { describe, expect, it, vi } from "vitest";
import { AUTH_EXCHANGE_STORAGE_KEY, readStagedAuthenticationExchange, stageAuthenticationExchangeFromUrl } from "./authCallbackExchange";

describe("authentication callback URL hygiene", () => {
  it("moves the exchange capability out of the URL before service-worker registration", () => {
    const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
    const replaceState = vi.fn();

    stageAuthenticationExchangeFromUrl({
      href: "https://trip.example/?auth_callback=1&state=s&exchange_code=secret-code",
      pathname: "/",
      search: "?auth_callback=1&state=s&exchange_code=secret-code",
      hash: "",
    }, storage, { replaceState });

    expect(storage.setItem).toHaveBeenCalledWith(AUTH_EXCHANGE_STORAGE_KEY, "secret-code");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?auth_callback=1&state=s");
  });

  it("reads a staged code when the sanitized query no longer contains it", () => {
    const storage = { getItem: vi.fn().mockReturnValue("staged-code"), setItem: vi.fn(), removeItem: vi.fn() };
    expect(readStagedAuthenticationExchange("?auth_callback=1", storage)).toBe("staged-code");
  });
});
