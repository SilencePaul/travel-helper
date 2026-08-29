import { useState } from "react";
import type { FormEvent } from "react";
import type { Member } from "@travel/contracts";
import { useNavigate, useSearchParams } from "react-router-dom";
import { authServiceUrl, bootstrapWithCode, recoverAuthenticatedMember } from "../../infrastructure/authSession";
import { AuthShell } from "./AuthShell";

export function BootstrapPage({ onAuthenticated }: { onAuthenticated?: (member: Member) => void } = {}) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const submittedCode = code;
    setCode("");
    setMessage("");
    setIsSubmitting(true);
    try {
      await bootstrapWithCode(authServiceUrl(), submittedCode, params.get("state") || "");
      const member = await recoverAuthenticatedMember();
      if (member.role !== "admin") throw new Error("ADMIN_RECOVERY_FAILED");
      onAuthenticated?.(member);
      navigate("/", { replace: true });
    } catch {
      setMessage("初始化未完成，请确认口令或稍后重试。");
    } finally {
      setIsSubmitting(false);
    }
  }
  return (
    <AuthShell step="03 · 管理员" title="完成管理员初始化" description="这是首次设置。输入你保存在本地的一次性口令，之后不会再次询问。">
      <form className="auth-form" onSubmit={submit}>
        <label htmlFor="bootstrap-code">管理员口令</label>
        <input className="auth-input control-field" id="bootstrap-code" type="password" autoComplete="off" value={code} onChange={(event) => setCode(event.target.value)} required disabled={isSubmitting} />
        <button className="auth-primary control-button control-button--primary" type="submit" aria-busy={isSubmitting} disabled={isSubmitting}>{isSubmitting ? "正在确认身份…" : "完成并进入行程"}</button>
      </form>
      {message && <p className="auth-error" role="alert">{message}</p>}
    </AuthShell>
  );
}
