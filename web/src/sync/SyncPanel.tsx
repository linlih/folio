import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { formatSize } from "../editor/assets";
import type { SyncStatus } from "../bindings/commands";
import { CopyBlock } from "../mcp/McpDialogs";
import { backend } from "../platform";
import { useShell } from "../shell/tabs";
import { DeviceList } from "./DeviceList";
import { ChangePassphrase, RecoveryCode } from "./Recovery";
import { commandErrorText, errorText, MIN_PASSPHRASE, useSyncStatus } from "./status";
import "./sync.css";


/** Settings → Sync: set up this device (a new workspace, or join one with a
 *  sync code), then its state and the code for the next device (§5.3). */
export function SyncPanel() {
  const { t } = useTranslation();
  const [status, setStatus] = useSyncStatus();
  return (
    <>
      {status === null && <p className="dialog-empty">{t("settings.diagnosticsUnavailable")}</p>}
      {status && (status.enabled ? <Enabled status={status} onChange={setStatus} /> : <Setup onDone={setStatus} />)}
    </>
  );
}

function Setup({ onDone }: { onDone: (s: SyncStatus) => void }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"create" | "join">("create");
  const [server, setServer] = useState("http://127.0.0.1:8787");
  const [token, setToken] = useState("");
  const [code, setCode] = useState("");
  // Joining with the recovery code when the passphrase is forgotten.
  const [recover, setRecover] = useState(false);
  const [recovery, setRecovery] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recovering = mode === "join" && recover;
  const twice = mode === "create" || recovering;
  const short = passphrase.length > 0 && passphrase.length < MIN_PASSPHRASE;
  const mismatch = twice && again.length > 0 && again !== passphrase;
  const ready =
    passphrase.length >= MIN_PASSPHRASE &&
    (!twice || again === passphrase) &&
    (mode === "create" ? server.trim() !== "" && token.trim() !== "" : code.trim() !== "" && (!recover || recovery.trim() !== ""));

  async function submit() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      onDone(
        mode === "create"
          ? await backend.syncCreate(server, token, passphrase)
          : recover
            ? await backend.syncJoinRecovery(code, recovery, passphrase)
            : await backend.syncJoin(code, passphrase),
      );
    } catch (e) {
      setError(commandErrorText(t, e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="sync"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="mcp-clients-pick" role="tablist">
        {(["create", "join"] as const).map((m) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} className={`mcp-client${mode === m ? " on" : ""}`} onClick={() => setMode(m)}>
            {t(`sync.${m}`)}
          </button>
        ))}
      </div>
      <p className="sync-hint">{t(mode === "create" ? "sync.createHint" : recover ? "sync.recoverHint" : "sync.joinHint")}</p>
      {mode === "create" ? (
        <>
          <label className="sync-field">
            <span>{t("sync.server")}</span>
            <input value={server} onChange={(e) => setServer(e.target.value)} spellCheck={false} autoComplete="off" />
          </label>
          <label className="sync-field">
            <span>{t("sync.token")}</span>
            <input value={token} onChange={(e) => setToken(e.target.value)} spellCheck={false} autoComplete="off" placeholder="FOLIO_SERVER_TOKEN" />
          </label>
        </>
      ) : (
        <>
          <label className="sync-field">
            <span>{t("sync.code")}</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} spellCheck={false} autoComplete="off" placeholder="folio-sync:…" />
          </label>
          {recover && (
            <label className="sync-field">
              <span>{t("sync.recoveryCode")}</span>
              <input value={recovery} onChange={(e) => setRecovery(e.target.value)} spellCheck={false} autoComplete="off" placeholder="XXXX-XXXX-…" />
            </label>
          )}
        </>
      )}
      <label className="sync-field">
        <span>{t(recovering ? "sync.newPassphrase" : "sync.passphrase")}</span>
        <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="new-password" />
      </label>
      {twice && (
        <label className="sync-field">
          <span>{t("sync.passphraseAgain")}</span>
          <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
        </label>
      )}
      {short && <p className="sync-note">{t("sync.passphraseShort", { n: MIN_PASSPHRASE })}</p>}
      {mismatch && <p className="sync-note">{t("sync.passphraseMismatch")}</p>}
      {mode === "create" && <p className="sync-note">{t("sync.passphraseWarning")}</p>}
      {recovering && <p className="sync-note">{t("sync.recoverNote")}</p>}
      {error && <p className="mcp-error">{error}</p>}
      <div className="sync-actions">
        {mode === "join" && (
          <button type="button" className="sync-link" onClick={() => setRecover(!recover)}>
            {t(recover ? "sync.useAPassphrase" : "sync.forgotPassphrase")}
          </button>
        )}
        <button type="submit" className="button primary" disabled={!ready || busy}>
          {busy ? t("sync.working") : t(mode === "create" ? "sync.createNow" : "sync.joinNow")}
        </button>
      </div>
    </form>
  );
}

/** Files: what waits to go up or come down, the server's total, or the
 *  last failure. */
function filesText(t: TFunction, s: SyncStatus): string {
  if (s.filesError) return t("sync.stateError", { message: errorText(t, { error: s.filesError, errorKind: s.filesErrorKind }) });
  const parts: string[] = [];
  if (s.filesUp) parts.push(t("sync.filesUp", { count: s.filesUp }));
  if (s.filesDown) parts.push(t(s.filesAll ? "sync.filesDown" : "sync.filesNotDownloaded", { count: s.filesDown }));
  if (!parts.length) parts.push(t("sync.filesSynced"));
  if (s.serverFileBytes) parts.push(t("sync.filesOnServer", { size: formatSize(s.serverFileBytes) }));
  return parts.join(" · ");
}

function Enabled({ status, onChange }: { status: SyncStatus; onChange: (s: SyncStatus) => void }) {
  const { t } = useTranslation();
  const setNotice = useShell((s) => s.setNotice);
  const [confirmStop, setConfirmStop] = useState(false);
  const time = (ms: number) => new Intl.DateTimeFormat(undefined, { timeStyle: "medium" }).format(new Date(ms));
  const state = status.error
    ? t("sync.stateError", { message: errorText(t, status) })
    : status.syncing
      ? t("sync.stateSyncing")
      : status.lastSync
        ? t("sync.stateDone", { time: time(status.lastSync) })
        : t("sync.stateStarting");

  return (
    <div className="sync">
      <div className="mcp-field">
        <span>{t("sync.server")}</span>
        <code>{status.server}</code>
        <span className={`mcp-state${status.live ? " on" : ""}`}>{status.live ? t("sync.live") : t("sync.offline")}</span>
      </div>
      <div className="mcp-field">
        <span>{t("sync.state")}</span>
        <span className={`sync-value ${status.error ? "mcp-error" : "sync-state"}`}>{state}</span>
        <button className="icon-button" title={t("sync.now")} aria-label={t("sync.now")} onClick={() => void backend.syncNow()}>
          <RefreshCw size={14} className={status.syncing ? "spin" : undefined} />
        </button>
      </div>
      <div className="mcp-field">
        <span>{t("sync.pending")}</span>
        <span className="sync-value sync-state">{status.pending === 0 ? t("sync.pendingNone") : t("sync.pendingSome", { count: status.pending })}</span>
      </div>
      <div className="mcp-field">
        <span>{t("sync.files")}</span>
        <span className={`sync-value ${status.filesError ? "mcp-error" : "sync-state"}`}>{filesText(t, status)}</span>
      </div>
      <CopyBlock label={t("sync.codeLabel")} text={status.code} />
      <p className="sync-hint">{t("sync.codeHint")}</p>
      {status.errorKind !== "removed" && (
        <>
          <RecoveryCode />
          <DeviceList lastSync={status.lastSync} />
          <ChangePassphrase />
        </>
      )}
      <div className="sync-actions">
        {confirmStop ? (
          <>
            <span className="sync-note">{t("sync.stopConfirm")}</span>
            <button className="button" onClick={() => setConfirmStop(false)}>
              {t("dialog.cancel")}
            </button>
            <button
              className="button danger"
              onClick={() => backend.syncDisable().then(onChange, (e) => setNotice(t("error.generic", { message: String(e) })))}
            >
              {t("sync.stop")}
            </button>
          </>
        ) : (
          <button className="button" onClick={() => setConfirmStop(true)}>
            {t("sync.stop")}
          </button>
        )}
      </div>
    </div>
  );
}
