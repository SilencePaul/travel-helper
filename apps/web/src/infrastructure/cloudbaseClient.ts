import cloudbase from "@cloudbase/js-sdk";

let client: ReturnType<typeof cloudbase.init> | undefined;

export function getCloudbaseClient() {
  if (!client) {
    const envId = import.meta.env.VITE_CLOUDBASE_ENV_ID;
    if (!envId) throw new Error("缺少 CloudBase 环境 ID");
    client = cloudbase.init({ env: envId });
  }
  return client;
}

export function getCloudbaseAuth() {
  return getCloudbaseClient().auth();
}
