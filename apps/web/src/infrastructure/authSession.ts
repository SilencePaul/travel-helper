import { getCloudbaseAuth } from "./cloudbaseClient";
import type { Member } from "@travel/contracts";

type AuthEnvironment = { VITE_AUTH_SERVICE_URL?: string };
type FetchLike = typeof fetch;

export function authServiceUrl(environment: AuthEnvironment = import.meta.env as AuthEnvironment) {
  const value = environment.VITE_AUTH_SERVICE_URL?.trim();
  if (!value) throw new Error("缺少独立 auth-service 地址");
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("auth-service 地址无效"); }
  const localHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !localHttp) throw new Error("auth-service 必须使用 HTTPS");
  return parsed.toString().replace(/\/$/, "");
}

export function startLogin(environment?: AuthEnvironment) {
  window.location.assign(authServiceUrl(environment) + "/api/auth/start");
}

async function jsonResponse<T>(response: Response): Promise<T> {
  let body: unknown;
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) {
    const error = new Error((body as { error?: string }).error || "AUTH_REQUEST_FAILED");
    (error as Error & { code?: string }).code = (body as { error?: string }).error;
    throw error;
  }
  return body as T;
}

export async function bootstrapWithCode(baseUrl: string, code: string, oauthState: string, fetchImpl: FetchLike = fetch) {
  const response = await fetchImpl(baseUrl.replace(/\/$/, "") + "/api/auth/bootstrap", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, oauthState }),
  });
  return jsonResponse<{ role: "admin" }>(response);
}

export async function requestCustomTicket(baseUrl = authServiceUrl(), fetchImpl: FetchLike = fetch) {
  const response = await fetchImpl(baseUrl.replace(/\/$/, "") + "/api/auth/ticket", { method: "POST", credentials: "include" });
  return (await jsonResponse<{ ticket: string }>(response)).ticket;
}

export async function getCurrentProfile(baseUrl = authServiceUrl(), fetchImpl: FetchLike = fetch) {
  const response = await fetchImpl(baseUrl.replace(/\/$/, "") + "/api/auth/profile", { method: "GET", credentials: "include" });
  return (await jsonResponse<{ member: Member }>(response)).member;
}

export async function signInWithCustomTicket(baseUrl = authServiceUrl()) {
  return getCloudbaseAuth().signInWithCustomTicket(() => requestCustomTicket(baseUrl));
}

export async function logout(baseUrl = authServiceUrl(), fetchImpl: FetchLike = fetch) {
  await fetchImpl(baseUrl.replace(/\/$/, "") + "/api/auth/logout", { method: "POST", credentials: "include" });
  await getCloudbaseAuth().signOut();
}
