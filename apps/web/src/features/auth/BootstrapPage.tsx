import { useState } from "react";
import type { FormEvent } from "react";
import type { Member } from "@travel/contracts";
import { useNavigate, useSearchParams } from "react-router-dom";
import { authServiceUrl, bootstrapWithCode, recoverAuthenticatedMember } from "../../infrastructure/authSession";

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
    <main aria-labelledby="bootstrap-title">
      <h1 id="bootstrap-title">初始化管理员</h1>
      <p>首次登录需要输入管理员初始化口令。</p>
      <form onSubmit={submit}>
        <label htmlFor="bootstrap-code">一次性口令</label>
        <input id="bootstrap-code" type="password" autoComplete="off" value={code} onChange={(event) => setCode(event.target.value)} required disabled={isSubmitting} />
        <button type="submit" disabled={isSubmitting}>{isSubmitting ? "正在确认身份…" : "完成初始化"}</button>
      </form>
      {message && <p role="alert">{message}</p>}
    </main>
  );
}
