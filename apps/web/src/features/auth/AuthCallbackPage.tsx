import { useEffect, useRef, useState } from "react";
import type { Member } from "@travel/contracts";
import { useLocation, useNavigate } from "react-router-dom";
import { recoverAuthenticatedMember } from "../../infrastructure/authSession";
import { AuthShell } from "./AuthShell";

export function AuthCallbackPage({ onAuthenticated }: { onAuthenticated?: (member: Member) => void } = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const started = useRef(false);
  const [message, setMessage] = useState("正在完成飞书登录…");
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(location.search);
    const state = params.get("state");
    recoverAuthenticatedMember()
      .then((member) => {
        if (member.role === "pending") {
          navigate(params.get("status") === "bootstrap" ? "/auth/bootstrap?state=" + encodeURIComponent(state || "") : "/auth/pending", { replace: true });
          return;
        }
        if (member.role !== "admin" && member.role !== "member") throw new Error("NOT_AUTHORIZED");
        onAuthenticated?.(member);
        navigate("/", { replace: true });
      })
      .catch((error: unknown) => {
        const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
        if (code === "PENDING_APPROVAL") navigate("/auth/pending", { replace: true });
        else if (params.get("status") === "bootstrap") navigate("/auth/bootstrap?state=" + encodeURIComponent(state || ""), { replace: true });
        else setMessage("登录未完成，请返回后重试。");
      });
  }, [location.search, navigate, onAuthenticated]);
  return (
    <AuthShell step="02 · 身份确认" title="正在核对旅行通行证" description="飞书授权已经完成，我们正在同步这趟旅行的成员身份。">
      <div className="auth-progress" role="status"><span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" /><b>{message}</b></div>
    </AuthShell>
  );
}
