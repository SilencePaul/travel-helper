import { useCallback, useEffect, useState } from "react";
import type { Member } from "@travel/contracts";
import { useNavigate } from "react-router-dom";
import { recoverAuthenticatedMember } from "../../infrastructure/authSession";
import { AuthShell } from "./AuthShell";

export function PendingApprovalPage({ onAuthenticated }: { onAuthenticated?: (member: Member) => void } = {}) {
  const navigate = useNavigate();
  const [message, setMessage] = useState("正在等待管理员批准…");
  const refresh = useCallback(async () => {
    try {
      const member = await recoverAuthenticatedMember();
      if (member.role === "pending") {
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
  return (
    <AuthShell step="等待同行确认" title="通行证正在盖章" description="管理员批准后，这一页会自动进入共享行程。">
      <p className="auth-status" role="status">{message}</p>
      <button className="auth-secondary" type="button" onClick={() => void refresh()}>重新检查状态</button>
    </AuthShell>
  );
}
