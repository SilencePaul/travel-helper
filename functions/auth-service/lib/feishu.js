const { z } = require("zod");

const TenantTokenResponse = z.object({ code: z.number(), tenant_access_token: z.string().min(1) });
const UserTokenResponse = z.object({ code: z.number(), data: z.object({ access_token: z.string().min(1) }) });
const UserInfoResponse = z.object({
  code: z.number(),
  data: z.object({
    open_id: z.string().min(1),
    name: z.string().trim().min(1).max(100),
    avatar_url: z.string().url().optional(),
  }),
});

function providerError() {
  const error = new Error("AUTH_PROVIDER_ERROR");
  error.code = "AUTH_PROVIDER_ERROR";
  return error;
}

async function readProviderResponse(response, schema) {
  const status = Number(response?.status);
  if (!response || response.ok === false || (Number.isFinite(status) && (status < 200 || status >= 300))) throw providerError();
  let payload;
  try { payload = await response.json(); } catch { throw providerError(); }
  const parsed = schema.safeParse(payload);
  if (!parsed.success || parsed.data.code !== 0) throw providerError();
  return parsed.data;
}

function createFeishuClient({ env, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== "function") throw new Error("AUTH_FETCH_UNAVAILABLE");
  async function getTenantAccessToken() {
    const response = await fetchImpl("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
    });
    return (await readProviderResponse(response, TenantTokenResponse)).tenant_access_token;
  }
  async function exchangeAuthorizationCode(code) {
    if (typeof code !== "string" || code.length < 1 || code.length > 2048) throw providerError();
    const tenantToken = await getTenantAccessToken();
    const response = await fetchImpl("https://open.feishu.cn/open-apis/authen/v1/oidc/access_token", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer " + tenantToken },
      body: JSON.stringify({ grant_type: "authorization_code", code }),
    });
    return (await readProviderResponse(response, UserTokenResponse)).data.access_token;
  }
  async function getUserInfo(userAccessToken) {
    const response = await fetchImpl("https://open.feishu.cn/open-apis/authen/v1/user_info", {
      headers: { Authorization: "Bearer " + userAccessToken },
    });
    const user = (await readProviderResponse(response, UserInfoResponse)).data;
    return { openId: user.open_id, displayName: user.name, ...(user.avatar_url ? { avatarUrl: user.avatar_url } : {}) };
  }
  return { async resolveAuthorizationCode(code) {
    const userAccessToken = await exchangeAuthorizationCode(code);
    return getUserInfo(userAccessToken);
  } };
}

module.exports = { createFeishuClient, providerError };
