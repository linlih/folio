import {
  Cloud,
  Copy,
  FolderInput,
  FolderOpen,
  HardDrive,
  Lock,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { docs } from "../app";
import type {
  BackupCopyStatus,
  CopySuggestion,
  PickedCopyFolder,
  SyncStatus,
} from "../bindings/commands";
import { backend } from "../platform";
import { useShell } from "../shell/tabs";
import { MIN_PASSPHRASE, useSyncStatus } from "../sync/status";
import { desktopApp, size, useWhen } from "./BackupDialogs";
import "../sync/sync.css";

type Translate = (key: string, options?: Record<string, unknown>) => string;
type Line = { text: string; warn?: boolean };

/** What the copy's row says under its path, in order: what is happening
 *  (or what is wrong), how the last copy went, then standing warnings. */
export function copyStatusLines(
  s: BackupCopyStatus,
  t: Translate,
  when: (ms: number) => string,
): Line[] {
  const lines: Line[] = [];
  if (!s.path) return lines;
  if (s.running) lines.push({ text: t("backup.copy.running") });
  else if (!s.available)
    lines.push({ text: t("backup.copy.unavailable"), warn: true });
  else if (s.owner === "other")
    lines.push({ text: t("backup.copy.foreign"), warn: true });
  else if (s.locked) lines.push({ text: t("backup.copy.locked"), warn: true });
  else if (s.lastError === "mode")
    lines.push({ text: t("backup.copy.mode"), warn: true });
  else if (
    s.lastError &&
    !["unavailable", "foreign", "locked"].includes(s.lastError)
  )
    lines.push({
      text: t("backup.copy.failed", { message: s.lastError }),
      warn: true,
    });
  if (!s.running && s.owner !== "other") {
    if (s.lastOk && s.size)
      lines.push({
        text: t("backup.copy.done", {
          when: when(s.lastOk),
          backups: s.size.backups,
          files: s.size.files,
          size: size(s.size.bytes),
        }),
      });
    else if (s.lastOk)
      lines.push({ text: t("backup.copy.doneAt", { when: when(s.lastOk) }) });
    else if (s.available && !s.locked)
      lines.push({ text: t("backup.copy.never") });
  }
  if (s.skippedFiles > 0)
    lines.push({
      text: t("backup.copy.skipped", { count: s.skippedFiles }),
      warn: true,
    });
  if (s.sameDisk) lines.push({ text: t("backup.copy.sameDisk"), warn: true });
  return lines;
}

/** Where the library has a copy off this computer: the sync server (its
 *  whole library, end-to-end encrypted), the copy elsewhere, or nowhere. */
export function offsiteLines(
  sync: SyncStatus | null | undefined,
  copy: BackupCopyStatus | null,
  t: Translate,
  when: (ms: number) => string,
): Line[] {
  if (sync === undefined) return []; // not known yet
  const lines: Line[] = [];
  if (sync?.enabled) {
    if (sync.error)
      lines.push({ text: t("backup.offsite.syncFailing"), warn: true });
    else if (sync.lastSync)
      lines.push({
        text: t("backup.offsite.sync", { when: when(sync.lastSync) }),
      });
    else lines.push({ text: t("backup.offsite.syncNever"), warn: true });
    if (sync.pending > 0 || sync.filesUp > 0)
      lines.push({ text: t("backup.offsite.syncPending") });
    lines.push({ text: t("backup.offsite.syncNote") });
  }
  const copyMade = !!copy?.path && copy.owner !== "other";
  if (!sync?.enabled && !copyMade)
    lines.push({ text: t("backup.offsite.none"), warn: true });
  return lines;
}

/** The copy's status, polled while a copy runs. */
export function useCopyStatus(): BackupCopyStatus | null {
  const [status, setStatus] = useState<BackupCopyStatus | null>(null);
  useEffect(() => {
    if (backend.kind !== "tauri") return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () =>
      backend.backupCopyStatus().then(
        (s) => {
          if (!alive) return;
          setStatus(s);
          // A copy just asked for may start a moment later: look again soon.
          timer = setTimeout(poll, s.running ? 1500 : 10_000);
        },
        () => {},
      );
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);
  return status;
}

/** Top of Settings → Backup: whether the notes would survive losing this
 *  computer. Sync already keeps an encrypted copy on the server. */
export function OffsiteSummary({ copy }: { copy: BackupCopyStatus | null }) {
  const { t } = useTranslation();
  const when = useWhen();
  const [sync] = useSyncStatus();
  const lines = offsiteLines(sync, copy, t, when);
  if (!lines.length) return null;
  const openSync = () =>
    useShell.getState().setDialog({ kind: "settings", section: "sync" });
  return (
    <div className="settings-row backup-offsite">
      <div className="settings-row-label">
        <span>{t("backup.offsite.title")}</span>
        {lines.map((l, i) => (
          <small key={i} className={l.warn ? "place-warning" : undefined}>
            {l.text}
          </small>
        ))}
      </div>
      {!sync?.enabled && sync !== null && (
        <div className="settings-row-control">
          <button className="button" onClick={openSync}>
            <Cloud size={14} />
            {t("backup.offsite.turnOnSync")}
          </button>
        </div>
      )}
    </div>
  );
}

/** A host error in the interface's language. */
function errorText(t: Translate, e: unknown): string {
  // The host's codes come as the whole message.
  const m = String(e).replace(/^Error: /, "");
  if (m === "wrong-passphrase") return t("backup.copy.wrongPassphrase");
  if (m === "passphrase-short")
    return t("sync.passphraseShort", { n: MIN_PASSPHRASE });
  if (m === "locked") return t("backup.copy.locked");
  if (m === "mode") return t("backup.copy.mode");
  return t("error.generic", { message: m });
}

/** Settings → Backup: a second copy of the backups and of every image and
 *  attachment in another folder: a cloud drive, a drive or a NAS (§5.4).
 *  Suggested places are one click; nothing is saved until the user has read
 *  what the folder holds and chosen whether to encrypt. */
export function BackupCopyRow({
  status: polled,
}: {
  status: BackupCopyStatus | null;
}) {
  const { t } = useTranslation();
  const when = useWhen();
  const setNotice = useShell((s) => s.setNotice);
  const [status, setStatus] = useState<BackupCopyStatus | null>(polled);
  const [suggested, setSuggested] = useState<CopySuggestion[]>([]);
  const [picked, setPicked] = useState<
    (PickedCopyFolder & { label?: string }) | null
  >(null);
  useEffect(() => setStatus(polled), [polled]);
  const refresh = useCallback(
    () => void backend.backupCopyStatus().then(setStatus, () => {}),
    [],
  );
  const fail = (e: unknown) => setNotice(errorText(t, e));
  const s = status;

  useEffect(() => {
    if (!desktopApp() || s?.path) return;
    void backend.backupCopySuggestions().then(setSuggested, () => {});
  }, [s?.path]);

  const pick = async () => {
    try {
      const p = await backend.pickBackupCopyFolder();
      if (p) setPicked(p);
    } catch (e) {
      fail(e);
    }
  };
  const choose = async (g: CopySuggestion) => {
    try {
      setPicked({
        ...(await backend.inspectBackupCopyFolder(g.path)),
        label: suggestionLabel(t, g),
      });
    } catch (e) {
      fail(e);
    }
  };
  const used = () => {
    setPicked(null);
    refresh();
    // The copy starts in the background; show it running.
    setTimeout(refresh, 300);
  };
  const stop = async () => {
    try {
      await backend.stopBackupCopy();
      setNotice(t("backup.copy.stopped"));
      refresh();
    } catch (e) {
      fail(e);
    }
  };
  const copyNow = async () => {
    try {
      await docs().flushAll();
      await backend.copyBackupsNow();
      setTimeout(refresh, 300);
    } catch (e) {
      fail(e);
    }
  };

  const lines = s ? copyStatusLines(s, t, when) : [];

  return (
    <div className="settings-row place-row backup-copy">
      <div className="settings-row-label">
        <span>
          {t("backup.copy.title")}
          {s?.path && s.encrypted && (
            <span className="backup-badge">
              <Lock size={11} />
              {t("backup.copy.encrypted")}
            </span>
          )}
        </span>
        {s?.path ? (
          <code
            className="settings-value place-path"
            title={s.copyPath ?? s.path}
          >
            {s.copyPath ?? s.path}
          </code>
        ) : (
          <small>{t("backup.copy.hint")}</small>
        )}
        {lines.map((l, i) => (
          <small key={i} className={l.warn ? "place-warning" : undefined}>
            {l.text}
          </small>
        ))}
      </div>
      {s?.path && (
        <div className="settings-row-control place-actions">
          {s.available && s.owner !== "other" && !s.locked && (
            <button
              className="button"
              disabled={s.running}
              onClick={() => void copyNow()}
            >
              <Copy size={14} />
              {t("backup.copy.now")}
            </button>
          )}
          {s.available && (
            <button
              className="button"
              onClick={() => void backend.revealBackupCopy()}
            >
              <FolderOpen size={14} />
              {t("backup.reveal")}
            </button>
          )}
          <button className="button" onClick={() => void pick()}>
            <FolderInput size={14} />
            {t("backup.copy.change")}
          </button>
          <button className="button" onClick={() => void stop()}>
            {t("backup.copy.stop")}
          </button>
        </div>
      )}
      {!s?.path && !picked && (
        <div className="backup-places">
          {suggested.map((g) => (
            <button
              key={g.path}
              className="button"
              title={g.path}
              onClick={() => void choose(g)}
            >
              {g.cloud ? <Cloud size={14} /> : <HardDrive size={14} />}
              {suggestionLabel(t, g)}
            </button>
          ))}
          <button className="button" onClick={() => void pick()}>
            <FolderInput size={14} />
            {t(
              suggested.length
                ? "backup.copy.chooseOther"
                : "backup.copy.choose",
            )}
          </button>
        </div>
      )}
      {s?.path && s.locked && s.available && !picked && (
        <Unlock onDone={used} />
      )}
      {picked && (
        <ConfirmPlace
          picked={picked}
          onCancel={() => setPicked(null)}
          onDone={used}
        />
      )}
    </div>
  );
}

function suggestionLabel(t: Translate, g: CopySuggestion): string {
  if (g.kind === "icloud") return t("backup.copy.icloud");
  if (g.kind === "drive") return t("backup.copy.drive", { name: g.label });
  return g.label;
}

/** What a picked folder holds, and for a new copy whether to encrypt it:
 *  by default yes in a cloud drive (someone else's computer), no on a drive
 *  of one's own; the user decides. */
function ConfirmPlace({
  picked,
  onCancel,
  onDone,
}: {
  picked: PickedCopyFolder & { label?: string };
  onCancel: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const isNew = picked.encrypted === null && picked.owner === "none";
  const [encrypt, setEncrypt] = useState(
    isNew ? picked.cloudSynced : !!picked.encrypted,
  );
  const [passphrase, setPassphrase] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const where = picked.label
    ? t("backup.copy.named", { label: picked.label, path: picked.path })
    : picked.path;
  const text =
    picked.owner === "ours"
      ? t("backup.copy.pickOurs", { path: where })
      : picked.owner === "other"
        ? t("backup.copy.pickOther", { path: where })
        : t("backup.copy.pickNew", { path: where });
  const needsPassphrase = isNew ? encrypt : !!picked.encrypted;
  const short =
    isNew &&
    encrypt &&
    passphrase.length > 0 &&
    passphrase.length < MIN_PASSPHRASE;
  const mismatch = isNew && encrypt && again.length > 0 && again !== passphrase;
  const ready =
    !needsPassphrase ||
    (isNew
      ? passphrase.length >= MIN_PASSPHRASE && again === passphrase
      : passphrase.length > 0);

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await backend.setBackupCopy(
        picked.path,
        isNew ? encrypt : !!picked.encrypted,
        needsPassphrase ? passphrase : null,
      );
      onDone();
    } catch (e) {
      setError(errorText(t, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="place-confirm"
      role="alertdialog"
      aria-label={t("backup.copy.title")}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p>{text}</p>
      {picked.sameDisk && (
        <p className="place-warning">{t("backup.copy.sameDisk")}</p>
      )}
      {isNew && (
        <>
          <div
            className="segmented backup-encrypt"
            role="radiogroup"
            aria-label={t("backup.copy.encryptTitle")}
          >
            {([true, false] as const).map((v) => (
              <button
                key={String(v)}
                type="button"
                role="radio"
                aria-checked={encrypt === v}
                className={encrypt === v ? "on" : undefined}
                onClick={() => setEncrypt(v)}
              >
                {t(v ? "backup.copy.encryptYes" : "backup.copy.encryptNo")}
              </button>
            ))}
          </div>
          <p className="backup-encrypt-hint">
            {t(
              encrypt
                ? "backup.copy.encryptYesHint"
                : picked.cloudSynced
                  ? "backup.copy.encryptNoCloud"
                  : "backup.copy.encryptNoHint",
            )}
          </p>
        </>
      )}
      {!isNew && picked.encrypted && <p>{t("backup.copy.enterPassphrase")}</p>}
      {needsPassphrase && (
        <>
          <label className="sync-field">
            <span>{t("backup.copy.passphrase")}</span>
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              autoComplete={isNew ? "new-password" : "current-password"}
              autoFocus
            />
          </label>
          {isNew && (
            <label className="sync-field">
              <span>{t("sync.passphraseAgain")}</span>
              <input
                type="password"
                value={again}
                onChange={(e) => setAgain(e.target.value)}
                autoComplete="new-password"
              />
            </label>
          )}
          {short && (
            <p className="sync-note">
              {t("sync.passphraseShort", { n: MIN_PASSPHRASE })}
            </p>
          )}
          {mismatch && (
            <p className="sync-note">{t("sync.passphraseMismatch")}</p>
          )}
          {isNew && (
            <p className="place-warning">{t("backup.copy.forgotten")}</p>
          )}
        </>
      )}
      {error && <p className="place-warning">{error}</p>}
      <div className="place-confirm-actions">
        <button type="button" className="button" onClick={onCancel}>
          {t("dialog.cancel")}
        </button>
        <button
          type="submit"
          className="button primary"
          disabled={!ready || busy}
        >
          {busy
            ? t("sync.working")
            : t(
                picked.owner === "other"
                  ? "backup.copy.useToRestore"
                  : picked.owner === "ours"
                    ? "backup.copy.use"
                    : "backup.copy.start",
              )}
        </button>
      </div>
    </form>
  );
}

/** An encrypted copy this computer has no key for (made on another computer,
 *  or the keychain was reset): its passphrase lets copying go on. */
function Unlock({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!passphrase || busy) return;
    setBusy(true);
    setError(null);
    try {
      await backend.unlockBackupCopy(passphrase);
      onDone();
    } catch (e) {
      setError(errorText(t, e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="place-confirm"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="sync-field">
        <span>{t("backup.copy.passphrase")}</span>
        <input
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          autoComplete="current-password"
        />
      </label>
      {error && <p className="place-warning">{error}</p>}
      <div className="place-confirm-actions">
        <button
          type="submit"
          className="button primary"
          disabled={!passphrase || busy}
        >
          {busy ? t("sync.working") : t("backup.copy.unlock")}
        </button>
      </div>
    </form>
  );
}
