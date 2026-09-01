const CATEGORIES = new Set(["hotel", "restaurant", "attraction"]);
const SOURCE_KINDS = new Set(["flyai", "amap", "web", "official", "manual"]);
const CAPTURE_METHODS = new Set(["detail_page", "search_result", "api_result", "manual"]);
const SOURCE_ACTION_REASONS = new Set(["source_login_required", "source_captcha", "source_risk_control"]);
const CODEX_AUTH_MESSAGE = "请在 ChatGPT/Codex 中恢复登录后返回此页面继续。";
const SOURCE_ACTION_MESSAGE = "请在来源网站中完成所需操作后返回此页面继续。";
const MAX_OUTPUT_BYTES = 256 * 1_024;
const MAX_OBJECT_KEYS = 2_048;
const NON_PUBLIC_HOST_SUFFIXES = [
  "localhost", "local", "internal", "lan", "home", "home.arpa", "localdomain", "corp", "intranet",
  "private", "test", "invalid", "example", "onion",
];
const SENSITIVE_KEY_PATTERN = /(?:credential|password|passwd|token|authorization|cookie|privatekey|agentrun|signature|sequence|idempotency|pairingcode|codexthread|cloudbase|tencent)/u;
const SENSITIVE_VALUE_PATTERN = /(?:\bBearer\s+[A-Za-z0-9._~+\/-]{4,}|\b(?:authorization|cookie|password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token)\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp|xox[baprs])[-_][A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|\b(?:agent\s*run|idempotency|signature|sequence)\b)/iu;
const LOCAL_PATH_PATTERN = /(?:file:\/\/|\/(?:Users|home|etc|private|var|tmp)\/|[A-Za-z]:\\(?:Users|Documents|Windows)\\)/iu;
const HTML_PATTERN = /<(?:!doctype|\/?(?:html|body|script|iframe|form|input|a|div|span|img|style))\b[^>]*>/iu;

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
    && /\S/u.test(value);
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
  if (!normalized || normalized.length > 253 || !normalized.includes(".")
    || normalized.includes(":") || normalized.startsWith("[")
    || /^\d+(?:\.\d+){3}$/u.test(normalized)
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

function scanForUnsafeContent(value, privateValues = []) {
  let keyCount = 0;
  const seen = new Set();
  function visit(entry) {
    if (typeof entry === "string") {
      if (SENSITIVE_VALUE_PATTERN.test(entry) || LOCAL_PATH_PATTERN.test(entry) || HTML_PATTERN.test(entry)) {
        throw codedError("CODEX_OUTPUT_INVALID");
      }
      if (privateValues.some((privateValue) => (
        privateValue.length >= 4 ? entry.includes(privateValue) : entry === privateValue
      ))) throw codedError("CODEX_OUTPUT_INVALID");
      return;
    }
    if (entry === null || typeof entry === "boolean") return;
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) throw codedError("CODEX_OUTPUT_INVALID");
      return;
    }
    if (typeof entry !== "object" || seen.has(entry)) throw codedError("CODEX_OUTPUT_INVALID");
    seen.add(entry);
    if (Array.isArray(entry)) {
      if (entry.length > 128) throw codedError("CODEX_OUTPUT_INVALID");
      for (let index = 0; index < entry.length; index += 1) {
        if (!Object.hasOwn(entry, index)) throw codedError("CODEX_OUTPUT_INVALID");
        visit(entry[index]);
      }
    } else {
      if (!plainObject(entry)) throw codedError("CODEX_OUTPUT_INVALID");
      for (const [key, child] of Object.entries(entry)) {
        keyCount += 1;
        if (keyCount > MAX_OBJECT_KEYS) throw codedError("CODEX_OUTPUT_INVALID");
        const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
        if (SENSITIVE_KEY_PATTERN.test(normalizedKey)) throw codedError("CODEX_OUTPUT_INVALID");
        visit(child);
      }
    }
    seen.delete(entry);
  }
  visit(value);
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw codedError("CODEX_OUTPUT_INVALID");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_OUTPUT_BYTES) throw codedError("CODEX_OUTPUT_INVALID");
}

function validValidationOptions(options) {
  if (!exactObject(options, ["targetCategory", "segment", "aliasMap", "round", "now"])) return false;
  return CATEGORIES.has(options.targetCategory)
    && exactObject(options.segment, ["city", "startDate", "endDate", "travelerCount"])
    && safeString(options.segment.city, 200)
    && validDate(options.segment.startDate)
    && validDate(options.segment.endDate)
    && options.segment.startDate <= options.segment.endDate
    && Number.isSafeInteger(options.segment.travelerCount)
    && options.segment.travelerCount >= 1 && options.segment.travelerCount <= 100
    && options.aliasMap && options.aliasMap.preference instanceof Map && options.aliasMap.feedback instanceof Map
    && Number.isSafeInteger(options.round) && options.round >= 1
    && typeof options.now === "function";
}

function aliasIds(aliases, type, map) {
  const prefix = type === "preference" ? "pref_" : "feed_";
  const pattern = type === "preference"
    ? /^pref_[A-Za-z0-9_-]{32}$/u
    : /^feed_[A-Za-z0-9_-]{32}$/u;
  const result = [];
  for (const alias of aliases) {
    if (!alias.startsWith(prefix) || !pattern.test(alias)) throw codedError("CODEX_OUTPUT_INVALID");
    const resolved = map[type].get(alias);
    if (!resolved || !plainObject(resolved) || typeof resolved.id !== "string" || resolved.id.length === 0
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

function proposalCandidate(candidate, options, timestamp) {
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
      sourceUrl: evidence.sourceUrl,
      capturedAt: timestamp,
      queryContext: structuredClone(evidence.queryContext),
      captureMethod: evidence.captureMethod,
      facts: structuredClone(evidence.facts),
    })),
  };
}

export function validateTravelResearchOutput(output, options) {
  if (!validValidationOptions(options)) {
    const code = options && !CATEGORIES.has(options.targetCategory) ? "INVALID_RESEARCH_TARGET" : "CODEX_RESEARCH_FAILED";
    throw codedError(code);
  }
  const privateValues = [...options.aliasMap.preference.values(), ...options.aliasMap.feedback.values()]
    .flatMap((entry) => plainObject(entry) && typeof entry.id === "string" ? [entry.id] : []);
  scanForUnsafeContent(output, privateValues);

  if (validOwnerActionShape(output)) {
    return Object.freeze({ ...output });
  }
  if (!validCompletedShape(output) || output.category !== options.targetCategory) {
    throw codedError("CODEX_OUTPUT_INVALID");
  }
  for (const candidate of output.candidates) validateCandidateBusiness(candidate, options);
  const timestamp = capturedAt(options.now);
  const payload = {
    round: options.round,
    candidates: output.candidates.map((candidate) => proposalCandidate(candidate, options, timestamp)),
  };
  return Object.freeze({ status: "completed", payload });
}
