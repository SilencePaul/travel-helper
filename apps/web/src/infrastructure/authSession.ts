import { getCloudbaseAuth, getCloudbaseClient } from "./cloudbaseClient";
import { MemberSchema, type Member } from "@travel/contracts";

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

function authRoute(baseUrl: string, route: string) {
  const base = baseUrl.replace(/\/$/, "");
  return (base.endsWith("/api/auth") ? base : base + "/api/auth") + route;
}

export function startLogin(environment?: AuthEnvironment) {
  window.location.assign(authRoute(authServiceUrl(environment), "/start"));
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
  const response = await fetchImpl(authRoute(baseUrl, "/bootstrap"), {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, oauthState }),
  });
  return jsonResponse<{ role: "admin" }>(response);
}

export async function requestCustomTicket(baseUrl = authServiceUrl(), fetchImpl: FetchLike = fetch) {
  const response = await fetchImpl(authRoute(baseUrl, "/ticket"), { method: "POST", credentials: "include" });
  return (await jsonResponse<{ ticket: string }>(response)).ticket;
}

export async function getCurrentProfile(baseUrl = authServiceUrl(), fetchImpl: FetchLike = fetch) {
  const response = await fetchImpl(authRoute(baseUrl, "/profile"), { method: "GET", credentials: "include" });
  return (await jsonResponse<{ member: Member }>(response)).member;
}

export async function exchangeAuthenticationCode(baseUrl: string, code: string, fetchImpl: FetchLike = fetch) {
  const response = await fetchImpl(authRoute(baseUrl, "/exchange"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const body = await jsonResponse<{ member?: unknown; ticket?: unknown }>(response);
  const member = MemberSchema.safeParse(body.member);
  if (!member.success || typeof body.ticket !== "string" || !body.ticket) {
    throw Object.assign(new Error("INVALID_EXCHANGE_RESPONSE"), { code: "INVALID_EXCHANGE_RESPONSE" });
  }
  return { member: member.data, ticket: body.ticket };
}

type TicketAuth = {
  signOut: () => Promise<unknown>;
  signInWithCustomTicket: (getTicket: () => Promise<string>) => Promise<unknown>;
  getCurrentUser: () => Promise<unknown>;
};

export async function signInWithIssuedTicket(ticket: string, expectedUid: string, auth: TicketAuth = getCloudbaseAuth()) {
  await auth.signOut();
  await auth.signInWithCustomTicket(() => Promise.resolve(ticket));
  const current = await auth.getCurrentUser();
  const uid = current && typeof current === "object" && "uid" in current ? (current as { uid?: unknown }).uid : undefined;
  if (uid !== expectedUid) throw Object.assign(new Error("AUTH_REQUIRED"), { code: "AUTH_REQUIRED" });
}

type CallFunctionLike = (options: { name: string; data: Record<string, unknown> }) => Promise<{ result?: unknown }>;

export async function getCurrentCloudbaseMember(callFunction: CallFunctionLike = (options) => getCloudbaseClient().callFunction(options)) {
  const response = await callFunction({ name: "trip-api", data: { action: "getCurrentMember" } });
  const result = response?.result;
  const code = result && typeof result === "object" && "error" in result ? (result as { error?: unknown }).error : undefined;
  if (typeof code === "string") throw Object.assign(new Error(code), { code });
  const parsed = MemberSchema.safeParse(result && typeof result === "object" && "member" in result ? (result as { member?: unknown }).member : undefined);
  if (!parsed.success) throw Object.assign(new Error("AUTH_REQUIRED"), { code: "AUTH_REQUIRED" });
  return parsed.data;
}

export async function signInWithCustomTicket(baseUrl = authServiceUrl()) {
  return getCloudbaseAuth().signInWithCustomTicket(() => requestCustomTicket(baseUrl));
}

type RecoveryDependencies = {
  getCurrentUser?: () => Promise<unknown>;
  getMember?: () => Promise<Member>;
};

export async function recoverAuthenticatedMember({
  getCurrentUser = () => getCloudbaseAuth().getCurrentUser(),
  getMember = () => getCurrentCloudbaseMember(),
}: RecoveryDependencies = {}) {
  const current = await getCurrentUser();
  if (!current) throw Object.assign(new Error("AUTH_REQUIRED"), { code: "AUTH_REQUIRED" });
  return getMember();
}

export async function logout(baseUrl = authServiceUrl(), fetchImpl: FetchLike = fetch, auth: Pick<TicketAuth, "signOut"> = getCloudbaseAuth()) {
  try {
    await fetchImpl(authRoute(baseUrl, "/logout"), { method: "POST", credentials: "include" });
  } catch {
    // The first-party CloudBase session is the source of truth for approved users.
    // An unavailable legacy cookie endpoint must not trap the user in a local session.
  } finally {
    await auth.signOut();
  }
}
