import { useEffect } from "react";
import { how } from "../copy/en";

/**
 * `/how` — the flow, and then the safety page a recipient actually needs.
 *
 * The second half is the one that earns its keep. A link that carries money is
 * the exact shape of a wallet drainer, so the page names what we will never ask
 * for and then teaches four checks that need no trust in us at all: the host in
 * the URL bar, the fragment that never leaves the browser, the source, and the
 * transaction on a block explorer.
 */
export function How() {
  // "Is this safe?" on the open page links to /how#safe. The section is drawn
  // by script, after the browser's own jump to the fragment, so jump here.
  useEffect(() => {
    if (window.location.hash === "#safe") {
      document.getElementById("safe")?.scrollIntoView?.();
    }
  }, []);

  return (
    <section className="stack">
      <h1>{how.title}</h1>
      <p className="lede" data-testid="how-paragraph">
        {how.inOneParagraph}
      </p>

      <section className="stack" data-testid="never-hold">
        <h2>{how.neverHoldTitle}</h2>
        <p className="hint">{how.neverHoldLede}</p>
        <ol className="strip">
          {how.neverHoldSteps.map((step) => (
            <li key={step.title} className="card">
              <h3>{step.title}</h3>
              <p className="hint">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <h2>{how.stepsTitle}</h2>
      <p className="hint">{how.lede}</p>
      <ol className="steps">
        {how.steps.map((step) => (
          <li key={step.title} className="card">
            <h3>{step.title}</h3>
            <p>{step.body}</p>
          </li>
        ))}
      </ol>
      <p className="fine">{how.fine}</p>

      <section className="stack safety" data-testid="safety" id="safe">
        <h2>{how.safeTitle}</h2>
        <p className="warn" data-testid="never-ask">
          {how.neverAsk}
        </p>
        <p>{how.onlyAsk}</p>
        <p className="fine">{how.neverAskFine}</p>

        <p className="lede">{how.safeLede}</p>
        <ol className="steps">
          {how.safeChecks.map((check) => (
            <li key={check.title} className="card">
              <h3>{check.title}</h3>
              <p>{check.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <p>
        <a href="/">{how.createCta}</a>
      </p>
    </section>
  );
}
