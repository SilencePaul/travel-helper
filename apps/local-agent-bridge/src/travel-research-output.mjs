import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

import {
  isResearchAliasMap,
  researchInspectionViews,
  researchTextContainsAliasPrivateValue,
  resolveResearchAlias,
} from "./travel-research-input.mjs";

const CATEGORIES = new Set(["hotel", "restaurant", "attraction"]);
const SOURCE_KINDS = new Set(["flyai", "amap", "web", "official", "manual"]);
const CAPTURE_METHODS = new Set(["detail_page", "search_result", "api_result", "manual"]);
const SOURCE_ACTION_REASONS = new Set(["source_login_required", "source_captcha", "source_risk_control"]);
const CODEX_AUTH_MESSAGE = "请在 ChatGPT/Codex 中恢复登录后返回此页面继续。";
const SOURCE_ACTION_MESSAGE = "请在来源网站中完成所需操作后返回此页面继续。";
const MAX_OUTPUT_BYTES = 256 * 1_024;
const MAX_OBJECT_KEYS = 2_048;
const MAX_OUTPUT_DEPTH = 32;
const MAX_OUTPUT_NODES = 10_000;
const MAX_ARRAY_LENGTH = 128;
const DNS_TIMEOUT_MS = 250;
const NON_PUBLIC_HOST_SUFFIXES = [
  "localhost", "local", "internal", "lan", "home", "home.arpa", "localdomain", "corp", "intranet",
  "private", "test", "invalid", "example", "onion",
];
const SENSITIVE_KEY_PATTERN = /(?:credential|password|passwd|token|authorization|cookie|privatekey|agentrun|signature|sequence|idempotency|pairingcode|codexthread|cloudbase|tencent|accesskey|secretid|secretkey)/u;
const SENSITIVE_VALUE_PATTERN = /(?:\bBearer\s+[A-Za-z0-9._~+\/-]{4,}|\b(?:authorization|cookie|password|passwd|api[._\s-]*key|access[._\s-]*token|refresh[._\s-]*token)\s*[:=]\s*[A-Za-z0-9._~+\/-]{4,}|\b(?:access[._\s-]*key(?:[._\s-]*id)?|secret[._\s-]*(?:id|key)|tencent[._\s-]*cloud[._\s-]*secret[._\s-]*(?:id|key))\s*[:=]\s*[A-Za-z0-9._~+\/-]{4,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:AKID|AKIA|ASIA)[A-Za-z0-9]{12,}|\b(?:sk|ghp|xox[baprs])[-_][A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|\b(?:agent\s*run|idempotency|signature|sequence)\b)/iu;
const LOCAL_PATH_PATTERN = /(?:file:\/\/|\/(?:Users|home|etc|private|var|tmp)\/|[A-Za-z]:\\(?:Users|Documents|Windows)\\)/iu;
const HTML_PATTERN = /<(?:!--[\s\S]*?--|!doctype(?:\s[^<>]*)?|!\[cdata\[[\s\S]*?\]\]|\?[\p{L}_:][^<>]*\?|\/?[\p{L}_:][\p{L}\p{N}:._-]*(?:(?:\s+|\/)[^<>]*)?)>/iu;
const DEFAULT_IGNORABLE_PATTERN = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const NESTED_URL_PATTERN = /[A-Za-z][A-Za-z0-9+.-]*:\/\//u;
const NON_HIERARCHICAL_URL_PATTERN = /(?:data|javascript|mailto):/iu;
const PROTOCOL_RELATIVE_URL_PATTERN = /(?<!:)\/\//u;
const STABLE_ERROR_CODES = new Set([
  "CODEX_OUTPUT_INVALID", "CODEX_INSUFFICIENT_EVIDENCE", "INVALID_RESEARCH_TARGET", "CODEX_RESEARCH_FAILED",
]);

const NON_GLOBAL_IPV4 = new BlockList();
const NON_GLOBAL_IPV6 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) NON_GLOBAL_IPV4.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 96], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
  ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
  ["5f00::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
]) NON_GLOBAL_IPV6.addSubnet(network, prefix, "ipv6");

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, required, allowed = required) {
  if (!plainObject(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.includes(key));
}

function safeString(value, maxLength) {
  return typeof value === "string"
    && value.length <= maxLength
    && value === value.trim()
    && /\S/u.test(value.replace(DEFAULT_IGNORABLE_PATTERN, ""));
}

function validDate(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validDateRange(value) {
  return exactObject(value, ["start", "end"])
    && validDate(value.start)
    && validDate(value.end)
    && value.start <= value.end;
}

function validOptionalText(value, maxLength) {
  return value === "not_provided" || safeString(value, maxLength);
}

function validHotelFacts(value) {
  return exactObject(value, [
    "propertyName", "address", "checkInDate", "checkOutDate", "travelers", "roomTypeOrBed",
    "availability", "priceAmount", "currency", "priceDisplay", "cancellationPolicy",
  ])
    && safeString(value.propertyName, 200)
    && safeString(value.address, 500)
    && validDate(value.checkInDate)
    && validDate(value.checkOutDate)
    && value.checkInDate <= value.checkOutDate
    && Number.isSafeInteger(value.travelers) && value.travelers >= 1 && value.travelers <= 100
    && safeString(value.roomTypeOrBed, 300)
    && ["available", "unavailable", "unknown"].includes(value.availability)
    && (value.priceAmount === "not_provided"
      || (typeof value.priceAmount === "number" && Number.isFinite(value.priceAmount)
        && value.priceAmount >= 0 && value.priceAmount <= 1_000_000_000))
    && validOptionalText(value.currency, 32)
    && ["total", "per_night", "per_person", "not_provided"].includes(value.priceDisplay)
    && validOptionalText(value.cancellationPolicy, 2_000);
}

function validRestaurantFacts(value, attraction = false) {
  const keys = ["name", "address", "openInformation", "priceSnapshot", ...(attraction ? ["ticketType"] : [])];
  return exactObject(value, keys)
    && safeString(value.name, 200)
    && safeString(value.address, 500)
    && validOptionalText(value.openInformation, 1_000)
    && validOptionalText(value.priceSnapshot, 1_000)
    && (!attraction || validOptionalText(value.ticketType, 300));
}

function validFacts(value, category) {
  if (category === "hotel") return validHotelFacts(value);
  if (category === "restaurant") return validRestaurantFacts(value);
  return category === "attraction" && validRestaurantFacts(value, true);
}

function validQueryContext(value) {
  if (!exactObject(value, [], ["dates", "travelers", "roomOrTicket"])) return false;
  if (Object.hasOwn(value, "dates") && !validDateRange(value.dates)) return false;
  if (Object.hasOwn(value, "travelers")
    && (!Number.isSafeInteger(value.travelers) || value.travelers < 1 || value.travelers > 100)) return false;
  return !Object.hasOwn(value, "roomOrTicket") || safeString(value.roomOrTicket, 300);
}

function normalizedPublicHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  const ipCandidate = normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
  if (!normalized || normalized.length > 253 || !normalized.includes(".")
    || isIP(ipCandidate) !== 0
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/u.test(normalized)) {
    return undefined;
  }
  if (NON_PUBLIC_HOST_SUFFIXES.some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`))) {
    return undefined;
  }
  return normalized;
}

function normalizedHttpsOrigin(value) {
  if (typeof value !== "string" || value.length > 2_048 || !value.startsWith("https://") || value.includes("#")) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return undefined;
    const hostname = normalizedPublicHostname(parsed.hostname);
    if (!hostname) return undefined;
    const port = parsed.port === "443" || parsed.port === "" ? "" : `:${parsed.port}`;
    return `https://${hostname}${port}`;
  } catch {
    return undefined;
  }
}

function unsafeUrlComponent(value, aliasMap) {
  if (/%(?![0-9A-Fa-f]{2})/u.test(value)) return true;
  const inspection = researchInspectionViews(value);
  if (inspection.malformed || inspection.truncated) return true;
  return inspection.views.some((view) => (
    researchTextContainsAliasPrivateValue(aliasMap, view)
    || SENSITIVE_VALUE_PATTERN.test(view)
    || LOCAL_PATH_PATTERN.test(view)
    || HTML_PATTERN.test(decodeBasicTagEntities(view))
    || NESTED_URL_PATTERN.test(view)
    || NON_HIERARCHICAL_URL_PATTERN.test(view)
    || PROTOCOL_RELATIVE_URL_PATTERN.test(view)
  ));
}

function canonicalHttpsUrl(value, aliasMap) {
  if (typeof value !== "string" || value.length > 2_048) throw codedError("CODEX_OUTPUT_INVALID");
  const normalizedValue = value.normalize("NFKC");
  let parsed;
  try {
    parsed = new URL(normalizedValue);
  } catch {
    throw codedError("CODEX_OUTPUT_INVALID");
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== ""
    || normalizedValue.includes("#")) {
    throw codedError("CODEX_OUTPUT_INVALID");
  }
  const hostname = normalizedPublicHostname(parsed.hostname);
  if (!hostname || unsafeUrlComponent(parsed.pathname, aliasMap)) throw codedError("CODEX_OUTPUT_INVALID");
  const rawSearch = parsed.search.startsWith("?") ? parsed.search.slice(1) : parsed.search;
  if (rawSearch.length > 0) {
    for (const pair of rawSearch.split("&")) {
      const separator = pair.indexOf("=");
      const key = separator < 0 ? pair : pair.slice(0, separator);
      const entry = separator < 0 ? "" : pair.slice(separator + 1);
      if (unsafeUrlComponent(key, aliasMap)
        || unsafeUrlComponent(entry, aliasMap)
        || unsafeUrlComponent(`${key}=${entry}`, aliasMap)
        || unsafeUrlComponent(key.replace(/\+/gu, " "), aliasMap)
        || unsafeUrlComponent(entry.replace(/\+/gu, " "), aliasMap)
        || unsafeUrlComponent(`${key}=${entry}`.replace(/\+/gu, " "), aliasMap)) {
        throw codedError("CODEX_OUTPUT_INVALID");
      }
    }
  }
  const port = parsed.port === "443" || parsed.port === "" ? "" : `:${parsed.port}`;
  const origin = `https://${hostname}${port}`;
  return Object.freeze({ hostname, origin, sourceUrl: `${origin}${parsed.pathname || "/"}` });
}

function validEvidence(value, category) {
  return exactObject(value, ["sourceKind", "sourceName", "sourceUrl", "queryContext", "captureMethod", "facts"])
    && SOURCE_KINDS.has(value.sourceKind)
    && safeString(value.sourceName, 300)
    && normalizedHttpsOrigin(value.sourceUrl) !== undefined
    && validQueryContext(value.queryContext)
    && CAPTURE_METHODS.has(value.captureMethod)
    && validFacts(value.facts, category);
}

function validAliases(value) {
  return Array.isArray(value)
    && value.length <= 64
    && new Set(value).size === value.length
    && value.every((alias) => safeString(alias, 128));
}

function validCandidate(value, category) {
  return exactObject(value, ["category", "entity", "applicability", "recommendation", "evidence"])
    && value.category === category
    && exactObject(value.entity, ["name", "address"])
    && safeString(value.entity.name, 200)
    && safeString(value.entity.address, 500)
    && exactObject(value.applicability, ["dates", "travelers"])
    && validDateRange(value.applicability.dates)
    && Number.isSafeInteger(value.applicability.travelers)
    && value.applicability.travelers >= 1 && value.applicability.travelers <= 100
    && exactObject(value.recommendation, ["reason", "preferenceRevisionAliases", "feedbackAliases"])
    && safeString(value.recommendation.reason, 2_000)
    && validAliases(value.recommendation.preferenceRevisionAliases)
    && validAliases(value.recommendation.feedbackAliases)
    && Array.isArray(value.evidence)
    && value.evidence.length >= 2 && value.evidence.length <= 8
    && value.evidence.every((evidence) => validEvidence(evidence, category));
}

function validCompletedShape(value) {
  return exactObject(value, ["status", "category", "candidates"])
    && value.status === "completed"
    && CATEGORIES.has(value.category)
    && Array.isArray(value.candidates)
    && value.candidates.length >= 2 && value.candidates.length <= 4
    && value.candidates.every((candidate) => validCandidate(candidate, value.category));
}

function validOwnerActionShape(value) {
  if (exactObject(value, ["status", "reason", "message"])) {
    return value.status === "needs_owner_action"
      && value.reason === "codex_auth_required"
      && value.message === CODEX_AUTH_MESSAGE;
  }
  return exactObject(value, ["status", "reason", "message", "sourceHostname"])
    && value.status === "needs_owner_action"
    && SOURCE_ACTION_REASONS.has(value.reason)
    && value.message === SOURCE_ACTION_MESSAGE
    && typeof value.sourceHostname === "string"
    && normalizedPublicHostname(value.sourceHostname) === value.sourceHostname;
}

function validDiscoveryShape(value) {
  return exactObject(value, ["status", "category", "candidates"])
    && value.status === "discovered"
    && CATEGORIES.has(value.category)
    && Array.isArray(value.candidates)
    && value.candidates.length >= 2 && value.candidates.length <= 4
    && value.candidates.every((candidate) => exactObject(candidate, ["name", "address"])
      && safeString(candidate.name, 200) && safeString(candidate.address, 200));
}

function decodeBasicTagEntities(value) {
  let decoded = value;
  for (let pass = 0; pass < 2; pass += 1) {
    decoded = decoded
      .replace(/&amp;/giu, "&")
      .replace(/&(?:lt;|#0*60;?|#x0*3c;?)/giu, "<")
      .replace(/&(?:gt;|#0*62;?|#x0*3e;?)/giu, ">");
  }
  return decoded;
}

function unsafeGeneralString(value, aliasMap) {
  const inspection = researchInspectionViews(value);
  if (inspection.malformed || inspection.truncated) return true;
  return inspection.views.some((view) => (
    SENSITIVE_VALUE_PATTERN.test(view)
    || LOCAL_PATH_PATTERN.test(view)
    || HTML_PATTERN.test(decodeBasicTagEntities(view))
    || (aliasMap !== undefined && researchTextContainsAliasPrivateValue(aliasMap, view))
  ));
}

function unsafeGeneralKey(value, aliasMap) {
  const inspection = researchInspectionViews(value);
  if (inspection.malformed || inspection.truncated) return true;
  return inspection.views.some((view) => {
    const normalizedKey = view.toLowerCase().replace(/[^a-z0-9]/gu, "");
    return SENSITIVE_KEY_PATTERN.test(normalizedKey)
      || unsafeGeneralString(view, aliasMap);
  });
}

function scanForUnsafeContent(value, aliasMap) {
  let keyCount = 0;
  let nodeCount = 0;
  let approximateBytes = 0;
  const seen = new WeakSet();
  const stack = [{ depth: 0, entry: value }];
  while (stack.length > 0) {
    const { depth, entry } = stack.pop();
    nodeCount += 1;
    if (nodeCount > MAX_OUTPUT_NODES || depth > MAX_OUTPUT_DEPTH) throw codedError("CODEX_OUTPUT_INVALID");
    if (typeof entry === "string") {
      approximateBytes += Buffer.byteLength(entry, "utf8");
      if (approximateBytes > MAX_OUTPUT_BYTES || unsafeGeneralString(entry, aliasMap)) {
        throw codedError("CODEX_OUTPUT_INVALID");
      }
      continue;
    }
    if (entry === null || typeof entry === "boolean") continue;
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) throw codedError("CODEX_OUTPUT_INVALID");
      approximateBytes += 16;
      continue;
    }
    if (typeof entry !== "object" || seen.has(entry)) throw codedError("CODEX_OUTPUT_INVALID");
    seen.add(entry);
    if (Array.isArray(entry)) {
      if (entry.length > MAX_ARRAY_LENGTH) throw codedError("CODEX_OUTPUT_INVALID");
      for (let index = 0; index < entry.length; index += 1) {
        if (!Object.hasOwn(entry, index)) throw codedError("CODEX_OUTPUT_INVALID");
        stack.push({ depth: depth + 1, entry: entry[index] });
      }
    } else {
      if (!plainObject(entry)) throw codedError("CODEX_OUTPUT_INVALID");
      for (const [key, child] of Object.entries(entry)) {
        keyCount += 1;
        if (keyCount > MAX_OBJECT_KEYS) throw codedError("CODEX_OUTPUT_INVALID");
        approximateBytes += Buffer.byteLength(key, "utf8");
        if (approximateBytes > MAX_OUTPUT_BYTES || unsafeGeneralKey(key, aliasMap)) {
          throw codedError("CODEX_OUTPUT_INVALID");
        }
        stack.push({ depth: depth + 1, entry: child });
      }
    }
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw codedError("CODEX_OUTPUT_INVALID");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_OUTPUT_BYTES) throw codedError("CODEX_OUTPUT_INVALID");
}

function validValidationOptions(options) {
  if (!exactObject(
    options,
    ["targetCategory", "segment", "aliasMap", "round", "now"],
    ["targetCategory", "segment", "aliasMap", "round", "now", "resolveHostname"],
  )) return false;
  return CATEGORIES.has(options.targetCategory)
    && exactObject(options.segment, ["city", "startDate", "endDate", "travelerCount"])
    && safeString(options.segment.city, 200)
    && validDate(options.segment.startDate)
    && validDate(options.segment.endDate)
    && options.segment.startDate <= options.segment.endDate
    && Number.isSafeInteger(options.segment.travelerCount)
    && options.segment.travelerCount >= 1 && options.segment.travelerCount <= 100
    && isResearchAliasMap(options.aliasMap)
    && Number.isSafeInteger(options.round) && options.round >= 1
    && typeof options.now === "function"
    && (options.resolveHostname === undefined || typeof options.resolveHostname === "function");
}

function aliasIds(aliases, type, map) {
  const prefix = type === "preference" ? "pref_" : "feed_";
  const pattern = type === "preference"
    ? /^pref_[A-Za-z0-9_-]{32}$/u
    : /^feed_[A-Za-z0-9_-]{32}$/u;
  const result = [];
  for (const alias of aliases) {
    if (!alias.startsWith(prefix) || !pattern.test(alias)) throw codedError("CODEX_OUTPUT_INVALID");
    const resolved = resolveResearchAlias(map, type, alias);
    if (!resolved || typeof resolved.id !== "string" || resolved.id.length === 0
      || !Number.isSafeInteger(resolved.revision) || resolved.revision < 0) {
      throw codedError("CODEX_OUTPUT_INVALID");
    }
    result.push(resolved.id);
  }
  return result;
}

function matchesRange(value, segment) {
  return value.start === segment.startDate && value.end === segment.endDate;
}

async function defaultResolveHostname(hostname) {
  return lookup(hostname, { all: true, verbatim: true });
}

function globalPublicAddress(value) {
  const family = isIP(value);
  if (family === 4) return !NON_GLOBAL_IPV4.check(value, "ipv4");
  if (family === 6) return !NON_GLOBAL_IPV6.check(value, "ipv6");
  return false;
}

async function resolvePublicHostname(hostname, resolver) {
  let timeout;
  try {
    const answers = await Promise.race([
      Promise.resolve().then(() => resolver(hostname)),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(codedError("CODEX_OUTPUT_INVALID")), DNS_TIMEOUT_MS);
      }),
    ]);
    if (!Array.isArray(answers) || answers.length === 0) throw codedError("CODEX_OUTPUT_INVALID");
    for (const answer of answers) {
      const address = typeof answer === "string"
        ? answer
        : plainObject(answer) && Object.hasOwn(answer, "address") ? answer.address : undefined;
      if (typeof address !== "string" || !globalPublicAddress(address)) {
        throw codedError("CODEX_OUTPUT_INVALID");
      }
    }
  } catch (error) {
    if (error?.code === "CODEX_OUTPUT_INVALID") throw error;
    throw codedError("CODEX_OUTPUT_INVALID");
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function canonicalEvidenceUrls(output, options) {
  const result = new WeakMap();
  const hostnames = new Set();
  for (const candidate of output.candidates) {
    const origins = new Set();
    for (const evidence of candidate.evidence) {
      const canonical = canonicalHttpsUrl(evidence.sourceUrl, options.aliasMap);
      result.set(evidence, canonical);
      hostnames.add(canonical.hostname);
      origins.add(canonical.origin);
    }
    if (origins.size < 2) throw codedError("CODEX_INSUFFICIENT_EVIDENCE");
  }
  const resolver = options.resolveHostname ?? defaultResolveHostname;
  await Promise.all([...hostnames].map((hostname) => resolvePublicHostname(hostname, resolver)));
  return result;
}

function validateCandidateBusiness(candidate, options) {
  if (candidate.category !== options.targetCategory
    || !matchesRange(candidate.applicability.dates, options.segment)
    || candidate.applicability.travelers !== options.segment.travelerCount) {
    throw codedError("CODEX_OUTPUT_INVALID");
  }
  const origins = new Set();
  for (const evidence of candidate.evidence) {
    if (!Object.hasOwn(evidence.queryContext, "dates")
      || !Object.hasOwn(evidence.queryContext, "travelers")
      || !matchesRange(evidence.queryContext.dates, options.segment)
      || evidence.queryContext.travelers !== options.segment.travelerCount) {
      throw codedError("CODEX_OUTPUT_INVALID");
    }
    if (candidate.category === "hotel") {
      if (evidence.facts.checkInDate !== options.segment.startDate
        || evidence.facts.checkOutDate !== options.segment.endDate
        || evidence.facts.travelers !== options.segment.travelerCount
        || evidence.facts.propertyName !== candidate.entity.name
        || evidence.facts.address !== candidate.entity.address) {
        throw codedError("CODEX_OUTPUT_INVALID");
      }
    } else if (evidence.facts.name !== candidate.entity.name || evidence.facts.address !== candidate.entity.address) {
      throw codedError("CODEX_OUTPUT_INVALID");
    }
    origins.add(normalizedHttpsOrigin(evidence.sourceUrl));
  }
  if (origins.size < 2) throw codedError("CODEX_INSUFFICIENT_EVIDENCE");
}

function capturedAt(now) {
  let value;
  try {
    value = now();
  } catch {
    throw codedError("CODEX_RESEARCH_FAILED");
  }
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw codedError("CODEX_RESEARCH_FAILED");
  const result = value.toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(result)) {
    throw codedError("CODEX_RESEARCH_FAILED");
  }
  return result;
}

function proposalCandidate(candidate, options, timestamp, canonicalUrls) {
  return {
    category: candidate.category,
    entity: { name: candidate.entity.name, address: candidate.entity.address },
    applicability: {
      dates: { start: candidate.applicability.dates.start, end: candidate.applicability.dates.end },
      travelers: candidate.applicability.travelers,
    },
    recommendation: {
      round: options.round,
      reason: candidate.recommendation.reason,
      preferenceRevisionIds: aliasIds(candidate.recommendation.preferenceRevisionAliases, "preference", options.aliasMap),
      feedbackIds: aliasIds(candidate.recommendation.feedbackAliases, "feedback", options.aliasMap),
    },
    evidence: candidate.evidence.map((evidence) => ({
      sourceKind: evidence.sourceKind,
      sourceName: evidence.sourceName,
      sourceUrl: canonicalUrls.get(evidence)?.sourceUrl,
      capturedAt: timestamp,
      queryContext: structuredClone(evidence.queryContext),
      captureMethod: evidence.captureMethod,
      facts: structuredClone(evidence.facts),
    })),
  };
}

async function validateOutput(output, options) {
  if (!validValidationOptions(options)) {
    const code = options && !CATEGORIES.has(options.targetCategory) ? "INVALID_RESEARCH_TARGET" : "CODEX_RESEARCH_FAILED";
    throw codedError(code);
  }
  scanForUnsafeContent(output, options.aliasMap);

  if (validOwnerActionShape(output)) {
    if (Object.hasOwn(output, "sourceHostname")) {
      await resolvePublicHostname(output.sourceHostname, options.resolveHostname ?? defaultResolveHostname);
    }
    return Object.freeze({ ...output });
  }
  if (!validCompletedShape(output) || output.category !== options.targetCategory) {
    throw codedError("CODEX_OUTPUT_INVALID");
  }
  for (const candidate of output.candidates) validateCandidateBusiness(candidate, options);
  const canonicalUrls = await canonicalEvidenceUrls(output, options);
  const timestamp = capturedAt(options.now);
  const payload = {
    round: options.round,
    candidates: output.candidates.map((candidate) => proposalCandidate(
      candidate,
      options,
      timestamp,
      canonicalUrls,
    )),
  };
  scanForUnsafeContent(payload, undefined);
  return Object.freeze({ status: "completed", payload });
}

export async function validateTravelResearchOutput(output, options) {
  try {
    return await validateOutput(output, options);
  } catch (error) {
    if (error instanceof Error && STABLE_ERROR_CODES.has(error.code) && error.message === error.code) throw error;
    throw codedError("CODEX_OUTPUT_INVALID");
  }
}

export async function validateTravelResearchDiscoveryOutput(output, options) {
  try {
    if (!exactObject(options, ["targetCategory", "aliasMap"], ["targetCategory", "aliasMap", "resolveHostname"])
      || options.resolveHostname !== undefined && typeof options.resolveHostname !== "function" || !CATEGORIES.has(options.targetCategory)
      || !isResearchAliasMap(options.aliasMap)) {
      throw codedError(options && !CATEGORIES.has(options.targetCategory) ? "INVALID_RESEARCH_TARGET" : "CODEX_RESEARCH_FAILED");
    }
    scanForUnsafeContent(output, options.aliasMap);
    if (validOwnerActionShape(output)) {
      if (Object.hasOwn(output, "sourceHostname")) {
        await resolvePublicHostname(output.sourceHostname, options.resolveHostname ?? defaultResolveHostname);
      }
      return Object.freeze({ ...output });
    }
    if (!validDiscoveryShape(output) || output.category !== options.targetCategory) throw codedError("CODEX_OUTPUT_INVALID");
    const names = new Set();
    for (const candidate of output.candidates) {
      const key = `${candidate.name}\u0000${candidate.address}`;
      if (names.has(key)) throw codedError("CODEX_OUTPUT_INVALID");
      names.add(key);
    }
    return Object.freeze({
      status: "discovered",
      category: output.category,
      candidates: output.candidates.map(({ name, address }) => Object.freeze({ name, address })),
    });
  } catch (error) {
    if (error instanceof Error && STABLE_ERROR_CODES.has(error.code) && error.message === error.code) throw error;
    throw codedError("CODEX_OUTPUT_INVALID");
  }
}
