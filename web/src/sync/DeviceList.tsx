import { Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SyncDevice } from "../bindings/commands";
import { backend } from "../platform";
import { ordered, seen, STALE_DAYS } from "./devices";
import { commandErrorText } from "./status";

/** Settings → Sync: the devices of the workspace, when each last synced,
 *  and this device's name (§5.3). Reloaded after each sync. */
export function DeviceList({ lastSync }: { lastSync: number | null }) {
  const { t } = useTranslation();
  const [devices, setDevices] = useState<SyncDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    backend.syncDevices().then(
      (d) => {
        if (gone) return;
        setDevices(ordered(d));
        setError(null);
      },
      (e) => !gone && setError(commandErrorText(t, e)),
    );
    return () => {
      gone = true;
    };
  }, [lastSync]);

  return (
    <section className="sync-devices">
      <h3 className="mcp-subtitle">{t("sync.devices")}</h3>
      <p className="sync-hint">{t("sync.devicesHint")}</p>
      {error && <p className="mcp-error">{t("sync.devicesError", { message: error })}</p>}
      {devices && (
        <ul className="sync-device-list">
          {devices.map((d) => (
            <DeviceRow key={d.id} device={d} onChanged={(d) => setDevices(ordered(d))} />
          ))}
        </ul>
      )}
    </section>
  );
}

function DeviceRow({ device, onChanged }: { device: SyncDevice; onChanged: (d: SyncDevice[]) => void }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [name, setName] = useState(device.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const when = seen(device.lastSeen, Date.now());
  const time = new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(new Date(device.lastSeen));
  const seenText =
    when.kind === "now"
      ? t("sync.seenNow")
      : when.kind === "today"
        ? t("sync.seenToday", { time })
        : when.days === 1
          ? t("sync.seenYesterday")
          : t("sync.seenDays", { count: when.days });
  const stale = when.kind === "days" && when.stale;

  function save() {
    backend.syncRenameDevice(name).then(
      (d) => {
        setEditing(false);
        setError(null);
        onChanged(d);
      },
      (e) => setError(commandErrorText(t, e)),
    );
  }

  function remove() {
    backend.syncRemoveDevice(device.id).then(onChanged, (e) => setError(commandErrorText(t, e)));
  }

  return (
    <li className={`sync-device${stale ? " stale" : ""}`}>
      {editing ? (
        <form
          className="sync-device-rename"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setEditing(false))}
            maxLength={64}
            autoFocus
            onFocus={(e) => e.target.select()}
            spellCheck={false}
            aria-label={t("sync.rename")}
          />
          <button type="button" className="button" onClick={() => setEditing(false)}>
            {t("dialog.cancel")}
          </button>
          <button type="submit" className="button primary">
            {t("sync.renameSave")}
          </button>
        </form>
      ) : (
        <div className="sync-device-head">
          <span className="sync-device-name">{device.name ?? t("sync.unnamed")}</span>
          {device.thisDevice && <span className="mcp-state">{t("sync.thisDevice")}</span>}
          {device.thisDevice && (
            <button
              className="icon-button"
              title={t("sync.rename")}
              aria-label={t("sync.rename")}
              onClick={() => {
                setName(device.name ?? "");
                setEditing(true);
              }}
            >
              <Pencil size={13} />
            </button>
          )}
          {!device.thisDevice && !confirmRemove && (
            <button className="button sync-device-remove" onClick={() => setConfirmRemove(true)}>
              {t("sync.removeDevice")}
            </button>
          )}
        </div>
      )}
      <span className="sync-device-seen">{seenText}</span>
      {stale && <span className="sync-device-stale">{t("sync.stale", { days: STALE_DAYS })}</span>}
      {confirmRemove && (
        <div className="sync-device-confirm">
          <p className="sync-note">{t("sync.removeConfirm")}</p>
          <div className="sync-actions">
            <button className="button" onClick={() => setConfirmRemove(false)}>
              {t("dialog.cancel")}
            </button>
            <button className="button danger" onClick={remove}>
              {t("sync.removeDevice")}
            </button>
          </div>
        </div>
      )}
      {error && <p className="mcp-error">{error}</p>}
    </li>
  );
}
