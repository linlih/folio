import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CopyBlock } from "../mcp/McpDialogs";
import { backend } from "../platform";
import { commandErrorText, MIN_PASSPHRASE } from "./status";

/** Settings → Sync: the recovery code, which joins a device when the
 *  passphrase is forgotten (§5.3). The server keeps only the workspace key
 *  wrapped under it, so it is shown once, right after it is made. */
export function RecoveryCode() {
  const { t } = useTranslation();
  const [exists, setExists] = useState<boolean | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    backend.syncRecoveryExists().then(
      (e) => !gone && setExists(e),
      (e) => !gone && setError(commandErrorText(t, e)),
    );
    return () => {
      gone = true;
    };
  }, []);

  async function create() {
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      setShown(await backend.syncRecoveryCreate());
      setExists(true);
    } catch (e) {
      setError(commandErrorText(t, e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="sync-section">
      <h3 className="mcp-subtitle">{t("sync.recovery")}</h3>
      <p className="sync-hint">{t("sync.recoveryHint")}</p>
      {shown ? (
        <>
          <CopyBlock label={t("sync.recoveryCode")} text={shown} />
          <p className="sync-note">{t("sync.recoveryShownOnce")}</p>
          <div className="sync-actions">
            <button className="button primary" onClick={() => setShown(null)}>
              {t("sync.recoverySaved")}
            </button>
          </div>
        </>
      ) : (
        exists !== null && (
          <>
            {exists && <p className="sync-done">{t("sync.recoverySet")}</p>}
            <div className="sync-actions">
              {confirming ? (
                <>
                  <span className="sync-note">{t("sync.recoveryReplaceConfirm")}</span>
                  <button className="button" onClick={() => setConfirming(false)}>
                    {t("dialog.cancel")}
                  </button>
                  <button className="button danger" onClick={() => void create()}>
                    {t("sync.recoveryReplace")}
                  </button>
                </>
              ) : (
                <button className="button" disabled={busy} onClick={() => (exists ? setConfirming(true) : void create())}>
                  {busy ? t("sync.working") : t(exists ? "sync.recoveryReplace" : "sync.recoveryCreate")}
                </button>
              )}
            </div>
          </>
        )
      )}
      {error && <p className="mcp-error">{error}</p>}
    </section>
  );
}

/** Settings → Sync: a new passphrase for devices that join from now on;
 *  the devices already in keep the key they have. */
export function ChangePassphrase() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const short = passphrase.length > 0 && passphrase.length < MIN_PASSPHRASE;
  const mismatch = again.length > 0 && again !== passphrase;
  const ready = passphrase.length >= MIN_PASSPHRASE && again === passphrase;

  function close() {
    setOpen(false);
    setPassphrase("");
    setAgain("");
    setError(null);
  }

  async function submit() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await backend.syncChangePassphrase(passphrase);
      close();
      setDone(true);
    } catch (e) {
      setError(commandErrorText(t, e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="sync-section">
      <h3 className="mcp-subtitle">{t("sync.changePassphrase")}</h3>
      <p className="sync-hint">{t("sync.changePassphraseHint")}</p>
      {done && !open && <p className="sync-done">{t("sync.passphraseChanged")}</p>}
      {open ? (
        <form
          className="sync"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="sync-field">
            <span>{t("sync.newPassphrase")}</span>
            <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="new-password" autoFocus />
          </label>
          <label className="sync-field">
            <span>{t("sync.passphraseAgain")}</span>
            <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
          </label>
          {short && <p className="sync-note">{t("sync.passphraseShort", { n: MIN_PASSPHRASE })}</p>}
          {mismatch && <p className="sync-note">{t("sync.passphraseMismatch")}</p>}
          {error && <p className="mcp-error">{error}</p>}
          <div className="sync-actions">
            <button type="button" className="button" onClick={close}>
              {t("dialog.cancel")}
            </button>
            <button type="submit" className="button primary" disabled={!ready || busy}>
              {busy ? t("sync.working") : t("sync.changePassphraseNow")}
            </button>
          </div>
        </form>
      ) : (
        <div className="sync-actions">
          <button
            className="button"
            onClick={() => {
              setDone(false);
              setOpen(true);
            }}
          >
            {t("sync.changePassphrase")}
          </button>
        </div>
      )}
    </section>
  );
}
