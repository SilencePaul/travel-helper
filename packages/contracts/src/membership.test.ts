import { describe, expect, it } from "vitest";
import { MemberRoleSchema, MemberSchema } from "./membership";

describe("MemberRoleSchema", () => {
  it("only accepts supported membership roles", () => {
    expect(MemberRoleSchema.parse("admin")).toBe("admin");
    expect(MemberRoleSchema.parse("member")).toBe("member");
    expect(MemberRoleSchema.parse("pending")).toBe("pending");
    expect(MemberRoleSchema.parse("removed")).toBe("removed");
    expect(() => MemberRoleSchema.parse("owner")).toThrow();
  });
});

describe("MemberSchema", () => {
  const valid = {
    uid: "user-1234",
    name: "美垚",
    avatarUrl: "https://example.com/avatar.png",
    role: "member",
    version: 0,
    createdAt: "2026-08-27T00:00:00.000Z",
    approvedAt: "2026-08-27T01:00:00.000Z",
  };

  it("accepts a valid member and optional approval fields", () => {
    expect(MemberSchema.parse(valid)).toEqual(valid);
    expect(MemberSchema.parse({ ...valid, avatarUrl: undefined, approvedAt: undefined })).toMatchObject({
      uid: valid.uid,
      role: "member",
    });
  });

  it.each([
    [{ ...valid, uid: "abc" }],
    [{ ...valid, uid: "a".repeat(33) }],
    [{ ...valid, name: "" }],
    [{ ...valid, name: "a".repeat(101) }],
    [{ ...valid, avatarUrl: "not-a-url" }],
    [{ ...valid, version: -1 }],
    [{ ...valid, version: 1.5 }],
    [{ ...valid, createdAt: "2026-08-27" }],
    [{ ...valid, approvedAt: "not-a-date" }],
  ])("rejects invalid member data", (member) => {
    expect(() => MemberSchema.parse(member)).toThrow();
  });
});
