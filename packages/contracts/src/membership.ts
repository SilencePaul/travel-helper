import { z } from "zod";

export const MemberRoleSchema = z.enum(["admin", "member", "pending", "removed"]);

export const MemberSchema = z.object({
  uid: z.string().min(4).max(32),
  displayName: z.string().trim().min(1).max(100),
  avatarUrl: z.url().optional(),
  role: MemberRoleSchema,
  version: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  approvedAt: z.string().datetime().optional(),
});

export type MemberRole = z.infer<typeof MemberRoleSchema>;
export type Member = z.infer<typeof MemberSchema>;
