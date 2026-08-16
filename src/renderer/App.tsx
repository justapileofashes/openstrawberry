/**
 * M0 shell. The browser core, Agent rail, and Control Panel are not wired yet,
 * so this surface states that plainly rather than imitating a browser it cannot
 * back with real Chromium views.
 */
export function App(): React.JSX.Element {
  const platform = window.openstrawberry?.shell.platform ?? "unknown";

  return (
    <div className="shell">
      <main className="boot">
        <section className="boot-card glass">
          <span className="eyebrow">OpenStrawberry</span>
          <h1>Desktop shell online.</h1>
          <p>
            The hardened main, preload, and renderer boundary is running. Real
            Chromium browsing, the Agent rail, and the Control Panel arrive in
            later milestones.
          </p>
          <div className="status-row">
            <span className="pill">
              <span className="dot" aria-hidden="true" />
              Work in progress
            </span>
            <span className="pill">{platform}</span>
          </div>
        </section>
      </main>
    </div>
  );
}
