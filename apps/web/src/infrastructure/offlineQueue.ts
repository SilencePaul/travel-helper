import {
  openOfflineDatabase,
} from "./offlineStore";

export type OfflinePatch = Record<string, unknown>;

export type PendingCommand = {
  tripId: string;
  expectedVersion: number;
  patch: OfflinePatch;
  createdAt: string;
  idempotencyKey: string;
};

export type ReplayResult = {
  status: "completed" | "paused-conflict" | "failed";
  replayed: number;
  pending: number;
  error?: unknown;
};

export type PendingCommandSender = (command: PendingCommand) => Promise<unknown>;

const secretFieldPattern = /(token|ticket|secret|credential|password|authorization|oauth|privatekey|apikey|accesskey|mapkey|qweather|feishu|cloudbase)/i;

function containsSecretField(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsSecretField);
  return Object.entries(value).some(([key, child]) => secretFieldPattern.test(key) || containsSecretField(child));
}

function validateCommand(value: PendingCommand): PendingCommand {
  if (!value || typeof value.tripId !== "string" || value.tripId.length === 0) {
    throw new TypeError("Offline command requires a trip ID");
  }
  if (!Number.isInteger(value.expectedVersion) || value.expectedVersion < 0) {
    throw new TypeError("Offline command requires a non-negative expected version");
  }
  if (!value.patch || typeof value.patch !== "object" || Array.isArray(value.patch)) {
    throw new TypeError("Offline command requires an object patch");
  }
  if (containsSecretField(value.patch)) {
    throw new TypeError("Offline command contains a secret-like field");
  }
  if (!value.idempotencyKey || typeof value.idempotencyKey !== "string") {
    throw new TypeError("Offline command requires an idempotency key");
  }
  if (!value.createdAt || Number.isNaN(Date.parse(value.createdAt))) {
    throw new TypeError("Offline command requires an ISO timestamp");
  }

  return structuredClone({
    tripId: value.tripId,
    expectedVersion: value.expectedVersion,
    patch: value.patch,
    createdAt: value.createdAt,
    idempotencyKey: value.idempotencyKey,
  });
}

function readErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { code?: unknown; error?: unknown };
  if (typeof record.code === "string") return record.code;
  if (typeof record.error === "string") return record.error;
  return undefined;
}

function isVersionConflict(value: unknown): boolean {
  return readErrorCode(value) === "VERSION_CONFLICT"
    || (value instanceof Error && value.message === "VERSION_CONFLICT");
}

function isAcknowledged(value: unknown): boolean {
  if (value === false || value === undefined || value === null) return false;
  if (!value || typeof value !== "object") return true;
  const record = value as { ok?: unknown; code?: unknown; error?: unknown };
  return record.ok !== false && record.code === undefined && record.error === undefined;
}

export async function enqueuePendingCommand(input: PendingCommand): Promise<PendingCommand> {
  const command = validateCommand(input);
  const database = await openOfflineDatabase();
  const existing = await database.get("pendingCommands", command.idempotencyKey);
  if (existing !== undefined) return validateCommand(existing as PendingCommand);
  await database.put("pendingCommands", command, command.idempotencyKey);
  return structuredClone(command);
}

export async function listPendingCommands(tripId?: string): Promise<PendingCommand[]> {
  const database = await openOfflineDatabase();
  const values = await database.getAll("pendingCommands");
  const commands = values
    .map((value) => {
      try {
        return validateCommand(value as PendingCommand);
      } catch {
        return undefined;
      }
    })
    .filter((command): command is PendingCommand => command !== undefined)
    .filter((command) => tripId === undefined || command.tripId === tripId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.idempotencyKey.localeCompare(right.idempotencyKey));
  return commands.map((command) => structuredClone(command));
}

export async function removePendingCommand(idempotencyKey: string): Promise<void> {
  const database = await openOfflineDatabase();
  await database.delete("pendingCommands", idempotencyKey);
}

export async function replayPendingCommands(sender: PendingCommandSender, tripId?: string): Promise<ReplayResult> {
  const commands = await listPendingCommands(tripId);
  let replayed = 0;
  for (const command of commands) {
    try {
      const acknowledgement = await sender(structuredClone(command));
      if (!isAcknowledged(acknowledgement)) {
        return { status: "failed", replayed, pending: commands.length - replayed };
      }
      await removePendingCommand(command.idempotencyKey);
      replayed += 1;
    } catch (error) {
      return {
        status: isVersionConflict(error) ? "paused-conflict" : "failed",
        replayed,
        pending: commands.length - replayed,
        error,
      };
    }
  }
  return { status: "completed", replayed, pending: 0 };
}

export function isOfflineCommandSafe(value: PendingCommand): boolean {
  try {
    validateCommand(value);
    return true;
  } catch {
    return false;
  }
}
