import { startLogin } from "../../infrastructure/authSession";

export function LoginPage() {
  return (
    <main aria-labelledby="login-title">
      <h1 id="login-title">协作旅行计划</h1>
      <p>使用飞书登录后即可查看或参与行程。</p>
      <button type="button" onClick={() => startLogin()}>使用飞书登录</button>
    </main>
  );
}
