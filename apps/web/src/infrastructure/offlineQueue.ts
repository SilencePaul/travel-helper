import { z } from "zod";
import { TripSchema } from "@travel/contracts";
import { openOfflineDatabase } from "./offlineStore";

/**
 * Offline saves deliberately contain the complete trip. A partial patch cannot
 * be replayed through TripRepository.save without knowing which server state
 * it was based on.
 */
export const PendingSaveSchema = z.object({
  actorUid: z.string().min(4).max(64),
  tripId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  patch: TripSchema,
  createdAt: z.string().datetime({ offset: true }),
  idempotencyKey: z.string().min(1),
}).strict().superRefine((save, context) => {
  if (save.tripId !== save.patch.id) {
    context.addIssue({
      code: "custom",
      message: "Offline save trip ID must match the trip payload",
      path: ["tripId"],
    });
  }
});

export type PendingSave = z.infer<typeof PendingSaveSchema>;
export type PendingCommand = PendingSave;
export type PendingCommandSender = (command: PendingCommand) => Promise<unknown>;

export type ReplayResult = {
  status: "completed" | "paused-conflict" | "failed";
  replayed: number;
  pending: number;
  error?: unknown;
};

const secretFieldPattern = /(token|ticket|secret|credential|password|authorization|oauth|privatekey|apikey|accesskey|mapkey|qweather|feishu|cloudbase)/i;

function containsSecretField(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsSecretField);
  return Object.entries(value).some(([key, child]) => secretFieldPattern.test(key) || containsSecretField(child));
}

function validateCommand(value: unknown): PendingCommand {
  if (containsSecretField(value)) {
    throw new TypeError("Offline command contains a secret-like field");
  }
  const result = PendingSaveSchema.safeParse(value);
  if (!result.success) {
    throw new TypeError("Offline command does not contain a valid full trip save");
  }
  return structuredClone(result.data);
}

function commandStorageKey(command: Pick<PendingCommand, "actorUid" | "idempotencyKey">) {
  return `${command.actorUid}:${command.idempotencyKey}`;
}

function isLegacyCommand(value: unknown) {
  if (!value || typeof value !== "object" || Object.hasOwn(value, "actorUid") || containsSecretField(value)) return false;
  return PendingSaveSchema.safeParse({ ...value, actorUid: "legacy-user" }).success;
}

function readProperty(value: unknown, property: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    return Reflect.get(value, property);
  } catch {
    return undefined;
  }
}

function readErrorCode(value: unknown): string | undefined {
  const code = readProperty(value, "code");
  if (typeof code === "string") return code;
  const error = readProperty(value, "error");
  return typeof error === "string" ? error : undefined;
}

function isVersionConflict(value: unknown): boolean {
  return readErrorCode(value) === "VERSION_CONFLICT"
    || (value instanceof Error && value.message === "VERSION_CONFLICT");
}

function isAcknowledged(value: unknown): boolean {
  if (value === false || value === undefined || value === null) return false;
  if (!value || typeof value !== "object") return true;
  return readProperty(value, "ok") !== false
    && readProperty(value, "code") === undefined
    && readProperty(value, "error") === undefined;
}

export async function enqueuePendingCommand(input: unknown): Promise<PendingCommand> {
  const command = validateCommand(input);
  const database = await openOfflineDatabase();
  const storageKey = commandStorageKey(command);
  const existing = await database.get("pendingCommands", storageKey);
  if (existing !== undefined) {
    try {
      return validateCommand(existing);
    } catch {
      await database.delete("pendingCommands", storageKey);
    }
  }
  await database.put("pendingCommands", command, storageKey);
  return structuredClone(command);
}

export async function listPendingCommands(actorUid: string, tripId?: string): Promise<PendingCommand[]> {
  const database = await openOfflineDatabase();
  const keys = await database.getAllKeys("pendingCommands");
  const commands: PendingCommand[] = [];
  for (const key of keys) {
    const value = await database.get("pendingCommands", key);
    try {
      const command = validateCommand(value);
      const storageKey = commandStorageKey(command);
      if (key !== storageKey) {
        if (await database.get("pendingCommands", storageKey) === undefined) await database.put("pendingCommands", command, storageKey);
        await database.delete("pendingCommands", key);
      }
      if (command.actorUid === actorUid && (tripId === undefined || command.tripId === tripId)) commands.push(command);
    } catch {
      if (isLegacyCommand(value)) await database.put("quarantinedCommands", value, `legacy:${String(key)}`);
      await database.delete("pendingCommands", key);
    }
  }
  commands.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.idempotencyKey.localeCompare(right.idempotencyKey));
  return commands.map((command) => structuredClone(command));
}

export async function removePendingCommand(actorUid: string, idempotencyKey: string): Promise<void> {
  const database = await openOfflineDatabase();
  await database.delete("pendingCommands", commandStorageKey({ actorUid, idempotencyKey }));
}

export async function replayPendingCommands(sender: PendingCommandSender, actorUid: string, tripId?: string): Promise<ReplayResult> {
  const commands = await listPendingCommands(actorUid, tripId);
  let replayed = 0;
  for (const command of commands) {
    try {
      const acknowledgement = await sender(structuredClone(command));
      if (!isAcknowledged(acknowledgement)) {
        return { status: "failed", replayed, pending: commands.length - replayed };
      }
      await removePendingCommand(command.actorUid, command.idempotencyKey);
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

export function isOfflineCommandSafe(value: unknown): value is PendingCommand {
  try {
    validateCommand(value);
    return true;
  } catch {
    return false;
  }
}
