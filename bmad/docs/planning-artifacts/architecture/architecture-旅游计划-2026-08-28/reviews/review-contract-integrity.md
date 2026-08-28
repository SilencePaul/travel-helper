---
title: Architecture contract-integrity review
status: approved-for-implementation
reviewed: 2026-08-28
scope:
  - ../ARCHITECTURE-SPINE.md
  - ../../prds/prd-旅游计划-2026-08-28/prd.md
  - ../../prds/prd-旅游计划-2026-08-28/addendum.md
  - ../../../../../../packages/contracts/src/trip.ts
  - ../../../../../../packages/contracts/src/repository.ts
  - ../../../../../../functions/trip-api/lib/commands.js
  - ../../../../../../cloudbase/database.rules.json
---

# Contract-integrity review

**Verdict: approved for implementation (2026-08-28 revision).** The seven implementation-critical omissions below have been resolved in `ARCHITECTURE-SPINE.md`; the original findings are retained as the review trail.

| Lens | Location | Finding | Required guard | Consequence |
| --- | --- | --- | --- | --- |
| authorization | `AD-7`, `Authorization Matrix`, `Structural Seed` | Readable decision documents copy `memberUids` and clients subscribe directly, but no membership-change transaction updates those copied lists. Existing `removeMember` updates only `trips.memberUids`; the global CloudBase rule authorizes reads solely from the subscribed document. | Define an atomic membership-propagation command for every readable decision collection, or remove direct collection reads and serve workspace reads through `trip-api` only. Agent-run documents must omit `memberUids`. | A removed partner can continue reading stale decision documents. |
| agent boundary | `AD-5`, `requestAgentRun`, `Deferred 1` | The design says the plaintext run token is available only to the local Bridge, while the existing API authenticates only CloudBase browser callers. It defines neither a one-time Bridge-claim channel nor a proof that the claimant is the locally approved Agent. | Make an explicit `createAgentRun -> localBridgeClaim` protocol: authenticated browser approval, opaque one-time claim code, local loopback/desktop binding, token hash + expiry + revocation, and no token in CloudBase/read payloads. | A developer may pass a bearer token through the web client or be unable to connect the Agent at all. |
| domain / FR-8 | `Candidate` contract; `placeTentative`; Deferred 2 | `placeTentative` promises a placement but neither `Candidate` nor a separate model defines a placement ID, day/date, order, or a link to the existing `Trip.itemIds`. Deferred 2 confirms the mapping is unresolved. | Introduce a `TentativePlacement` resource/field with `candidateId`, intended day/date and optional linked legacy item ID; define the explicit two-step CAS when adding it to `Trip`. | Frontend cannot render or synchronize a candidate's actual tentative daily arrangement. |
| shared TypeScript contract | `Error envelope` and lines 311–327 | `DecisionResource` is referenced but never defined, `CommandResult` is not exported into the proposed contract, and `command` accepts `action: string` plus arbitrary payload. | Export a discriminated command union and response union, including resource-specific latest values; define `DecisionResource`. | Web and function implementations can compile against incompatible action payloads and conflict responses. |
| verification integrity | `appendEvidenceSnapshot`; `EvidenceSnapshot`; verification rules | `fieldCompleteness: string[]` and free-form `facts` have no category-required field vocabulary or service-side transition predicate. A member or scoped Agent can therefore submit a claimed `web_verified` snapshot that another implementation treats as incomplete. | Specify required keys per `hotel`, `restaurant`, and `attraction`, and have `trip-api` derive/validate `web_verified` only from `sourceKind: web|official`, current-page provenance, and the required fields. | A candidate can be displayed as webpage-verified without PRD-required evidence. |
| state transition | `setConfirmationReceipt`; decision state machine | The contract does not state that a receipt is rejected unless the candidate is `tentative`, nor how a candidate's direct placement update and the corresponding legacy `Trip.version` write are recovered when one succeeds and the other conflicts. | Define receipt preconditions and an explicit compensation/retry result for the two-resource placement flow. | Confirmation and daily itinerary can diverge after concurrent edits. |
| realtime / offline | `watchDecisionWorkspace`; `workspaceCursor`; Offline convention | Cursor semantics, collection ordering, deletion/tombstone behavior, and the snapshot boundary are unspecified although the client is told to merge independent collection subscriptions. | Define cursor source/order, event identity and tombstones; make `getDecisionWorkspace` return a cursor that is transactionally consistent with the included resources. | Reconnect can omit or resurrect feedback/evidence and show inconsistent current evidence. |

## Resolution check

| Original finding | Resolved architecture rule |
| --- | --- |
| ACL copy on decision documents | AD-7 now makes all decision collections server-private: they omit `memberUids`, and `getDecisionWorkspace` / `getDecisionEvents` re-check canonical Trip membership on every request. |
| Agent claim channel | AD-5 fixes `createAgentRun -> loopback claimAgentRun -> ES256 signed agentCommand`, with a consumed pairing-code hash, 15-minute expiry, monotonic sequence and no bearer credential. |
| Tentative / legacy mismatch | `TentativePlacement`, `attachTentativeToLegacyTrip` and `detachTentativeFromLegacyTrip` define the two-step UI flow and single-transaction legacy Trip linkage. |
| Untyped command seam | The minimal TypeScript contract exports `DecisionResource`, discriminated `DecisionCommand`, `AgentCommand`, `AgentClaim`, success/failure responses and typed conflict payloads. |
| Free-form verification | The server-side predicate fixes source/capture requirements, age limits and required facts for hotel, restaurant and attraction. |
| Receipt transition ambiguity | Candidate rules now require an active planned/linked placement and tentative state; withdrawal, detachment or member removal explicitly derives a fallback to tentative. |
| Cursor/reconnect ambiguity | `trip_decision_meta` sequence, append-only events, tombstones, consistent snapshot cursor and `CURSOR_EXPIRED` reload behavior are now fixed. |

## Coverage check

FR-1 through FR-9 each has a named domain resource, command/query boundary, and capability map entry. The gaps above affect the enforceability of FR-4, FR-6, FR-8, and FR-9 rather than their stated coverage.

## Current-code alignment

- Correct: the existing `TripSchema` / `TripRepository` only support whole-trip `version` CAS; the new decision workspace must remain parallel.
- Correct: the existing `trip-api` actor is obtained from the CloudBase runtime and `saveTrip` returns only `currentVersion` on conflict; a scoped Agent path and richer decision conflict response are new work.
- Correct: the current database rule has read access based exclusively on `doc.memberUids` and denies all direct writes; this makes the first finding an implementation-critical security requirement.
