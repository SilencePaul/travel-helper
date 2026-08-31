const { createHash, createPublicKey, timingSafeEqual, verify } = require("node:crypto");

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Base64Url(value) {
  return createHash("sha256").update(value).digest("base64url");
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function one(result) {
  if (!result || !Object.hasOwn(result, "data")) return undefined;
  return Array.isArray(result.data) ? result.data[0] : result.data;
}

function sameSecret(left, right) {
  const leftBuffer = Buffer.from(left || "");
  const rightBuffer = Buffer.from(right || "");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function verifySignedValue(publicKeyJwk, value, signature) {
  try {
    if (publicKeyJwk?.kty !== "EC" || publicKeyJwk?.crv !== "P-256") return false;
    const publicKey = createPublicKey({ key: publicKeyJwk, format: "jwk" });
    return verify(
      "sha256",
      Buffer.from(canonicalJson(value)),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

function createDecisionAgentBridge({ now = () => new Date() } = {}) {
  function assertUsableRun(run) {
    if (!run || new Date(run.expiresAt).getTime() <= now().getTime()) throw codedError("AGENT_RUN_EXPIRED");
  }

  return {
    async claim(transaction, input, beforeCommit) {
      const runs = transaction.collection("trip_agent_runs");
      const run = one(await runs.doc(input.agentRunId).get());
      const signed = { agentRunId: input.agentRunId, pairingCode: input.pairingCode, clientNonce: input.clientNonce };
      if (!run || !verifySignedValue(run.publicKeyJwk, signed, input.signature)) throw codedError("INVALID_AGENT_CLAIM");
      const claimRequestFingerprint = sha256Base64Url(canonicalJson(signed));
      if (run?.claimRequestFingerprint) {
        if (sameSecret(run.claimRequestFingerprint, claimRequestFingerprint) && run.claimResult) return run.claimResult;
        throw codedError("INVALID_AGENT_CLAIM");
      }
      assertUsableRun(run);
      if (run.status !== "pending_claim"
        || !sameSecret(run.pairingCodeHash, sha256Base64Url(input.pairingCode))) {
        throw codedError("INVALID_AGENT_CLAIM");
      }
      if (beforeCommit) await beforeCommit(run);
      const { pairingCodeHash: _consumedPairingCodeHash, ...withoutPairingCode } = run;
      const claimedAt = now().toISOString();
      const claimed = {
        ...withoutPairingCode,
        status: "claimed",
        clientNonce: input.clientNonce,
        claimedAt,
        revision: run.revision + 1,
      };
      const claimResult = { agentRunId: run.id, claimedAt, nextSequence: run.lastSequence + 1 };
      await runs.doc(run.id).set({ ...claimed, claimRequestFingerprint, claimResult });
      return claimResult;
    },

    async run(transaction, input, operation) {
      const runs = transaction.collection("trip_agent_runs");
      const run = one(await runs.doc(input.agentRunId).get());
      const signed = {
        agentRunId: input.agentRunId,
        sequence: input.sequence,
        idempotencyKey: input.idempotencyKey,
        action: input.action,
        payload: input.payload,
      };
      if (!run) throw codedError("INVALID_AGENT_CLAIM");
      if (!verifySignedValue(run.publicKeyJwk, signed, input.signature)) throw codedError("INVALID_AGENT_CLAIM");

      const idempotency = transaction.collection("trip_agent_idempotency");
      const id = `${input.agentRunId}:${input.action}:${input.idempotencyKey}`;
      const request = canonicalJson(signed);
      const prior = one(await idempotency.doc(id).get());
      if (prior) {
        if (prior.sequence !== input.sequence || prior.request !== request) throw codedError("IDEMPOTENCY_KEY_REUSED");
        return { result: prior.result, replayed: true };
      }
      assertUsableRun(run);
      if (run.status !== "claimed") throw codedError("INVALID_AGENT_CLAIM");
      if (input.action !== "getDecisionContext" && !run.scope.includes(input.action)) throw codedError("AGENT_SCOPE_FORBIDDEN");
      if (input.sequence !== run.lastSequence + 1) throw codedError("INVALID_AGENT_CLAIM");

      const result = await operation(run);
      await runs.doc(run.id).set({
        ...run,
        lastSequence: input.sequence,
        revision: run.revision + 1,
        lastUsedAt: now().toISOString(),
      });
      await idempotency.doc(id).set({
        agentRunId: run.id,
        action: input.action,
        sequence: input.sequence,
        request,
        result,
        createdAt: now().toISOString(),
      });
      return { result, replayed: false };
    },
  };
}

module.exports = { canonicalJson, createDecisionAgentBridge, sha256Base64Url };
