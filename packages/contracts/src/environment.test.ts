import { describe, expect, it } from "vitest";
import { ClientEnvironmentSchema, ServerEnvironmentSchema } from "./environment";

describe("ClientEnvironmentSchema", () => {
  it("allows local mode without a CloudBase environment ID and strips server values", () => {
    const result = ClientEnvironmentSchema.parse({
      VITE_DATA_MODE: " local ",
      FEISHU_APP_SECRET: "server-only",
    });

    expect(result).toEqual({ VITE_DATA_MODE: "local" });
  });

  it("requires a nonempty CloudBase environment ID in cloudbase mode", () => {
    expect(() => ClientEnvironmentSchema.parse({ VITE_DATA_MODE: "cloudbase" })).toThrow();
    expect(() => ClientEnvironmentSchema.parse({
      VITE_DATA_MODE: "cloudbase",
      VITE_CLOUDBASE_ENV_ID: "travel-prod-123",
    })).toThrow();
    expect(ClientEnvironmentSchema.parse({
      VITE_DATA_MODE: "cloudbase",
      VITE_CLOUDBASE_ENV_ID: "  travel-prod-123  ",
      VITE_AUTH_SERVICE_URL: " https://auth.example.com ",
    })).toEqual({
      VITE_DATA_MODE: "cloudbase",
      VITE_CLOUDBASE_ENV_ID: "travel-prod-123",
      VITE_AUTH_SERVICE_URL: "https://auth.example.com",
    });
  });
});

describe("ServerEnvironmentSchema", () => {
  const valid = {
    VITE_CLOUDBASE_ENV_ID: "travel-prod-123",
    FEISHU_APP_ID: "cli_example",
    FEISHU_APP_SECRET: "secret",
    FEISHU_REDIRECT_URI: "https://example.com/api/auth/feishu/callback",
    PUBLIC_APP_URL: "https://example.com",
    ADMIN_BOOTSTRAP_CODE: "bootstrap-code",
    AUTH_SESSION_SECRET: "session-secret",
    CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS: "{\"private_key\":\"secret\"}",
  };

  it("trims required values and accepts a JSON credential object", () => {
    const result = ServerEnvironmentSchema.parse({
      ...valid,
      FEISHU_APP_ID: "  cli_example  ",
      CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS: "  {\"private_key\":\"secret\"}  ",
    });

    expect(result.FEISHU_APP_ID).toBe("cli_example");
    expect(result.CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS).toBe("{\"private_key\":\"secret\"}");
  });

  it.each(["not-json", "null", "[]", "\"credential\"", "1"])(
    "rejects a custom-login credential that is not a JSON object",
    (credentials) => {
      expect(() => ServerEnvironmentSchema.parse({
        ...valid,
        CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS: credentials,
      })).toThrow();
    },
  );

  it.each([
    "VITE_CLOUDBASE_ENV_ID",
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_REDIRECT_URI",
    "PUBLIC_APP_URL",
    "ADMIN_BOOTSTRAP_CODE",
    "AUTH_SESSION_SECRET",
    "CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS",
  ] as const)("rejects blank required %s", (field) => {
    expect(() => ServerEnvironmentSchema.parse({ ...valid, [field]: "   " })).toThrow();
  });
});
