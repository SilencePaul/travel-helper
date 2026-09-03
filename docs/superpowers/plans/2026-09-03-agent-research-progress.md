# Agent research progress and early candidates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Show a four-step, safe, local research progress experience; surface discovery-only candidate previews within a three-minute first-result window; submit only fully verified candidates to the shared decision service.

**Architecture:** Change the local Codex work from one all-or-nothing output into two bounded passes in one isolated Codex thread. The discovery pass returns a small, strict preview payload and immediately becomes the bridge's persisted local status. The verification pass resumes the same thread under the existing full evidence schema, then follows the existing validate → signed server submission path. `ResearchStatus` remains the only browser-visible protocol, extended with a strict safe progress projection; no prompt, Codex event stream, credentials, internal ID, or raw evidence is exposed.

**Tech Stack:** Node 22 / native `node:test`, JSON Schema, Zod contracts, local Agent Bridge, React 19 + TypeScript + Vitest, existing CloudBase signed-command API.

---

## Scope and invariants

- First-result target is a bounded discovery pass of three minutes; the existing ten-minute total active-research budget remains the hard stop. Keep the server's 15-minute AgentRun lease, which already exceeds that ten-minute active cap, rather than extending an authorization to conceal stalled work.
- Preview candidates exist only in the local bridge state. They contain category, name, and address/location plus `pending`/`verified`/`rejected` state and a short generic rejection reason. They never contain evidence, URLs, raw Codex text, prompts, thread IDs, source-login state, or private input values.
- The discovery schema is not sufficient for `submitProposalBatch`. Only the existing full-output validation and server-side command path may write shared candidates.
- A failed verification removes a preview from the visible list; its generic reason is retained only as an aggregate/safe UI message, not as a raw agent error.
- Preserve the existing claim, signature, sequence, cancellation, recovery, source-block, and reconciliation behavior. New persisted fields must be validated on restore and dropped only during existing safe terminal cleanup.

## File map

| Area | Files |
| --- | --- |
| Public safe protocol | `packages/contracts/src/decision.ts`, `packages/contracts/src/decision.test.ts` |
| Codex schemas and prompt/output validation | `apps/local-agent-bridge/src/codex-travel-discovery.schema.json` (new), `apps/local-agent-bridge/src/codex-runner.mjs`, `apps/local-agent-bridge/src/travel-research-input.mjs`, `apps/local-agent-bridge/src/travel-research-output.mjs`, their tests |
| Bridge orchestration and persistence | `apps/local-agent-bridge/src/cli.mjs`, `apps/local-agent-bridge/src/travel-research-service.mjs`, `apps/local-agent-bridge/src/research-state-store.mjs`, `apps/local-agent-bridge/src/server.mjs`, their tests |
| Browser validation and UI | `apps/web/src/infrastructure/localAgentBridgeClient.ts`, `apps/web/src/infrastructure/localAgentBridgeClient.test.ts`, `apps/web/src/features/decisions/DecisionAgentPanel.tsx`, `apps/web/src/features/decisions/DecisionAgentPanel.test.tsx` |
| Server lease regression | `functions/trip-api/lib/commands.js`, `functions/trip-api/lib/commands.test.js` |

## Tasks

### 1. Define a strict browser-safe progress contract

**Files:**
- Modify: `packages/contracts/src/decision.ts`
- Test: `packages/contracts/src/decision.test.ts`

- [ ] Add a strict `ResearchProgressSchema` used only by active research statuses (`researching`, `resuming`, `validating`, `writing`, and `cancelling`). It should contain:
  - `stage`: `"confirming_scope" | "collecting_candidates" | "verifying_sources" | "writing_shared_decisions" | "stopping"`
  - `candidateCount`: non-negative bounded integer
  - `previews`: max four strict `{ category, name, location, verification: "pending" | "verified" }` values with bounded strings
  - `firstResultDeadlineAt`: canonical datetime, so the browser can render the three-minute wait decision without trusting its own start clock
  - optional `delayNotice: "first_results_delayed"` only after that deadline
- [ ] Make the active-status base require `progress`; leave `idle`, terminal, blocked, and superseded wire shapes unchanged unless a terminal status needs an explicitly safe aggregate failure notice.
- [ ] Write the failing Zod tests first: a collecting status with two pending previews parses; a validating status with verified/pending previews parses; every disallowed field (`prompt`, `log`, `codexThreadId`, `sourceUrl`, `evidence`) and oversized preview fails; terminal statuses reject progress; deadline/phase shape violations fail.
- [ ] Implement the schemas and exported inferred types with the existing strict/discriminated-union style.
- [ ] Verify: `pnpm --filter @travel/contracts test -- decision.test.ts`.
- [ ] Commit: `feat: add safe research progress contract`.

### 2. Split Codex execution into discovery then verification without weakening isolation

**Files:**
- Add: `apps/local-agent-bridge/src/codex-travel-discovery.schema.json`
- Modify: `apps/local-agent-bridge/src/codex-runner.mjs`
- Modify: `apps/local-agent-bridge/src/cli.mjs`
- Modify: `apps/local-agent-bridge/src/travel-research-input.mjs`
- Modify: `apps/local-agent-bridge/src/travel-research-output.mjs`
- Test: `apps/local-agent-bridge/src/codex-runner.test.mjs`
- Test: `apps/local-agent-bridge/src/travel-research-input.test.mjs`
- Test: `apps/local-agent-bridge/src/travel-research-output.test.mjs`

- [ ] Create the discovery JSON Schema. It permits only `{ status: "discovered", category, candidates }`, with 2–4 category-matching candidates and only bounded `name` and `address` fields; include the existing `needs_owner_action` alternatives so source/Codex login pauses remain possible before any preview is exposed.
- [ ] Add failing runner tests proving `runInitial` can accept a named/validated output mode and `resume` can switch to the full schema for the same bound thread. Assert both command argument lists retain `--search`, `--sandbox read-only`, `--ask-for-approval never`, `--strict-config`, and the expected absolute schema path. Assert an unapproved schema path, a mode/schema mismatch, and a discovery object passed to the full validator are rejected.
- [ ] Refactor `createCodexRunner` so each `runInitial`/`resume` call receives a fixed approved output mode (`discovery` or `verified`), selects only the two canonical schema paths injected by the managed factory, and uses the matching pure validator for format-correction retries. Do not accept arbitrary paths or validators from bridge requests.
- [ ] Extend `createManagedCodexRunnerFactory` in `cli.mjs` to canonicalize and verify both bundled schema paths, while preserving the existing owned isolated directory and probe checks. Its `create` API should still accept only service-controlled fields.
- [ ] Add `discoveryPrompt` alongside the existing full `prompt` in `buildTravelResearchInput`. It must retain the single authorized segment/category, read-only/no-booking boundary, untrusted-data framing, and no-ID/signature instruction; it requests only names and locations now, followed by full evidence on the continuation.
- [ ] Add `validateTravelResearchDiscoveryOutput(output, { targetCategory, aliasMap })`, with the same hostile-output sanitation rules as the full validator: exact keys, category match, bounded strings, duplicate rejection, and private-value/credential/path rejection. It must return only the safe preview projection or an existing owner-action result; it must never construct a submission payload.
- [ ] Verify: `pnpm --filter @travel/local-agent-bridge test -- codex-runner.test.mjs travel-research-input.test.mjs travel-research-output.test.mjs`.
- [ ] Commit: `feat: support bounded safe discovery pass`.

### 3. Persist and project discovery progress through the local bridge

**Files:**
- Modify: `apps/local-agent-bridge/src/travel-research-service.mjs`
- Modify: `apps/local-agent-bridge/src/research-state-store.mjs`
- Modify: `apps/local-agent-bridge/src/server.mjs`
- Test: `apps/local-agent-bridge/src/travel-research-service.test.mjs`
- Test: `apps/local-agent-bridge/src/research-state-store.test.mjs`
- Test: `apps/local-agent-bridge/src/server.test.mjs`

- [ ] Start with service tests using the existing `fakeRunner` harness:
  1. starting immediately exposes `collecting_candidates` with zero previews and a deadline exactly three minutes after `startedAt`;
  2. a valid discovery result updates status to pending previews before the verification `resume` promise settles;
  3. the continuation moves to `verifying_sources`, upgrades only names that survive the full validator to `verified`, then writes through the existing proposal reconciliation;
  4. a candidate absent/invalid in the full result disappears before shared submission and does not enter `submittedPayloads`;
  5. no discovery result at three minutes sets `delayNotice`, while the overall ten-minute cap yields `CODEX_RESEARCH_TIMEOUT`, invokes cancellation/revocation, and exposes no stale previews;
  6. restart/recovery restores only a schema-valid active progress record and never restores raw output/prompt/evidence.
- [ ] Add a `DISCOVERY_BUDGET_MS = 3 * 60 * 1000` deadline within the existing ten-minute `ACTIVE_BUDGET_MS`. In `executeTravelResearch`, set `confirming_scope`, build the disclosure, then call `runInitial` in discovery mode. Validate that result locally, persist the safe progress, and set `verifying_sources` before calling the same session's verified-mode `resume` with a fixed continuation prompt.
- [ ] Keep `#consume` responsible for only the existing full-output validation, owner-action handling, signed submission, reconciliation, and terminal cleanup. Thread the previews into its safe status updates so polling can see them; do not add a client-to-server preview command.
- [ ] Update `safeResearchStatus` to construct the exact contract projection from internal state instead of spreading it. Whitelist only stage, count, previews, deadline, and delay notice; reject raw runner result/state fields even if a restored record contains them.
- [ ] Extend the state-store record key validation and tests so `progress` has an exact serializable shape. Ensure cancellation, failure, success, and revocation clear previews before terminal status is returned; retained recovery data must not contain an arbitrary agent message.
- [ ] Exercise all four HTTP status-producing routes in `server.test.mjs` (`execute`, `status`, `resume`, `cancel`) with a progress-bearing status and an injected forbidden field, proving the response stays contract-valid and strips/rejects forbidden internals.
- [ ] Verify: `pnpm --filter @travel/local-agent-bridge test`.
- [ ] Commit: `feat: publish local research discovery progress`.

### 4. Render a useful waiting state and preview cards in the decision panel

**Files:**
- Modify: `apps/web/src/infrastructure/localAgentBridgeClient.ts`
- Test: `apps/web/src/infrastructure/localAgentBridgeClient.test.ts`
- Modify: `apps/web/src/features/decisions/DecisionAgentPanel.tsx`
- Test: `apps/web/src/features/decisions/DecisionAgentPanel.test.tsx`
- Modify (only if required by existing component styling conventions): `apps/web/src/styles/*.css`

- [ ] Add client parsing tests before UI work: bridge responses with valid safe progress are accepted; an extra internal/prohibited preview field is rejected as `INVALID_BRIDGE_RESPONSE`; the existing identity-matching checks remain intact.
- [ ] Add panel tests using fake timers and the existing bridge mock:
  - immediately after start, the panel shows the four ordered steps (范围确认 → 搜集候选 → 核验来源 → 写入共同决定) with the collecting step active;
  - a polling update displays discovery cards at once with name/location and “待核验”, without calling the repository or `onResearchCompleted`;
  - validating updates mark verified previews and remove a rejected/disappeared preview;
  - after `firstResultDeadlineAt`, the panel explains it is still researching and offers `继续等待` (keep polling) plus the existing safe `停止搜索` action;
  - completed still refreshes shared decisions exactly once, and failed/cancelled states show no local pending card.
- [ ] Render the progress strip and candidate card list from `researchStatus.progress`, not from raw API payloads or component-local simulated candidates. Use the existing two-second status polling, add only a one-second local clock tick while an active status has a deadline, and clean it up on lifecycle/trip/bridge changes.
- [ ] Keep the waiting screen compact: stage label and count, then cards as soon as they exist. “继续等待” must dismiss only the delay notice locally until a later status update; it must not create a new AgentRun, continue a Codex task, or send data to CloudBase. “停止搜索” must call the existing cancellation flow.
- [ ] Verify: `pnpm --filter web test -- localAgentBridgeClient.test.ts DecisionAgentPanel.test.tsx` and `pnpm --filter web build`.
- [ ] Commit: `feat: show agent research progress and previews`.

### 5. Verify lease alignment, full regression, and a local non-production smoke path

**Files:**
- Test/modify only if needed: `functions/trip-api/lib/commands.js`, `functions/trip-api/lib/commands.test.js`
- Test: `apps/local-agent-bridge/src/travel-research-service.test.mjs`
- Test: `apps/web/src/features/decisions/DecisionAgentPanel.test.tsx`

- [ ] Add a command test that documents the 15-minute `createAgentRun` expiry and a service test that documents the independent ten-minute active cap; neither test may silently change either constant. The assertion is that the lease remains longer than the total active cap plus the existing bounded cleanup margin.
- [ ] Run focused suites, then the complete relevant checks with Node 22.22+:
  - `pnpm --filter @travel/contracts test`
  - `pnpm --filter @travel/local-agent-bridge test`
  - `pnpm --filter web test`
  - `pnpm --filter web build`
  - `node --test functions/trip-api/lib/commands.test.js functions/trip-api/lib/decision-agent-bridge.test.js`
- [ ] Review `git diff --check` and `git diff --` specifically for protocol leaks, client direct writes, schema-path injection, arbitrary status fields, and accidental secret/test-data changes.
- [ ] Do a local mocked bridge smoke test: start the bridge with a fake/session harness or test transport; confirm initial collecting status, preview display, verified completion, and cancellation. Do not run a new production AgentRun as part of this implementation plan.
- [ ] Commit: `test: cover agent research progress lifecycle` (or fold test-only changes into their feature commit if the project convention prefers it).

## Completion criteria

- Browser status is contract-validated and immediately describes the active research stage.
- A discovery result appears locally as a pending preview before the full verification pass completes.
- Shared decision candidates are still produced only by the existing verified, signed `submitProposalBatch` path.
- A three-minute no-result message gives an honest continue/stop choice; total execution cannot exceed the existing safe active cap and cleanup/revocation is preserved.
- All targeted tests and the web production build pass. Production real-Agent smoke testing remains a separate, user-authorized release action.
