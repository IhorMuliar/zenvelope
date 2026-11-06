/**
 * A reopened link whose private route has started or has money waiting. Rendered by the
 * Open page in place of whatever it would show, as soon as the quiet check at the top of
 * the page finds either.
 *
 *   transfer exists      the tracker, straight away (the recipient is on the transfer)
 *   router holds money   "Finish sending": the same three ways to name a wallet as the
 *                        swap flow, then the route runs from the router wallet
 */

import { useState } from "react";
import { privateRoute as copy } from "../copy/en";
import type { RouteProbe } from "../lib/resume";
import { destinationReady, initialSolanaExitState, recipientAddress, solanaExitReducer } from "../lib/solanaFlow";
import type { SolanaExitState } from "../lib/solanaFlow";
import { DestinationChoices } from "./DestinationChoices";
import { MultihopTracker } from "./MultihopTracker";

export function RouteResume({
  getSecret,
  probe,
  footer,
}: {
  getSecret: () => string | null;
  probe: RouteProbe;
  footer?: React.ReactNode;
}) {
  const [state, setState] = useState<SolanaExitState>(initialSolanaExitState);
  const [chosen, setChosen] = useState<string | null>(null);
  const dispatch = (e: Parameters<typeof solanaExitReducer>[1]) => setState((s) => solanaExitReducer(s, e));

  const recipient = probe.transfer?.recipientWallet ?? chosen;
  const asking = !probe.transfer && !chosen;

  return (
    <section className="stack" data-testid="route-resume">
      <h1>{asking ? copy.finishTitle : copy.resumeTitle}</h1>
      {asking ? (
        <div className="card stack" data-testid="route-finish">
          <p>{copy.finishBody}</p>
          <DestinationChoices state={state} dispatch={dispatch} />
          <button
            type="button"
            className="primary"
            disabled={!destinationReady(state)}
            onClick={() => setChosen(recipientAddress(state))}
            data-testid="route-finish-go"
          >
            {copy.finishGo}
          </button>
        </div>
      ) : (
        <MultihopTracker getSecret={getSecret} recipient={recipient} asset={null} mode="resume" />
      )}
      {footer}
    </section>
  );
}
