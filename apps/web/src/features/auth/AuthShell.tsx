import { useId, type ReactNode } from "react";

type AuthShellProps = {
  step: string;
  title: string;
  description: string;
  children: ReactNode;
};

export function AuthShell({ step, title, description, children }: AuthShellProps) {
  const titleId = useId();
  return (
    <main className="auth-shell" aria-labelledby={titleId}>
      <div className="auth-layout">
        <section className="auth-story" aria-label="旅行介绍">
          <p className="auth-brand">一鸣 × 美垚</p>
          <p className="auth-display">两个人，<br /><em>一条向南的路线。</em></p>
          <svg className="auth-route" viewBox="0 0 560 76" role="img" aria-label="深圳、香港、澳门、珠海旅行路线">
            <path d="M14 51 C116 10 179 64 274 33 S430 7 546 47" />
            <circle cx="14" cy="51" r="6" /><circle cx="183" cy="46" r="6" /><circle cx="365" cy="22" r="6" /><circle cx="546" cy="47" r="6" />
          </svg>
          <div className="auth-cities" aria-hidden="true"><span>SZX 深圳</span><span>HKG 香港</span><span>MFM 澳门</span><span>ZUH 珠海</span></div>
          <p className="auth-story-note">把酒店、路线、天气、预算和那些临时起意的小店，都收进同一张旅行通行证里。</p>
          <div className="auth-stamp" aria-hidden="true"><span>OCT</span><strong>03—08</strong><small>2026</small></div>
        </section>

        <section className="auth-pass">
          <header className="auth-pass-meta"><span>TRIP PASS</span><span>PRIVATE JOURNEY</span></header>
          <div className="auth-pass-route" aria-hidden="true">
            <span><strong>SZX</strong><small>出发</small></span><b>✦</b><span><strong>GBA</strong><small>抵达故事</small></span>
          </div>
          <div className="auth-pass-content">
            <p className="auth-step">{step}</p>
            <h1 id={titleId}>{title}</h1>
            <p className="auth-description">{description}</p>
            {children}
          </div>
          <footer className="auth-pass-footer"><span>一鸣 / 美垚</span><span>NO. 1003</span></footer>
        </section>
      </div>
    </main>
  );
}
