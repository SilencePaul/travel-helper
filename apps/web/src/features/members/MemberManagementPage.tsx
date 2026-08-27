import { useCallback, useEffect, useRef, useState } from "react";
import type { Member } from "@travel/contracts";
import { getCloudbaseClient } from "../../infrastructure/cloudbaseClient";

type MemberAction = "approveMember" | "rejectMember" | "removeMember";
type Command = (input: { action: MemberAction | "listMembers"; uid?: string }) => Promise<{ member?: Member; members?: Member[] }>;

async function cloudbaseCommand(input: { action: MemberAction | "listMembers"; uid?: string }) {
  const response = await getCloudbaseClient().callFunction({ name: "trip-api", data: input });
  const result = response.result as { error?: string; member?: Member; members?: Member[] } | undefined;
  if (result?.error) throw new Error("COMMAND_FAILED");
  return result ?? {};
}

export function MemberManagementPage({ command = cloudbaseCommand, initialMembers }: { command?: Command; initialMembers?: Member[] }) {
  const [members, setMembers] = useState<Member[]>(initialMembers ?? []);
  const [busyUid, setBusyUid] = useState<string>();
  const [error, setError] = useState(false);
  const focusAfterAction = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (initialMembers) return;
    let active = true;
    void command({ action: "listMembers" })
      .then((result) => { if (active) setMembers(result.members ?? []); })
      .catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [command, initialMembers]);

  const act = useCallback(async (member: Member, action: MemberAction, button: HTMLButtonElement) => {
    setBusyUid(member.uid);
    setError(false);
    focusAfterAction.current = button;
    try {
      const result = await command({ action, uid: member.uid });
      if (result.member) setMembers((current) => current.map((item) => item.uid === member.uid ? result.member! : item));
      else setMembers((current) => current.filter((item) => item.uid !== member.uid));
    } catch {
      setError(true);
    } finally {
      setBusyUid(undefined);
      queueMicrotask(() => focusAfterAction.current?.focus());
    }
  }, [command]);

  const pending = members.filter((member) => member.role === "pending");
  const active = members.filter((member) => member.role === "admin" || member.role === "member");
  return (
    <main aria-labelledby="members-title">
      <h1 id="members-title">成员管理</h1>
      {error ? <p role="alert">操作失败，请稍后重试</p> : null}
      <section aria-labelledby="pending-members-title">
        <h2 id="pending-members-title">待批准</h2>
        {pending.map((member) => <div key={member.uid} className="member-row"><span>{member.displayName}</span><span><button type="button" disabled={busyUid !== undefined} onClick={(event) => void act(member, "approveMember", event.currentTarget)}>批准</button><button type="button" disabled={busyUid !== undefined} onClick={(event) => void act(member, "rejectMember", event.currentTarget)}>拒绝</button></span></div>)}
      </section>
      <section aria-labelledby="active-members-title">
        <h2 id="active-members-title">已加入</h2>
        {active.map((member) => <div key={member.uid} className="member-row"><span>{member.displayName}</span><button type="button" disabled={busyUid !== undefined || member.role === "admin"} onClick={(event) => void act(member, "removeMember", event.currentTarget)}>移除</button></div>)}
      </section>
    </main>
  );
}
