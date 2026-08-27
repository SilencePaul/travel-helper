import { startLogin } from "../../infrastructure/authSession";
import { AuthShell } from "./AuthShell";

export function LoginPage() {
  return (
    <AuthShell step="01 · 登录" title="浅浅计划，认真出发" description="使用飞书确认身份，进入一鸣与美垚的共享行程。">
      <button className="auth-primary" type="button" onClick={() => startLogin()}>使用飞书继续 <span aria-hidden="true">→</span></button>
      <p className="auth-security">仅用于这趟旅行的成员认证</p>
    </AuthShell>
  );
}
