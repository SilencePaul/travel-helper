import { useCallback, useEffect, useRef, useState } from "react";
import type { Member } from "@travel/contracts";
import { useLocation, useNavigate } from "react-router-dom";
import { authServiceUrl, exchangeAuthenticationCode, signInWithIssuedTicket, startLogin } from "../../infrastructure/authSession";
import { AuthShell } from "./AuthShell";
import { clearStagedAuthenticationExchange, readStagedAuthenticationExchange } from "../../infrastructure/authCallbackExchange";

export function AuthCallbackPage({ onAuthenticated }: { onAuthenticated?: (member: Member) => void } = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const started = useRef(false);
  const [message, setMessage] = useState(() => readStagedAuthenticationExchange(location.search, window.sessionStorage) ? "正在完成飞书登录…" : "登录未完成，请返回后重试。");
  const [failed, setFailed] = useState(false);
  const completeLogin = useCallback(async () => {
    const params = new URLSearchParams(location.search);
    const state = params.get("state");
    const exchangeCode = readStagedAuthenticationExchange(location.search, window.sessionStorage);
    if (!exchangeCode) {
      setFailed(true);
      setMessage("登录回调已失效，请重新使用飞书登录。");
      return;
    }
    setFailed(false);
    setMessage("正在完成飞书登录…");
    try {
      const { member, ticket } = await exchangeAuthenticationCode(authServiceUrl(), exchangeCode);
      await signInWithIssuedTicket(ticket, member.uid);
      clearStagedAuthenticationExchange(window.sessionStorage);
      if (member.role === "pending") {
        navigate(params.get("status") === "bootstrap" ? "/auth/bootstrap?state=" + encodeURIComponent(state || "") : "/auth/pending", { replace: true });
        return;
      }
      if (member.role !== "admin" && member.role !== "member") throw new Error("NOT_AUTHORIZED");
      onAuthenticated?.(member);
      navigate("/", { replace: true });
    } catch (error: unknown) {
      const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
      if (code === "PENDING_APPROVAL") {
        navigate("/auth/pending", { replace: true });
        return;
      }
      setFailed(true);
      setMessage(code === "AUTH_SERVICE_UNAVAILABLE" ? "登录服务暂时不可用，授权结果仍可重试。" : "登录未完成，授权可能已过期。");
    }
  }, [location.search, navigate, onAuthenticated]);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void completeLogin();
  }, [completeLogin]);
  return (
    <AuthShell step="02 · 身份确认" title="正在核对旅行通行证" description="飞书授权已经完成，我们正在同步这趟旅行的成员身份。">
      {failed ? <><p className="auth-error" role="alert">{message}</p><div className="auth-actions"><button className="auth-secondary control-button control-button--secondary" type="button" onClick={() => void completeLogin()}>重试完成登录</button><button className="auth-secondary control-button control-button--secondary" type="button" onClick={() => startLogin()}>重新使用飞书登录</button></div></> : <div className="auth-progress" role="status"><span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" /><b>{message}</b></div>}
    </AuthShell>
  );
}
