const RESEARCH_CATEGORIES = new Set(["hotel", "restaurant", "attraction"]);
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const FNV_MASK = 0xffffffffffffffffn;

function assertJsonValue(value, seen) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON only accepts finite numbers");
    return;
  }
  if (typeof value !== "object") throw new TypeError("canonical JSON only accepts JSON values");
  if (seen.has(value)) throw new TypeError("canonical JSON does not accept circular values");
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new TypeError("canonical JSON does not accept sparse arrays");
      assertJsonValue(value[index], seen);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonical JSON only accepts plain objects");
    }
    for (const key of Object.keys(value)) assertJsonValue(value[key], seen);
  }
  seen.delete(value);
}

function serializeCanonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(serializeCanonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${serializeCanonical(value[key])}`).join(",")}}`;
}

export function canonicalJson(value) {
  assertJsonValue(value, new Set());
  return serializeCanonical(value);
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function dateEpoch(date) {
  const match = ISO_DATE.exec(date);
  if (!match) throw new TypeError("invalid ISO date");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const epoch = Date.UTC(year, month - 1, day);
  const parsed = new Date(epoch);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new TypeError("invalid ISO date");
  }
  return epoch;
}

function fnv1a64(value) {
  let hash = FNV_OFFSET;
  for (const byte of new globalThis.TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & FNV_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

function sortedTripDays(trip) {
  if (!trip || !Number.isInteger(trip.version) || trip.version < 0
    || !Number.isInteger(trip.travelerCount) || trip.travelerCount <= 0 || !Array.isArray(trip.days)) {
    throw new TypeError("invalid trip projection");
  }
  return trip.days.map((day) => {
    if (!day || typeof day.id !== "string" || day.id.length === 0 || typeof day.city !== "string"
      || day.city.trim().length === 0 || typeof day.date !== "string") {
      throw new TypeError("invalid trip day projection");
    }
    dateEpoch(day.date);
    return { id: day.id, date: day.date, city: day.city.trim() };
  }).sort((left, right) => compareText(left.date, right.date) || compareText(left.id, right.id));
}

function scopeId(trip, days, ordinal) {
  return `scope_${fnv1a64(canonicalJson({
    days: days.map((day) => ({ city: day.city, date: day.date, id: day.id })),
    ordinal,
    travelerCount: trip.travelerCount,
    tripVersion: trip.version,
  }))}`;
}

export function buildResearchTargetScopes(trip) {
  const days = sortedTripDays(trip);
  const groups = [];
  for (const day of days) {
    const current = groups.at(-1);
    const followsCurrent = current
      && current.city === day.city
      && dateEpoch(day.date) - dateEpoch(current.days.at(-1).date) === 86_400_000;
    if (followsCurrent) current.days.push(day);
    else groups.push({ city: day.city, days: [day] });
  }
  return groups.map((group, ordinal) => ({
    targetScopeId: scopeId(trip, group.days, ordinal),
    city: group.city,
    startDate: group.days[0].date,
    endDate: group.days.at(-1).date,
    travelerCount: trip.travelerCount,
  }));
}

async function sha256Hex(value, cryptoProvider) {
  const subtle = cryptoProvider?.subtle;
  if (!subtle || typeof subtle.digest !== "function") throw new Error("SHA-256 unavailable");
  const digest = await subtle.digest("SHA-256", new globalThis.TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function computeDisclosureFingerprint(disclosure, cryptoProvider = globalThis.crypto) {
  return sha256Hex(canonicalJson(disclosure), cryptoProvider);
}

async function resourceCommitment(resourceType, id, revision, cryptoProvider) {
  if (typeof id !== "string" || id.length === 0 || !Number.isInteger(revision) || revision < 0) {
    throw new TypeError("invalid resource identity");
  }
  return {
    resourceType,
    digest: await sha256Hex(canonicalJson({ id, resourceType, revision }), cryptoProvider),
  };
}

function cloneJson(value) {
  return JSON.parse(canonicalJson(value));
}

function optionalObject(source, keys) {
  const result = {};
  for (const key of keys) {
    if (source?.[key] !== undefined) result[key] = cloneJson(source[key]);
  }
  return result;
}

function sortByDigest(items) {
  return items.sort((left, right) => compareText(left.commitment.digest, right.commitment.digest));
}

export async function buildResearchDisclosure(context, options, cryptoProvider = globalThis.crypto) {
  if (!context?.trip || !context?.workspace || !options || !RESEARCH_CATEGORIES.has(options.category)) {
    throw new TypeError("invalid research disclosure input");
  }
  const scopes = buildResearchTargetScopes(context.trip);
  const segment = scopes.find((candidate) => candidate.targetScopeId === options.targetScopeId);
  if (!segment) throw new Error("INVALID_RESEARCH_TARGET");

  const sortedDays = sortedTripDays(context.trip);
  const selectedDays = sortedDays.filter((day) => day.city === segment.city
    && day.date >= segment.startDate && day.date <= segment.endDate);
  const completedPreferences = context.workspace.preferences.filter((preference) => preference.status === "completed");
  const relevantCandidates = context.workspace.candidates.filter((candidate) => candidate.category === options.category);
  const relevantCandidateIds = new Set(relevantCandidates.map((candidate) => candidate.id));
  const evidenceByCandidate = new Map();
  for (const evidence of context.workspace.evidence) {
    if (!relevantCandidateIds.has(evidence.candidateId)) continue;
    const existing = evidenceByCandidate.get(evidence.candidateId) ?? [];
    existing.push(evidence);
    evidenceByCandidate.set(evidence.candidateId, existing);
  }

  const preferencePairs = await Promise.all(completedPreferences.map(async (preference) => ({
    commitment: await resourceCommitment("preference", preference.id, preference.revision, cryptoProvider),
    display: {
      answers: cloneJson(preference.answers),
      ...(preference.freeText === undefined ? {} : { freeText: optionalObject(preference.freeText, ["mustHave", "mustAvoid", "note"]) }),
    },
  })));

  const candidatePairs = await Promise.all(relevantCandidates.map(async (candidate) => {
    const candidateCommitment = await resourceCommitment("candidate", candidate.id, candidate.revision, cryptoProvider);
    const evidencePairs = await Promise.all((evidenceByCandidate.get(candidate.id) ?? []).map(async (evidence) => ({
      commitment: await resourceCommitment("evidence", evidence.id, evidence.revision, cryptoProvider),
      display: {
        sourceKind: evidence.sourceKind,
        sourceName: evidence.sourceName,
        ...(evidence.sourceUrl === undefined ? {} : { sourceUrl: evidence.sourceUrl }),
        queryContext: cloneJson(evidence.queryContext),
        captureMethod: evidence.captureMethod,
        facts: cloneJson(evidence.facts),
      },
    })));
    return {
      commitment: candidateCommitment,
      evidenceCommitments: evidencePairs.map((entry) => entry.commitment),
      display: {
        category: candidate.category,
        entity: optionalObject(candidate.entity, ["name", "address"]),
        applicability: cloneJson(candidate.applicability),
        recommendation: { reason: candidate.recommendation.reason },
        evidence: sortByDigest(evidencePairs).map((entry) => entry.display),
      },
    };
  }));

  const candidateNameById = new Map(relevantCandidates.map((candidate) => [candidate.id, candidate.entity.name]));
  const feedbackPairs = await Promise.all(context.workspace.feedback
    .filter((feedback) => relevantCandidateIds.has(feedback.candidateId))
    .map(async (feedback) => ({
      commitment: await resourceCommitment("feedback", feedback.id, feedback.revision, cryptoProvider),
      display: {
        candidateName: candidateNameById.get(feedback.candidateId),
        kind: feedback.kind,
        ...(feedback.reason === undefined ? {} : { reason: feedback.reason }),
      },
    })));

  const summaryPair = context.workspace.summary === undefined ? undefined : {
    commitment: await resourceCommitment(
      "summary",
      context.workspace.summary.id,
      context.workspace.summary.revision,
      cryptoProvider,
    ),
    display: {
      common: [...context.workspace.summary.common].sort(compareText),
      disagreements: [...context.workspace.summary.disagreements].sort(compareText),
      tradeoffs: [...context.workspace.summary.tradeoffs].sort(compareText),
      status: context.workspace.summary.status,
    },
  };

  const dayCommitments = await Promise.all(selectedDays.map((day) => (
    resourceCommitment("trip_day", day.id, context.trip.version, cryptoProvider)
  )));
  const resourceCommitments = [
    ...dayCommitments,
    ...preferencePairs.map((entry) => entry.commitment),
    ...(summaryPair ? [summaryPair.commitment] : []),
    ...candidatePairs.flatMap((entry) => [entry.commitment, ...entry.evidenceCommitments]),
    ...feedbackPairs.map((entry) => entry.commitment),
  ].sort((left, right) => compareText(left.resourceType, right.resourceType) || compareText(left.digest, right.digest));

  return {
    category: options.category,
    segment: {
      city: segment.city,
      startDate: segment.startDate,
      endDate: segment.endDate,
      travelerCount: segment.travelerCount,
    },
    travelerNames: [...context.trip.travelerNames].sort(compareText),
    preferences: sortByDigest(preferencePairs).map((entry) => entry.display),
    summary: summaryPair?.display ?? null,
    feedback: sortByDigest(feedbackPairs).map((entry) => entry.display),
    existingCandidates: sortByDigest(candidatePairs).map((entry) => entry.display),
    resourceCommitments,
  };
}
