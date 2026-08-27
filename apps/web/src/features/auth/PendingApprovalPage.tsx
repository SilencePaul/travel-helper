import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { authServiceUrl, signInWithCustomTicket } from "../../infrastructure/authSession";

export function PendingApprovalPage() {
  const navigate = useNavigate();
  const [message, setMessage] = useState("正在等待管理员批准…");
  const refresh = useCallback(async () => {
    try {
      await signInWithCustomTicket(authServiceUrl());
      navigate("/", { replace: true });
    } catch {
      setMessage("尚未批准。你可以稍后手动刷新。");
    }
  }, [navigate]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  return (
    <main aria-labelledby="pending-title">
      <h1 id="pending-title">等待批准</h1>
      <p role="status">{message}</p>
      <button type="button" onClick={() => void refresh()}>手动刷新</button>
    </main>
  );
}
