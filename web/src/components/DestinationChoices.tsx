import { useCallback, useEffect, useState } from "react";
import { solanaExit as copy } from "../copy/en";
import { ED25519_UNAVAILABLE, checkSolanaAddress, generateSolanaKeypair } from "../lib/solana";
import { WalletConnectError, connectWallet, watchWallets, type DiscoveredWallet } from "../lib/walletStandard";
import { keyTail, keyTailMatches, solanaExitReducer, type SolanaExitState } from "../lib/solanaFlow";
import { CopyButton } from "./CopyButton";
import { CopyField } from "./CopyField";

/**
 * The three ways to name a Solana destination: connect a wallet (read-only, address
 * only), paste an address, or make a new wallet (its key shown once, 4 characters typed
 * back). Shared by the quote flow and the "Finish sending" card on a reopened link; the
 * caller owns the {@link SolanaExitState} and reads the result with `recipientAddress` /
 * `destinationReady`.
 */
export function DestinationChoices({
  state,
  dispatch,
}: {
  state: SolanaExitState;
  dispatch: (event: Parameters<typeof solanaExitReducer>[1]) => void;
}) {
  // Wallet Standard wallets found in this browser (read-only: addresses, no signing).
  const [wallets, setWallets] = useState<DiscoveredWallet[]>([]);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  // Nothing is requested until the recipient presses a wallet.
  useEffect(() => {
    const registry = watchWallets(window, setWallets);
    setWallets(registry.list());
    return () => registry.stop();
  }, []);

  const pickWallet = useCallback(
    async (wallet: DiscoveredWallet) => {
      setConnectError(null);
      setConnecting(wallet.name);
      try {
        const address = await connectWallet(wallet);
        dispatch({ type: "connected", address, name: wallet.name });
      } catch (err) {
        setConnectError(err instanceof WalletConnectError && err.message ? err.message : copy.connectFailed);
      } finally {
        setConnecting(null);
      }
    },
    [dispatch],
  );

  const makeKeypair = useCallback(async () => {
    try {
      dispatch({ type: "keypair", keypair: await generateSolanaKeypair() });
    } catch (err) {
      dispatch({ type: "keypairError", message: (err as Error).message || ED25519_UNAVAILABLE });
    }
  }, [dispatch]);

  const problem = state.mode === "paste" ? checkSolanaAddress(state.pasted) : null;
  const feedback =
    problem === "charset"
      ? copy.invalidCharset
      : problem === "length"
        ? copy.invalidLength
        : problem === null && state.pasted.trim() !== ""
          ? copy.valid
          : null;

  return (
    <ul className="next-steps">
      {/*
        Connect is optional and read-only: it only fetches a public address. It
        is listed only when a Wallet Standard wallet is in this browser. Without
        one (iOS Safari, most phones) paste leads, with a hint for where to copy
        the address from.
      */}
      {wallets.length > 0 ? (
        <li>
          <button
            type="button"
            onClick={() => dispatch({ type: "mode", mode: "connect" })}
            aria-pressed={state.mode === "connect"}
            data-testid="swap-mode-connect"
          >
            <span className="next-title">{copy.connectTitle}</span>
            <span className="hint">{copy.connectBody}</span>
          </button>
          {state.mode === "connect" ? (
            <div className="stack dest-panel" data-testid="swap-connect-panel">
              {state.connectedAddress ? (
                <>
                  <p className="hint">{copy.connectedLine(state.connectedName)}</p>
                  <code className="value mono" data-testid="swap-connected-address">
                    {state.connectedAddress}
                  </code>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => dispatch({ type: "mode", mode: "connect" })}
                    data-testid="swap-connect-another"
                  >
                    {copy.connectAnother}
                  </button>
                </>
              ) : (
                <>
                  <p className="label">{copy.connectPick}</p>
                  <div className="wallet-list">
                    {wallets.map((w) => (
                      <button
                        type="button"
                        className="ghost wallet-pick"
                        key={w.name}
                        disabled={connecting !== null}
                        onClick={() => void pickWallet(w)}
                        data-testid="swap-wallet"
                      >
                        {w.icon ? <img src={w.icon} alt="" width={24} height={24} /> : null}
                        <span>{connecting === w.name ? copy.connectBusy(w.name) : w.name}</span>
                      </button>
                    ))}
                  </div>
                  {connectError ? (
                    <p className="error" data-testid="swap-connect-error">
                      {connectError}
                    </p>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </li>
      ) : null}

      <li>
        <button
          type="button"
          onClick={() => dispatch({ type: "mode", mode: "paste" })}
          aria-pressed={state.mode === "paste"}
          data-testid="swap-mode-paste"
        >
          <span className="next-title">{copy.pasteTitle}</span>
          <span className="hint">
            {wallets.length > 0 ? copy.pasteBody : copy.pasteBodyNoWallet}
          </span>
        </button>
        {state.mode === "paste" ? (
          <div className="stack dest-panel">
            <label className="field">
              <span className="label">{copy.pasteLabel}</span>
              <input
                type="text"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                value={state.pasted}
                placeholder="Solana address"
                onChange={(e) => dispatch({ type: "pasted", value: e.target.value })}
                data-testid="swap-address-input"
              />
            </label>
            {feedback ? (
              <p
                className={problem === null ? "hint" : "error"}
                data-status={problem === null ? "ok" : "error"}
                aria-live="polite"
                data-testid="swap-address-feedback"
              >
                {feedback}
              </p>
            ) : null}
          </div>
        ) : null}
      </li>

      <li>
        <button
          type="button"
          onClick={() => {
            dispatch({ type: "mode", mode: "generate" });
            if (!state.keypair) void makeKeypair();
          }}
          aria-pressed={state.mode === "generate"}
          data-testid="swap-mode-generate"
        >
          <span className="next-title">{copy.generateTitle}</span>
          <span className="hint">{copy.generateBody}</span>
        </button>
        {state.mode === "generate" ? (
          <div className="stack dest-panel">
            {state.keypairError ? (
              <p className="error" data-testid="swap-keypair-error">
                {state.keypairError}
              </p>
            ) : null}
            {state.keypair ? (
              <>
                <div className="copy-field">
                  <div className="copy-field-head">
                    <span className="label">{copy.secretLabel}</span>
                    <CopyButton
                      value={state.keypair.secretKeyBase58}
                      label={copy.keyCopyButton}
                      face={copy.keyCopyButton}
                      className="ghost"
                      testId="swap-copy-key"
                    />
                  </div>
                  <code className="value mono" data-testid="swap-secret-key">
                    {state.keypair.secretKeyBase58}
                  </code>
                </div>
                <p className="warn" data-testid="swap-key-warning">
                  {copy.keyWarning}
                </p>
                <p className="fine" data-testid="swap-secret-once">
                  {copy.secretOnce}
                </p>
                <h3 className="guide-title">{copy.guideTitle}</h3>
                <ol className="numbered small" data-testid="swap-import-guide">
                  {copy.guideSteps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
                <p className="hint" data-testid="swap-import-hint">
                  {copy.importHint}
                </p>
                <CopyField
                  label={copy.addressLabel}
                  value={state.keypair.address}
                  testId="swap-keypair-address"
                />
                <label className="field">
                  <span className="label">{copy.keyConfirmLabel}</span>
                  <input
                    type="text"
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    maxLength={8}
                    value={state.keyConfirm}
                    onChange={(e) => dispatch({ type: "keyConfirm", value: e.target.value })}
                    data-testid="swap-key-confirm"
                  />
                </label>
                {keyTailMatches(state.keypair.secretKeyBase58, state.keyConfirm) ? (
                  <p className="hint" data-status="ok" data-testid="swap-key-confirm-ok">
                    {copy.keyConfirmOk}
                  </p>
                ) : state.keyConfirm.trim().length >= keyTail(state.keypair.secretKeyBase58).length ? (
                  <p className="error" data-status="error" data-testid="swap-key-confirm-wrong">
                    {copy.keyConfirmWrong}
                  </p>
                ) : (
                  <p className="hint" data-testid="swap-saved-blocked">
                    {copy.keyConfirmBlocked}
                  </p>
                )}
              </>
            ) : null}
          </div>
        ) : null}
      </li>
    </ul>
  );
}
