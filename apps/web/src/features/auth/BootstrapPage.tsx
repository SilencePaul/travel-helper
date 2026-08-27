import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { authServiceUrl, bootstrapWithCode } from "../../infrastructure/authSession";

export function BootstrapPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    const submittedCode = code;
    setCode("");
    try {
      await bootstrapWithCode(authServiceUrl(), submittedCode, params.get("state") || "");
      navigate("/", { replace: true });
    } catch {
      setMessage("初始化未完成，请确认口令或稍后重试。");
    }
  }
  return (
    <main aria-labelledby="bootstrap-title">
      <h1 id="bootstrap-title">初始化管理员</h1>
      <p>首次登录需要输入管理员初始化口令。</p>
      <form onSubmit={submit}>
        <label htmlFor="bootstrap-code">一次性口令</label>
        <input id="bootstrap-code" type="password" autoComplete="off" value={code} onChange={(event) => setCode(event.target.value)} required />
        <button type="submit">完成初始化</button>
      </form>
      {message && <p role="alert">{message}</p>}
    </main>
  );
}
