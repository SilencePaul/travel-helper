import { z } from "zod";

const NonEmptyEnvironmentValueSchema = z.string().trim().min(1);

export const ClientEnvironmentSchema = z.object({
  VITE_DATA_MODE: z.string().trim().pipe(z.enum(["local", "cloudbase"])),
  VITE_CLOUDBASE_ENV_ID: NonEmptyEnvironmentValueSchema.optional(),
  VITE_AUTH_SERVICE_URL: NonEmptyEnvironmentValueSchema.optional(),
}).superRefine((environment, context) => {
  if (environment.VITE_DATA_MODE === "cloudbase" && !environment.VITE_CLOUDBASE_ENV_ID) {
    context.addIssue({
      code: "custom",
      message: "CloudBase 模式需要 VITE_CLOUDBASE_ENV_ID",
      path: ["VITE_CLOUDBASE_ENV_ID"],
    });
  }
  if (environment.VITE_DATA_MODE === "cloudbase" && !environment.VITE_AUTH_SERVICE_URL) {
    context.addIssue({
      code: "custom",
      message: "CloudBase 模式需要 VITE_AUTH_SERVICE_URL",
      path: ["VITE_AUTH_SERVICE_URL"],
    });
  }
  if (environment.VITE_DATA_MODE === "cloudbase" && environment.VITE_AUTH_SERVICE_URL) {
    try {
      const url = new URL(environment.VITE_AUTH_SERVICE_URL);
      const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
      if (url.protocol !== "https:" && !localHttp) {
        context.addIssue({ code: "custom", message: "CloudBase auth-service 必须使用 HTTPS", path: ["VITE_AUTH_SERVICE_URL"] });
      }
    } catch {
      context.addIssue({ code: "custom", message: "auth-service 地址无效", path: ["VITE_AUTH_SERVICE_URL"] });
    }
  }
});

export const ServerEnvironmentSchema = z.object({
  VITE_CLOUDBASE_ENV_ID: NonEmptyEnvironmentValueSchema,
  FEISHU_APP_ID: NonEmptyEnvironmentValueSchema,
  FEISHU_APP_SECRET: NonEmptyEnvironmentValueSchema,
  FEISHU_REDIRECT_URI: NonEmptyEnvironmentValueSchema,
  PUBLIC_APP_URL: NonEmptyEnvironmentValueSchema,
  ADMIN_BOOTSTRAP_CODE: NonEmptyEnvironmentValueSchema,
  AUTH_SESSION_SECRET: NonEmptyEnvironmentValueSchema,
  CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS: NonEmptyEnvironmentValueSchema.superRefine((value, context) => {
    try {
      const credentials: unknown = JSON.parse(value);
      if (typeof credentials !== "object" || credentials === null || Array.isArray(credentials)) {
        context.addIssue({ code: "custom", message: "CloudBase 自定义登录凭证必须是 JSON 对象" });
      }
    } catch {
      context.addIssue({ code: "custom", message: "CloudBase 自定义登录凭证必须是 JSON 对象" });
    }
  }),
});

export type ClientEnvironment = z.infer<typeof ClientEnvironmentSchema>;
export type ServerEnvironment = z.infer<typeof ServerEnvironmentSchema>;
