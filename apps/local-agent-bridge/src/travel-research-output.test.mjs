import assert from "node:assert/strict";
import test from "node:test";

import { validateTravelResearchOutput } from "./travel-research-output.mjs";

const preferenceAlias = `pref_${"p".repeat(32)}`;
const feedbackAlias = `feed_${"f".repeat(32)}`;

function aliasMap() {
  return Object.freeze({
    preference: new Map([
      [preferenceAlias, Object.freeze({ id: "preference-raw-1", revision: 4 })],
    ]),
    feedback: new Map([
      [feedbackAlias, Object.freeze({ id: "feedback-raw-1", revision: 3 })],
    ]),
  });
}

const segment = Object.freeze({ city: "深圳", startDate: "2026-10-03", endDate: "2026-10-03", travelerCount: 2 });

function hotelEvidence(sourceUrl, sourceName = "来源") {
  return {
    sourceKind: "official",
    sourceName,
    sourceUrl,
    queryContext: {
      dates: { start: "2026-10-03", end: "2026-10-03" },
      travelers: 2,
      roomOrTicket: "大床房",
    },
    captureMethod: "detail_page",
    facts: {
      propertyName: "深圳湾酒店",
      address: "深圳市南山区",
      checkInDate: "2026-10-03",
      checkOutDate: "2026-10-03",
      travelers: 2,
      roomTypeOrBed: "大床房",
      availability: "available",
      priceAmount: 1288,
      currency: "CNY",
      priceDisplay: "total",
      cancellationPolicy: "入住前一天可免费取消",
    },
  };
}

function hotelCandidate(index = 0) {
  return {
    category: "hotel",
    entity: { name: "深圳湾酒店", address: "深圳市南山区" },
    applicability: { dates: { start: "2026-10-03", end: "2026-10-03" }, travelers: 2 },
    recommendation: {
      reason: index === 0 ? "靠近行程段" : "交通便利",
      preferenceRevisionAliases: [preferenceAlias],
      feedbackAliases: [feedbackAlias],
    },
    evidence: [
      hotelEvidence(`https://hotel${index + 1}.com/rooms?date=2026-10-03`, "酒店官网"),
      hotelEvidence(`https://booking${index + 1}.com/hotel/detail`, "预订平台"),
    ],
  };
}

function completedOutput() {
  return { status: "completed", category: "hotel", candidates: [hotelCandidate(0), hotelCandidate(1)] };
}

function options(overrides = {}) {
  return {
    targetCategory: "hotel",
    segment,
    aliasMap: aliasMap(),
    round: 4,
    now: () => new Date("2026-09-01T02:03:04.567Z"),
    ...overrides,
  };
}

function errorCode(block) {
  assert.throws(block, (error) => error instanceof Error && error.message === error.code && [
    "CODEX_OUTPUT_INVALID",
    "CODEX_INSUFFICIENT_EVIDENCE",
    "INVALID_RESEARCH_TARGET",
    "CODEX_RESEARCH_FAILED",
  ].includes(error.code));
}

test("valid completed output maps current aliases and adds only trusted round/capturedAt fields", () => {
  const result = validateTravelResearchOutput(completedOutput(), options());

  assert.equal(result.status, "completed");
  assert.equal(result.payload.round, 4);
  assert.equal(result.payload.candidates.length, 2);
  assert.deepEqual(result.payload.candidates[0].recommendation, {
    round: 4,
    reason: "靠近行程段",
    preferenceRevisionIds: ["preference-raw-1"],
    feedbackIds: ["feedback-raw-1"],
  });
  assert.equal(result.payload.candidates[0].evidence[0].capturedAt, "2026-09-01T02:03:04.567Z");
  assert.deepEqual(Object.keys(result.payload).sort(), ["candidates", "round"]);
  assert.equal(JSON.stringify(result.payload).includes("preferenceRevisionAliases"), false);
  assert.equal(JSON.stringify(result.payload).includes("status"), false);
});

test("accepts category-matched restaurant and attraction facts", () => {
  for (const [category, facts] of [
    ["restaurant", { name: "餐厅", address: "深圳市", openInformation: "10:00-22:00", priceSnapshot: "CNY 200/人" }],
    ["attraction", { name: "景点", address: "深圳市", openInformation: "09:00-18:00", priceSnapshot: "CNY 100", ticketType: "成人票" }],
  ]) {
    const candidate = {
      category,
      entity: { name: facts.name, address: facts.address },
      applicability: { dates: { start: "2026-10-03", end: "2026-10-03" }, travelers: 2 },
      recommendation: { reason: "符合需求", preferenceRevisionAliases: [], feedbackAliases: [] },
      evidence: [
        { sourceKind: "official", sourceName: "官网", sourceUrl: `https://${category}1.com/a`, queryContext: { dates: { start: "2026-10-03", end: "2026-10-03" }, travelers: 2 }, captureMethod: "detail_page", facts },
        { sourceKind: "web", sourceName: "平台", sourceUrl: `https://${category}2.com/b`, queryContext: { dates: { start: "2026-10-03", end: "2026-10-03" }, travelers: 2 }, captureMethod: "search_result", facts },
      ],
    };
    const result = validateTravelResearchOutput({ status: "completed", category, candidates: [candidate, structuredClone(candidate)] }, options({ targetCategory: category }));
    assert.equal(result.payload.candidates.every((item) => item.category === category), true);
  }
});

test("rejects fixed-shape and category violations with no partial payload", () => {
  const cases = [
    { name: "one candidate", mutate: (value) => value.candidates.pop() },
    { name: "five candidates", mutate: (value) => value.candidates.push(hotelCandidate(2), hotelCandidate(3), hotelCandidate(4)) },
    { name: "mixed top category", mutate: (value) => { value.category = "restaurant"; } },
    { name: "mixed candidate category", mutate: (value) => { value.candidates[0].category = "restaurant"; } },
    { name: "wrong facts", mutate: (value) => { value.candidates[0].evidence[0].facts = { name: "x", address: "x", openInformation: "x", priceSnapshot: "x" }; } },
    { name: "extra top key", mutate: (value) => { value.agentRunId = "run-secret"; } },
    { name: "extra nested key", mutate: (value) => { value.candidates[0].signature = "signature-secret"; } },
    { name: "too few evidence", mutate: (value) => value.candidates[0].evidence.pop() },
    { name: "too many evidence", mutate: (value) => { while (value.candidates[0].evidence.length < 9) value.candidates[0].evidence.push(hotelEvidence(`https://extra${value.candidates[0].evidence.length}.com/x`)); } },
    { name: "oversized text", mutate: (value) => { value.candidates[0].recommendation.reason = "x".repeat(2_001); } },
    { name: "duplicate alias", mutate: (value) => { value.candidates[0].recommendation.preferenceRevisionAliases.push(preferenceAlias); } },
  ];

  for (const { name, mutate } of cases) {
    const output = completedOutput();
    mutate(output);
    assert.throws(() => validateTravelResearchOutput(output, options()), { message: "CODEX_OUTPUT_INVALID" }, name);
  }
});

test("requires every applicability, query, and category fact to match the selected segment", () => {
  const cases = [
    (value) => { value.candidates[0].applicability.dates.end = "2026-10-04"; },
    (value) => { value.candidates[0].applicability.travelers = 3; },
    (value) => { value.candidates[0].evidence[0].queryContext.dates.start = "2026-10-02"; },
    (value) => { value.candidates[0].evidence[0].queryContext.travelers = 1; },
    (value) => { delete value.candidates[0].evidence[0].queryContext.dates; },
    (value) => { delete value.candidates[0].evidence[0].queryContext.travelers; },
    (value) => { value.candidates[0].evidence[0].facts.checkOutDate = "2026-10-04"; },
    (value) => { value.candidates[0].evidence[0].facts.travelers = 1; },
    (value) => { value.candidates[0].evidence[0].facts.propertyName = "另一家酒店"; },
    (value) => { value.candidates[0].evidence[0].facts.address = "另一个地址"; },
  ];
  for (const mutate of cases) {
    const output = completedOutput();
    mutate(output);
    assert.throws(() => validateTravelResearchOutput(output, options()), { message: "CODEX_OUTPUT_INVALID" });
  }
});

test("normalizes origins and rejects duplicate, credential-bearing, fragmented, IP, private, and special hosts", () => {
  const duplicate = completedOutput();
  duplicate.candidates[0].evidence[0].sourceUrl = "https://HOTEL1.com:443/a?x=1";
  duplicate.candidates[0].evidence[1].sourceUrl = "https://hotel1.com/b?x=2";
  assert.throws(() => validateTravelResearchOutput(duplicate, options()), { message: "CODEX_INSUFFICIENT_EVIDENCE" });

  for (const sourceUrl of [
    "http://hotel.com/a",
    "https://alice:password@hotel.com/a",
    "https://hotel.com/a#",
    "https://hotel.com/a#fragment",
    "https://127.0.0.1/a",
    "https://8.8.8.8/a",
    "https://[::1]/a",
    "https://[2606:4700:4700::1111]/a",
    "https://localhost/a",
    "https://hotel.local/a",
    "https://intranet/a",
    "https://singlelabel/a",
  ]) {
    const output = completedOutput();
    output.candidates[0].evidence[0].sourceUrl = sourceUrl;
    assert.throws(() => validateTravelResearchOutput(output, options()), { message: "CODEX_OUTPUT_INVALID" }, sourceUrl);
  }

  const distinctPort = completedOutput();
  distinctPort.candidates[0].evidence[1].sourceUrl = "https://hotel1.com:8443/b";
  assert.doesNotThrow(() => validateTravelResearchOutput(distinctPort, options()));
});

test("rejects unknown, old-revision, and wrong-type aliases", () => {
  for (const [field, alias] of [
    ["preferenceRevisionAliases", "pref_unknown0000000000000000000000"],
    ["preferenceRevisionAliases", "pref_oldRevision000000000000000000"],
    ["preferenceRevisionAliases", feedbackAlias],
    ["feedbackAliases", preferenceAlias],
  ]) {
    const output = completedOutput();
    output.candidates[0].recommendation[field] = [alias];
    assert.throws(() => validateTravelResearchOutput(output, options()), { message: "CODEX_OUTPUT_INVALID" });
  }
});

test("recursively rejects secret keys, token values, HTML, local paths, and oversized output", () => {
  const mutations = [
    (value) => { value.candidates[0].evidence[0].facts.authorization = "Bearer abc"; },
    (value) => { value.candidates[0].evidence[0].sourceName = "Bearer abcdefghijklmnop"; },
    (value) => { value.candidates[0].recommendation.reason = "<script>alert(1)</script>"; },
    (value) => { value.candidates[0].entity.address = "/Users/example/.codex/auth.json"; },
    (value) => { value.candidates[0].entity.address = "-----BEGIN PRIVATE KEY-----"; },
    (value) => { value.candidates[0].sequence = 12; },
    (value) => { value.candidates[0].idempotencyKey = "idem-secret"; },
    (value) => { value.candidates[0].recommendation.reason = "leaked preference-raw-1"; },
  ];
  for (const mutate of mutations) {
    const output = completedOutput();
    mutate(output);
    assert.throws(() => validateTravelResearchOutput(output, options()), { message: "CODEX_OUTPUT_INVALID" });
  }

  const huge = completedOutput();
  huge.padding = "x".repeat(300_000);
  assert.throws(() => validateTravelResearchOutput(huge, options()), { message: "CODEX_OUTPUT_INVALID" });
});

test("returns only exact safe needs_owner_action branches", () => {
  assert.deepEqual(validateTravelResearchOutput({
    status: "needs_owner_action",
    reason: "codex_auth_required",
    message: "请在 ChatGPT/Codex 中恢复登录后返回此页面继续。",
  }, options()), {
    status: "needs_owner_action",
    reason: "codex_auth_required",
    message: "请在 ChatGPT/Codex 中恢复登录后返回此页面继续。",
  });
  assert.deepEqual(validateTravelResearchOutput({
    status: "needs_owner_action",
    reason: "source_captcha",
    message: "请在来源网站中完成所需操作后返回此页面继续。",
    sourceHostname: "booking.com",
  }, options()), {
    status: "needs_owner_action",
    reason: "source_captcha",
    message: "请在来源网站中完成所需操作后返回此页面继续。",
    sourceHostname: "booking.com",
  });

  for (const output of [
    { status: "needs_owner_action", reason: "codex_auth_required", message: "wrong", sourceHostname: "booking.com" },
    { status: "needs_owner_action", reason: "source_login_required", message: "请在来源网站中完成所需操作后返回此页面继续。", sourceHostname: "localhost" },
    { status: "needs_owner_action", reason: "source_risk_control", message: "请在来源网站中完成所需操作后返回此页面继续。", sourceHostname: "8.8.8.8" },
    { status: "needs_owner_action", reason: "source_captcha", message: "请在来源网站中完成所需操作后返回此页面继续。", sourceHostname: "singlelabel" },
  ]) {
    assert.throws(() => validateTravelResearchOutput(output, options()), { message: "CODEX_OUTPUT_INVALID" });
  }
});

test("uses a valid trusted UTC clock and exposes only stable sanitized errors", () => {
  errorCode(() => validateTravelResearchOutput(completedOutput(), options({ round: 0 })));
  errorCode(() => validateTravelResearchOutput(completedOutput(), options({ now: () => new Date(Number.NaN) })));
  errorCode(() => validateTravelResearchOutput({ privatePath: "/Users/alice/secret" }, options()));
});
