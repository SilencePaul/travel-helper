function decodeCloudBaseCredentials(value) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("INVALID_CLOUDBASE_CREDENTIALS");
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error("INVALID_CLOUDBASE_CREDENTIALS");
  let credentials;
  try { credentials = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded)); } catch { throw new Error("INVALID_CLOUDBASE_CREDENTIALS"); }
  if (typeof credentials !== "object" || credentials === null || Array.isArray(credentials)) throw new Error("INVALID_CLOUDBASE_CREDENTIALS");
  return credentials;
}

module.exports = { decodeCloudBaseCredentials };
