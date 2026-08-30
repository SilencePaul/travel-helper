import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
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
  const [confirmation, setConfirmation] = useState<{ member: Member; action: "rejectMember" | "removeMember"; trigger: HTMLButtonElement }>();
  const [status, setStatus] = useState<string>();
  const confirmationDialogRef = useRef<HTMLDialogElement>(null);
  const confirmationCancelRef = useRef<HTMLButtonElement>(null);
  const confirmationConfirmRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const pendingHeadingRef = useRef<HTMLHeadingElement>(null);
  const activeHeadingRef = useRef<HTMLHeadingElement>(null);
  const confirmationTitleId = useId();
  const confirmationDescriptionId = useId();

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

  useEffect(() => {
    if (!confirmation) return;
    const dialog = confirmationDialogRef.current;
    if (!dialog) return;
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    confirmationCancelRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close?.();
      dialog.removeAttribute("open");
    };
  }, [confirmation]);

  const act = useCallback(async (member: Member, action: MemberAction) => {
    setBusyUid(member.uid);
    setError(undefined);
    setStatus(undefined);
    try {
      const result = await command({ action, uid: member.uid });
      if (result.member) setMembers((current) => current.map((item) => item.uid === member.uid ? result.member! : item));
      else setMembers((current) => current.filter((item) => item.uid !== member.uid));
      return true;
    } catch (error) {
      if (isUnauthorizedError(error)) {
        setMembers([]);
        onUnauthorized?.(error);
      } else {
        const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
        setError(code === "MEMBER_LIMIT_REACHED" ? "limit" : "action");
      }
      return false;
    } finally {
      setBusyUid(undefined);
    }
  }, [command, onUnauthorized]);

  async function approve(member: Member, trigger: HTMLButtonElement) {
    const succeeded = await act(member, "approveMember");
    if (succeeded) setStatus(`已批准${member.displayName}`);
    requestAnimationFrame(() => {
      if (!succeeded) {
        trigger.focus();
        return;
      }
      const nextApproval = mainRef.current?.querySelector<HTMLButtonElement>('[data-member-action="approveMember"]');
      const nextApprovalStep = nextApproval?.disabled
        ? nextApproval.closest(".member-row")?.querySelector<HTMLInputElement>("input")
        : nextApproval;
      (nextApprovalStep ?? activeHeadingRef.current)?.focus();
    });
  }

  function openConfirmation(member: Member, action: "rejectMember" | "removeMember", trigger: HTMLButtonElement) {
    setError((current) => current === "action" ? undefined : current);
    setConfirmation({ member, action, trigger });
  }

  function cancelConfirmation() {
    if (!confirmation || busyUid) return;
    const trigger = confirmation.trigger;
    setConfirmation(undefined);
    requestAnimationFrame(() => trigger.focus());
  }

  function handleConfirmationKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (busyUid) {
        confirmationDialogRef.current?.focus();
        return;
      }
      cancelConfirmation();
      return;
    }
    if (event.key !== "Tab") return;
    if (busyUid) {
      event.preventDefault();
      confirmationDialogRef.current?.focus();
      return;
    }
    if (!event.shiftKey && document.activeElement === confirmationConfirmRef.current) {
      event.preventDefault();
      confirmationCancelRef.current?.focus();
    } else if (event.shiftKey && document.activeElement === confirmationCancelRef.current) {
      event.preventDefault();
      confirmationConfirmRef.current?.focus();
    }
  }

  async function confirmDestructiveAction() {
    if (!confirmation) return;
    const { member, action } = confirmation;
    const selector = `[data-member-action="${action}"]`;
    const actionIndex = Array.from(mainRef.current?.querySelectorAll<HTMLButtonElement>(`${selector}:not(:disabled)`) ?? []).indexOf(confirmation.trigger);
    confirmationDialogRef.current?.focus();
    const succeeded = await act(member, action);
    if (!succeeded) {
      requestAnimationFrame(() => confirmationConfirmRef.current?.focus());
      return;
    }
    setStatus(action === "rejectMember" ? `已拒绝${member.displayName}` : `已移除${member.displayName}`);
    setConfirmation(undefined);
    requestAnimationFrame(() => {
      const actions = Array.from(mainRef.current?.querySelectorAll<HTMLButtonElement>(`${selector}:not(:disabled)`) ?? []);
      const nextAction = actions[Math.min(Math.max(actionIndex, 0), actions.length - 1)];
      if (nextAction) nextAction.focus();
      else (action === "rejectMember" ? pendingHeadingRef.current : activeHeadingRef.current)?.focus();
    });
  }

  const pending = members.filter((member) => member.role === "pending");
  const active = members.filter((member) => member.role === "admin" || member.role === "member");
  return (
    <main ref={mainRef} className="member-management narrow-page" aria-labelledby="members-title">
      {onBack ? <button type="button" className="back-button control-button control-button--text" aria-label="返回行程总览" onClick={onBack}>← 返回行程总览</button> : null}
      <h1 id="members-title">成员管理</h1>
      {loading ? <p className="empty-state" role="status">正在加载成员…</p> : null}
      {error === "load" ? <p role="alert">成员列表加载失败，请稍后重试。 <button className="control-button control-button--secondary" type="button" onClick={() => { setLoading(true); setError(undefined); setLoadAttempt((current) => current + 1); }}>重新加载成员</button></p> : null}
      {error === "action" && !confirmation ? <p role="alert">操作失败，请稍后重试</p> : null}
      {error === "limit" ? <p role="alert">这趟私人行程最多允许两位成员，请先移除现有成员。</p> : null}
      {status ? <p className="member-action-status" role="status" aria-live="polite">{status}</p> : null}
      <section aria-labelledby="pending-members-title">
        <h2 ref={pendingHeadingRef} id="pending-members-title" tabIndex={-1}>待批准</h2>
        {pending.map((member) => <div key={member.uid} className="member-row member-row--verification" aria-busy={busyUid === member.uid}>
          <span><b>{member.displayName}</b><small>请先通过飞书私聊或当面核对对方等待页上的身份校验码。</small></span>
          <label>身份校验码<input className="control-field" aria-label={`输入${member.displayName}的身份校验码`} autoComplete="off" inputMode="text" placeholder="XXXX-XXXX" value={verificationCodes[member.uid] ?? ""} onChange={(event) => setVerificationCodes((current) => ({ ...current, [member.uid]: event.target.value }))} /></label>
          <span><button className="control-button control-button--primary" type="button" data-member-action="approveMember" disabled={busyUid !== undefined || !matchesMemberVerificationCode(member.uid, verificationCodes[member.uid] ?? "")} onClick={(event) => void approve(member, event.currentTarget)}>{busyUid === member.uid ? "正在批准" : "核对后批准"}</button><button className="control-button control-button--danger" type="button" data-member-action="rejectMember" disabled={busyUid !== undefined} onClick={(event) => openConfirmation(member, "rejectMember", event.currentTarget)}>拒绝</button></span>
        </div>)}
        {!loading && !error && pending.length === 0 ? <p className="empty-state">暂无待批准成员</p> : null}
      </section>
      <section aria-labelledby="active-members-title">
        <h2 ref={activeHeadingRef} id="active-members-title" tabIndex={-1}>已加入</h2>
        {active.map((member) => <div key={member.uid} className="member-row" aria-busy={busyUid === member.uid}><span>{member.displayName}</span><button className="control-button control-button--danger" type="button" data-member-action="removeMember" disabled={busyUid !== undefined || member.role === "admin"} onClick={(event) => openConfirmation(member, "removeMember", event.currentTarget)}>移除</button></div>)}
        {!loading && !error && active.length === 0 ? <p className="empty-state">暂无其他已加入成员</p> : null}
      </section>
      {confirmation ? <dialog
        ref={confirmationDialogRef}
        className="member-confirmation"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={confirmationTitleId}
        aria-describedby={confirmationDescriptionId}
        aria-busy={busyUid === confirmation.member.uid}
        tabIndex={-1}
        onCancel={(event) => { event.preventDefault(); cancelConfirmation(); }}
        onKeyDown={handleConfirmationKeyDown}
      >
        <h2 id={confirmationTitleId}>确认{confirmation.action === "rejectMember" ? "拒绝" : "移除"}{confirmation.member.displayName}</h2>
        <p id={confirmationDescriptionId}>{confirmation.action === "rejectMember" ? "拒绝后，对方将不能加入这趟共享行程。" : "移除后，对方将失去这趟共享行程的访问权限。"}</p>
        {error === "action" ? <p role="alert">操作失败，请稍后重试</p> : null}
        <div>
          <button ref={confirmationCancelRef} className="control-button control-button--secondary" type="button" disabled={busyUid !== undefined} onClick={cancelConfirmation}>取消</button>
          <button ref={confirmationConfirmRef} className="control-button control-button--danger control-button--danger-confirm" type="button" disabled={busyUid !== undefined} onClick={() => void confirmDestructiveAction()}>{busyUid === confirmation.member.uid ? "正在处理" : `确认${confirmation.action === "rejectMember" ? "拒绝" : "移除"}${confirmation.member.displayName}`}</button>
        </div>
      </dialog> : null}
    </main>
  );
}
