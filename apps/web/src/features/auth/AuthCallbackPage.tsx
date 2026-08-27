import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { authServiceUrl, signInWithCustomTicket } from "../../infrastructure/authSession";

export function AuthCallbackPage() {
  const navigate = useNavigate();
  const started = useRef(false);
  const [message, setMessage] = useState("正在完成飞书登录…");
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    signInWithCustomTicket(authServiceUrl())
      .then(() => navigate("/", { replace: true }))
      .catch((error: unknown) => {
        const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
        if (code === "PENDING_APPROVAL") navigate("/auth/pending", { replace: true });
        else setMessage("登录未完成，请返回后重试。");
      });
  }, [navigate]);
  return <main role="status"><p>{message}</p></main>;
}
