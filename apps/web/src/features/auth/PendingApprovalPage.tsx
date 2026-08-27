import { useCallback, useEffect, useState } from "react";
import type { Member } from "@travel/contracts";
import { useNavigate } from "react-router-dom";
import { recoverAuthenticatedMember } from "../../infrastructure/authSession";

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
    <main aria-labelledby="pending-title">
      <h1 id="pending-title">等待批准</h1>
      <p role="status">{message}</p>
      <button type="button" onClick={() => void refresh()}>手动刷新</button>
    </main>
  );
}
