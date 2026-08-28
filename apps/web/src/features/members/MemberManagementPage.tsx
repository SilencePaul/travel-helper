import { useCallback, useEffect, useRef, useState } from "react";
import type { Member } from "@travel/contracts";
import { getCloudbaseClient } from "../../infrastructure/cloudbaseClient";
import { ForbiddenError, isUnauthorizedError, UnauthorizedError } from "../../infrastructure/cloudbaseTripRepository";
import { matchesMemberVerificationCode } from "./memberVerification";

type MemberAction = "approveMember" | "rejectMember" | "removeMember";
type Command = (input: { action: MemberAction | "listMembers"; uid?: string }) => Promise<{ member?: Member; members?: Member[] }>;

async function cloudbaseCommand(input: { action: MemberAction | "listMembers"; uid?: string }) {
  const response = await getCloudbaseClient().callFunction({ name: "trip-api", data: input });
  const result = response.result as { error?: string; member?: Member; members?: Member[] } | undefined;
  if (result?.error) {
    if (isUnauthorizedError(result)) {
      throw result.error === "FORBIDDEN" ? new ForbiddenError() : new UnauthorizedError();
    }
    if (result.error === "MEMBER_LIMIT_REACHED") {
      throw Object.assign(new Error("MEMBER_LIMIT_REACHED"), { code: "MEMBER_LIMIT_REACHED" });
    }
    throw new Error("COMMAND_FAILED");
  }
  return result ?? {};
}

export function MemberManagementPage({ command = cloudbaseCommand, initialMembers, onUnauthorized, onBack }: { command?: Command; initialMembers?: Member[]; onUnauthorized?: (error: unknown) => void; onBack?: () => void }) {
  const [members, setMembers] = useState<Member[]>(initialMembers ?? []);
  const [busyUid, setBusyUid] = useState<string>();
  const [error, setError] = useState<"load" | "action" | "limit">();
  const [loading, setLoading] = useState(initialMembers === undefined);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [verificationCodes, setVerificationCodes] = useState<Record<string, string>>({});
  const focusAfterAction = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (initialMembers) return;
    let active = true;
    void command({ action: "listMembers" })
      .then((result) => { if (active) setMembers(result.members ?? []); })
      .catch((error) => {
        if (!active) return;
        if (isUnauthorizedError(error)) {
          setMembers([]);
          onUnauthorized?.(error);
          return;
        }
        setError("load");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [command, initialMembers, loadAttempt, onUnauthorized]);

  const act = useCallback(async (member: Member, action: MemberAction, button: HTMLButtonElement) => {
    setBusyUid(member.uid);
    setError(undefined);
    focusAfterAction.current = button;
    try {
      const result = await command({ action, uid: member.uid });
      if (result.member) setMembers((current) => current.map((item) => item.uid === member.uid ? result.member! : item));
      else setMembers((current) => current.filter((item) => item.uid !== member.uid));
    } catch (error) {
      if (isUnauthorizedError(error)) {
        setMembers([]);
        onUnauthorized?.(error);
      } else {
        const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
        setError(code === "MEMBER_LIMIT_REACHED" ? "limit" : "action");
      }
    } finally {
      setBusyUid(undefined);
      queueMicrotask(() => focusAfterAction.current?.focus());
    }
  }, [command, onUnauthorized]);

  const pending = members.filter((member) => member.role === "pending");
  const active = members.filter((member) => member.role === "admin" || member.role === "member");
  return (
    <main className="member-management narrow-page" aria-labelledby="members-title">
      {onBack ? <button type="button" className="back-button" aria-label="返回行程总览" onClick={onBack}>← 返回行程总览</button> : null}
      <h1 id="members-title">成员管理</h1>
      {loading ? <p className="empty-state" role="status">正在加载成员…</p> : null}
      {error === "load" ? <p role="alert">成员列表加载失败，请稍后重试。 <button type="button" onClick={() => { setLoading(true); setError(undefined); setLoadAttempt((current) => current + 1); }}>重新加载成员</button></p> : null}
      {error === "action" ? <p role="alert">操作失败，请稍后重试</p> : null}
      {error === "limit" ? <p role="alert">这趟私人行程最多允许两位成员，请先移除现有成员。</p> : null}
      <section aria-labelledby="pending-members-title">
        <h2 id="pending-members-title">待批准</h2>
        {pending.map((member) => <div key={member.uid} className="member-row member-row--verification">
          <span><b>{member.displayName}</b><small>请先通过飞书私聊或当面核对对方等待页上的身份校验码。</small></span>
          <label>身份校验码<input aria-label={`输入${member.displayName}的身份校验码`} autoComplete="off" inputMode="text" placeholder="XXXX-XXXX" value={verificationCodes[member.uid] ?? ""} onChange={(event) => setVerificationCodes((current) => ({ ...current, [member.uid]: event.target.value }))} /></label>
          <span><button type="button" disabled={busyUid !== undefined || !matchesMemberVerificationCode(member.uid, verificationCodes[member.uid] ?? "")} onClick={(event) => void act(member, "approveMember", event.currentTarget)}>核对后批准</button><button type="button" disabled={busyUid !== undefined} onClick={(event) => void act(member, "rejectMember", event.currentTarget)}>拒绝</button></span>
        </div>)}
        {!loading && !error && pending.length === 0 ? <p className="empty-state">暂无待批准成员</p> : null}
      </section>
      <section aria-labelledby="active-members-title">
        <h2 id="active-members-title">已加入</h2>
        {active.map((member) => <div key={member.uid} className="member-row"><span>{member.displayName}</span><button type="button" disabled={busyUid !== undefined || member.role === "admin"} onClick={(event) => void act(member, "removeMember", event.currentTarget)}>移除</button></div>)}
        {!loading && !error && active.length === 0 ? <p className="empty-state">暂无其他已加入成员</p> : null}
      </section>
    </main>
  );
}
