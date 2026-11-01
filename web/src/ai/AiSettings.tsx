import { Check, Pencil, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShell } from "../shell/tabs";
import "./ai.css";
import { chooseProvider, loadAiSettings, PRESETS, removeProvider, saveProvider, setWriteMode, useAiSettings, type AiProvider, type Preset } from "./settings";

type Draft = Omit<AiProvider, "id"> & { id?: string; key: string; keyless?: boolean };

const fromPreset = (p: Preset): Draft => ({ name: p.name, protocol: p.protocol, baseUrl: p.baseUrl, model: p.model, effort: p.effort ?? "", key: "", keyless: p.keyless });

/** Settings → AI: the models the assistant may use, each with its key on
 *  this device, and how its changes to notes are made. */
export function AiSettingsPanel() {
  const { t } = useTranslation();
  const s = useAiSettings();
  const [draft, setDraft] = useState<Draft | null>(null);
  const notice = (text: string) => useShell.getState().setNotice(text);

  useEffect(() => {
    if (!s.loaded) void loadAiSettings();
  }, [s.loaded]);

  const save = async () => {
    if (!draft) return;
    if (!draft.baseUrl.trim() || !draft.model.trim()) return notice(t("ai.setup.incomplete"));
    try {
      // A provider keeps its key unless a new one is typed.
      const { key, keyless: _, ...provider } = draft;
      await saveProvider(provider, key.trim() || null);
      setDraft(null);
    } catch (e) {
      notice(t("error.generic", { message: String(e) }));
    }
  };

  return (
    <div className="ai-settings">
      <h3 className="ai-settings-title">{t("ai.setup.models")}</h3>
      {s.providers.length === 0 && !draft && <p className="ai-settings-hint">{t("ai.setup.none")}</p>}
      <ul className="ai-providers">
        {s.providers.map((p) => (
          <li key={p.id}>
            <label>
              <input type="radio" name="ai-current" checked={s.current === p.id} onChange={() => void chooseProvider(p.id)} />
              <span className="ai-provider-name">{p.name}</span>
              <span className="ai-provider-model">{p.model}</span>
              {s.keys.includes(p.id) ? <span className="ai-provider-key"><Check size={11} /> {t("ai.setup.keySaved")}</span> : <span className="ai-provider-key missing">{t("ai.setup.noKey")}</span>}
            </label>
            <button className="icon-button" title={t("ai.setup.edit")} aria-label={t("ai.setup.edit")} onClick={() => setDraft({ ...p, effort: p.effort ?? "", key: "" })}>
              <Pencil size={13} />
            </button>
            <button className="icon-button" title={t("ai.setup.remove")} aria-label={t("ai.setup.remove")} onClick={() => void removeProvider(p.id)}>
              <Trash2 size={13} />
            </button>
          </li>
        ))}
      </ul>

      {draft ? (
        <div className="ai-form">
          <label>
            <span>{t("ai.setup.name")}</span>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label>
            <span>{t("ai.setup.protocol")}</span>
            <select value={draft.protocol} onChange={(e) => setDraft({ ...draft, protocol: e.target.value as Draft["protocol"] })}>
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai">{t("ai.setup.openaiCompatible")}</option>
            </select>
          </label>
          <label>
            <span>{t("ai.setup.baseUrl")}</span>
            <input value={draft.baseUrl} placeholder="https://…/v1" spellCheck={false} autoCapitalize="off" onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} />
          </label>
          <label>
            <span>{t("ai.setup.model")}</span>
            <input value={draft.model} placeholder={t("ai.setup.modelHint")} spellCheck={false} autoCapitalize="off" onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
          </label>
          <label>
            <span>{t("ai.setup.key")}</span>
            <input
              type="password"
              value={draft.key}
              autoComplete="off"
              placeholder={draft.id && s.keys.includes(draft.id) ? t("ai.setup.keyKeep") : draft.keyless ? t("ai.setup.keyOptional") : ""}
              onChange={(e) => setDraft({ ...draft, key: e.target.value })}
            />
            <small>{t("ai.setup.keyWhere")}</small>
          </label>
          <div className="dialog-actions">
            <button className="button" onClick={() => setDraft(null)}>
              {t("dialog.cancel")}
            </button>
            <button className="button primary" onClick={() => void save()}>
              {t("dialog.save")}
            </button>
          </div>
        </div>
      ) : (
        <div className="ai-presets">
          <span>{t("ai.setup.add")}</span>
          {PRESETS.map((p) => (
            <button key={p.id} className="button" onClick={() => setDraft(fromPreset(p))}>
              {p.name || t("ai.setup.custom")}
            </button>
          ))}
        </div>
      )}

      <h3 className="ai-settings-title">{t("ai.setup.writes")}</h3>
      <div className="ai-writes" role="radiogroup">
        {(["ask", "auto"] as const).map((m) => (
          <label key={m}>
            <input type="radio" name="ai-writes" checked={s.writes === m} onChange={() => void setWriteMode(m)} />
            <span>
              {t(`ai.setup.writeModes.${m}`)}
              <small>{t(`ai.setup.writeHints.${m}`)}</small>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
