import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { authServiceUrl, signInWithCustomTicket } from "../../infrastructure/authSession";

export function AuthCallbackPage({ onAuthenticated }: { onAuthenticated?: () => void } = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const started = useRef(false);
  const [message, setMessage] = useState("正在完成飞书登录…");
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(location.search);
    const state = params.get("state");
    if (params.get("status") === "bootstrap") {
      navigate("/auth/bootstrap?state=" + encodeURIComponent(state || ""), { replace: true });
      return;
    }
    signInWithCustomTicket(authServiceUrl())
      .then(() => {
        onAuthenticated?.();
        navigate("/", { replace: true });
      })
      .catch((error: unknown) => {
        const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
        if (code === "PENDING_APPROVAL") navigate("/auth/pending", { replace: true });
        else setMessage("登录未完成，请返回后重试。");
      });
  }, [location.search, navigate, onAuthenticated]);
  return <main role="status"><p>{message}</p></main>;
}
