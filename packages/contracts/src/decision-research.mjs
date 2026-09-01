const RESEARCH_CATEGORIES = new Set(["hotel", "restaurant", "attraction"]);
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SHA256_INITIAL_STATE = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];
const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

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

function rotateRight(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

function sha256HexSync(value) {
  const input = new globalThis.TextEncoder().encode(value);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const message = new Uint8Array(paddedLength);
  message.set(input);
  message[input.length] = 0x80;
  const view = new DataView(message.buffer);
  const bitLength = input.length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const state = [...SHA256_INITIAL_STATE];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const word15 = words[index - 15];
      const word2 = words[index - 2];
      const sigma0 = rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ (word15 >>> 3);
      const sigma1 = rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ (word2 >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choice + SHA256_ROUND_CONSTANTS[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }
  return state.map((word) => word.toString(16).padStart(8, "0")).join("");
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
  return `scope_${sha256HexSync(canonicalJson({
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
