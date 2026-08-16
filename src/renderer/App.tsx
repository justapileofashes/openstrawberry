import { useEffect, useState } from "react";
import type { ShellInfo } from "../shared/bridge.js";

/**
 * M1 shell. Real Chromium browsing, the Agent rail, and the Control Panel are
 * not wired yet, so this surface states that plainly rather than imitating a
 * browser it cannot back with real views.
 *
 * It does exercise the trust boundary for real: the values below arrive over a
 * sender-verified, payload-validated IPC channel.
 */
export function App(): React.JSX.Element {
  const [info, setInfo] = useState<ShellInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    window.openstrawberry.shell
      .getInfo()
      .then((next) => {
        if (active) setInfo(next);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Bridge unavailable.");
      });

    return () => {
      active = false;
    };
  }, []);

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
            <span className="pill">{window.openstrawberry.shell.platform}</span>
            {info !== null && <span className="pill">v{info.appVersion}</span>}
            {info !== null && (
              <span className="pill">
                updates {info.updatesEnabled ? "enabled" : "disabled"}
              </span>
            )}
            {error !== null && <span className="pill">{error}</span>}
          </div>
        </section>
      </main>
    </div>
  );
}
