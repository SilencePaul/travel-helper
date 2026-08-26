import AMapLoader from "@amap/amap-jsapi-loader";

export const missingAmapBrowserCredentials = "AMAP_BROWSER_CREDENTIALS_MISSING";

export async function loadAmap() {
  const key = import.meta.env.VITE_AMAP_JS_KEY;
  const securityJsCode = import.meta.env.VITE_AMAP_SECURITY_CODE;
  if (!key || !securityJsCode) throw new Error(missingAmapBrowserCredentials);

  window._AMapSecurityConfig = { securityJsCode };
  return AMapLoader.load({
    key,
    version: "2.0",
    plugins: ["AMap.Walking", "AMap.Transfer", "AMap.Driving", "AMap.Marker"],
  });
}
