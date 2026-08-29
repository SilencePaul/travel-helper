import "./decisionWorkspace.css";

type Props = {
  onBack: () => void;
};

export function DecisionAccessGuard({ onBack }: Props) {
  return <main className="decision-page decision-access-page" aria-labelledby="decision-access-title">
    <nav className="decision-access-nav" aria-label="共同决定页面操作">
      <button className="control-button control-button--text" type="button" onClick={onBack}><span aria-hidden="true">← </span>返回行程</button>
      <span>PRIVATE JOURNEY · 仅同行者可见</span>
    </nav>

    <section className="decision-access-layout">
      <div className="decision-access-story">
        <p className="decision-access-kicker">DECISION DESK · ACCESS CHECK</p>
        <h1 id="decision-access-title">共同决定，<em>需要两张同行票</em></h1>
        <p className="decision-access-status" role="status">共同决定仅在两位成员登录同一个共享行程后启用。</p>
        <p className="decision-access-note">进入后，你们可以分别填写偏好、比较有来源的候选，并在双方确认后把结果放进行程。</p>
      </div>

      <article className="decision-access-ticket" aria-label="共同决定访问条件">
        <span className="decision-access-notch" aria-hidden="true" />
        <span className="decision-access-notch" aria-hidden="true" />
        <header className="decision-access-ticket-header">
          <span>SHARED TRIP PASS</span>
          <span>02 TRAVELERS</span>
        </header>

        <div className="decision-access-travelers">
          <div><small>TRAVELER 01</small><strong>同行者</strong><span>待验证</span></div>
          <b aria-hidden="true">······</b>
          <div><small>TRAVELER 02</small><strong>同行者</strong><span>待验证</span></div>
        </div>

        <dl className="decision-access-requirements">
          <div><dt>旅程</dt><dd>同一个共享行程</dd></div>
          <div><dt>权限</dt><dd>仅两位成员可见</dd></div>
        </dl>

        <div className="decision-access-stamp" aria-hidden="true">
          <span>待验证</span>
          <small>ACCESS REQUIRED</small>
        </div>
      </article>
    </section>
  </main>;
}
