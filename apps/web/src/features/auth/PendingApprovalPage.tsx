import { useCallback, useEffect, useState } from "react";
import type { Member } from "@travel/contracts";
import { useNavigate } from "react-router-dom";
import { recoverAuthenticatedMember } from "../../infrastructure/authSession";
import { AuthShell } from "./AuthShell";
import { memberVerificationCode } from "../members/memberVerification";

export function PendingApprovalPage({ onAuthenticated, onLogout }: { onAuthenticated?: (member: Member) => void; onLogout?: () => Promise<void> } = {}) {
  const navigate = useNavigate();
  const [message, setMessage] = useState("正在等待管理员批准…");
  const [isLeaving, setIsLeaving] = useState(false);
  const [memberUid, setMemberUid] = useState<string>();
  const refresh = useCallback(async () => {
    try {
      const member = await recoverAuthenticatedMember();
      if (member.role === "pending") {
        setMemberUid(member.uid);
        setMessage("尚未批准。你可以稍后手动刷新。");
        return;
      }
      if (member.role !== "admin" && member.role !== "member") throw new Error("NOT_AUTHORIZED");
      onAuthenticated?.(member);
      navigate("/", { replace: true });
    } catch {
      setMessage("尚未批准。你可以稍后手动刷新。");
    }
  }, [navigate, onAuthenticated]);
  useEffect(() => {
    const initial = window.setTimeout(() => { void refresh(); }, 0);
    const timer = window.setInterval(() => { void refresh(); }, 15_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [refresh]);
  const leave = useCallback(async () => {
    if (!onLogout) return;
    setIsLeaving(true);
    try {
      await onLogout();
    } catch {
      setMessage("退出失败，请重试。");
      setIsLeaving(false);
    }
  }, [onLogout]);
  return (
    <AuthShell step="等待同行确认" title="通行证正在盖章" description="管理员批准后，这一页会自动进入共享行程。">
      <p className="auth-status" role="status">{message}</p>
      {memberUid ? <p className="auth-verification">把身份校验码 <code>{memberVerificationCode(memberUid)}</code> 通过飞书私聊或当面告诉管理员；不要转发给其他人。</p> : null}
      <div className="auth-actions">
        <button className="auth-secondary control-button control-button--secondary" type="button" disabled={isLeaving} onClick={() => void refresh()}>重新检查状态</button>
        {onLogout ? <button className="control-button control-button--text" type="button" aria-busy={isLeaving} disabled={isLeaving} onClick={() => void leave()}>{isLeaving ? "正在退出…" : "退出登录"}</button> : null}
      </div>
    </AuthShell>
  );
}
