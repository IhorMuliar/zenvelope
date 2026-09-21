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
  return (
    <section className="stack">
      <h1>{how.title}</h1>
      <p className="lede">{how.lede}</p>
      <ol className="steps">
        {how.steps.map((step) => (
          <li key={step.title} className="card">
            <h2>{step.title}</h2>
            <p>{step.body}</p>
          </li>
        ))}
      </ol>
      <p className="fine">{how.fine}</p>

      <section className="stack safety" data-testid="safety">
        <h2 id="safe">{how.safeTitle}</h2>
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
