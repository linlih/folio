import { Check, ChevronRight, Pencil, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { backend } from "../platform";
import { useShell } from "../shell/tabs";
import "./ai.css";
import { loadAiSettings, PRESETS, removeProvider, saveProvider, setWriteMode, useAiSettings, type AiProvider, type Preset } from "./settings";

type Draft = Omit<AiProvider, "id" | "model"> & { id?: string; key: string; keyless?: boolean; custom: boolean };

const fromPreset = (p: Preset): Draft => ({
  name: p.name,
  protocol: p.protocol,
  baseUrl: p.baseUrl,
  models: p.model ? [p.model] : [],
  effort: p.effort ?? "",
  key: "",
  keyless: p.keyless,
  custom: !p.baseUrl,
});

/** Settings → AI: the providers the assistant may use, each with one key
 *  and the models picked from what it offers (as Cherry Studio and Raycast
 *  do), and how its changes to notes are made. Which model a chat uses is
 *  chosen where the message is written (ModelPicker). */
export function AiSettingsPanel() {
  const { t } = useTranslation();
  const s = useAiSettings();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    if (!s.loaded) void loadAiSettings();
  }, [s.loaded]);

  const form = draft && <ProviderForm draft={draft} hasKey={!!draft.id && s.keys.includes(draft.id)} onChange={setDraft} onDone={() => setDraft(null)} />;

  return (
    <div className="ai-settings">
      <h3 className="ai-settings-title">{t("ai.setup.models")}</h3>
      {s.providers.length === 0 && !draft && <p className="ai-settings-hint">{t("ai.setup.none")}</p>}
      <ul className="ai-providers">
        {s.providers.map((p) =>
          draft?.id === p.id ? (
            <li key={p.id} className="editing">
              {form}
            </li>
          ) : (
            <li key={p.id}>
              <div className="ai-provider-main">
                <span className="ai-provider-name">{p.name}</span>
                <span className="ai-provider-models">{p.models.join(" · ") || t("ai.setup.noModels")}</span>
              </div>
              {s.keys.includes(p.id) ? (
                <span className="ai-provider-key">
                  <Check size={11} /> {t("ai.setup.keySaved")}
                </span>
              ) : (
                <span className="ai-provider-key missing">{t("ai.setup.noKey")}</span>
              )}
              <button className="icon-button" title={t("ai.setup.edit")} aria-label={t("ai.setup.edit")} onClick={() => setDraft({ ...p, effort: p.effort ?? "", key: "", custom: true })}>
                <Pencil size={13} />
              </button>
              {removing === p.id ? (
                <button className="button danger ai-confirm-remove" onBlur={() => setRemoving(null)} autoFocus onClick={() => (setRemoving(null), void removeProvider(p.id))}>
                  {t("ai.setup.confirmRemove")}
                </button>
              ) : (
                <button className="icon-button" title={t("ai.setup.remove")} aria-label={t("ai.setup.remove")} onClick={() => setRemoving(p.id)}>
                  <Trash2 size={13} />
                </button>
              )}
            </li>
          ),
        )}
      </ul>

      {draft && !draft.id
        ? form
        : !draft && (
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

type Probe = { state: "idle" } | { state: "checking" } | { state: "ok"; models: string[] } | { state: "failed"; message: string };

/** Adding or changing one provider: its key, a check that the key and
 *  address work (which also lists its models), and the models to use. */
function ProviderForm({ draft, hasKey, onChange, onDone }: { draft: Draft; hasKey: boolean; onChange: (d: Draft) => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [check, setCheck] = useState<Probe>({ state: "idle" });
  const [filter, setFilter] = useState("");
  const [typed, setTyped] = useState("");
  const [advanced, setAdvanced] = useState(draft.custom);
  const run = useRef(0);
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });

  const test = async (d = draft) => {
    if (!d.baseUrl.trim()) return setCheck({ state: "failed", message: t("ai.setup.needBaseUrl") });
    const n = ++run.current;
    setCheck({ state: "checking" });
    try {
      const models = await backend.aiModels({ protocol: d.protocol, baseUrl: d.baseUrl.trim(), key: d.key.trim() || undefined, provider: d.id });
      if (n === run.current) setCheck({ state: "ok", models });
    } catch (e) {
      if (n === run.current) setCheck({ state: "failed", message: String(e).replace(/^Error: /, "") });
    }
  };

  // A provider being changed, with its key: what it offers is shown at once.
  useEffect(() => {
    if (draft.id && hasKey) void test();
  }, []);

  const toggle = (m: string) => set({ models: draft.models.includes(m) ? draft.models.filter((x) => x !== m) : [...draft.models, m] });
  const addTyped = () => {
    const m = typed.trim();
    if (m && !draft.models.includes(m)) set({ models: [...draft.models, m] });
    setTyped("");
  };
  const onTypedKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      addTyped();
    }
  };

  const save = async () => {
    if (!draft.baseUrl.trim()) return setCheck({ state: "failed", message: t("ai.setup.needBaseUrl") });
    if (draft.models.length === 0) return setCheck({ state: "failed", message: t("ai.setup.needModel") });
    try {
      // A provider keeps its key unless a new one is typed.
      const { key, keyless: _, custom: __, ...provider } = draft;
      await saveProvider(provider, key.trim() || null);
      onDone();
    } catch (e) {
      useShell.getState().setNotice(t("error.generic", { message: String(e) }));
    }
  };

  const offered = check.state === "ok" ? check.models.filter((m) => m.toLowerCase().includes(filter.trim().toLowerCase())) : [];

  return (
    <div className="ai-form">
      <label>
        <span>{t("ai.setup.name")}</span>
        <input value={draft.name} onChange={(e) => set({ name: e.target.value })} />
      </label>

      {!draft.custom && (
        <button type="button" className="ai-advanced" aria-expanded={advanced} onClick={() => setAdvanced((a) => !a)}>
          <ChevronRight size={12} /> {t("ai.setup.advanced")}
        </button>
      )}
      {advanced && (
        <>
          <label>
            <span>{t("ai.setup.protocol")}</span>
            <select value={draft.protocol} onChange={(e) => set({ protocol: e.target.value as Draft["protocol"] })}>
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai">{t("ai.setup.openaiCompatible")}</option>
            </select>
          </label>
          <label>
            <span>{t("ai.setup.baseUrl")}</span>
            <input value={draft.baseUrl} placeholder="https://…/v1" spellCheck={false} autoCapitalize="off" onChange={(e) => set({ baseUrl: e.target.value })} />
          </label>
        </>
      )}

      <label>
        <span>{t("ai.setup.key")}</span>
        <div className="ai-key-row">
          <input
            type="password"
            value={draft.key}
            autoComplete="off"
            placeholder={hasKey ? t("ai.setup.keyKeep") : draft.keyless ? t("ai.setup.keyOptional") : ""}
            onChange={(e) => set({ key: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && void test()}
          />
          <button type="button" className="button" disabled={check.state === "checking"} onClick={() => void test()}>
            {t(check.state === "checking" ? "ai.setup.testing" : "ai.setup.test")}
          </button>
        </div>
        <small>{t("ai.setup.keyWhere")}</small>
      </label>
      {check.state === "ok" && (
        <p className="ai-check ok">
          <Check size={12} /> {t("ai.setup.testOk", { count: check.models.length })}
        </p>
      )}
      {check.state === "failed" && <p className="ai-check failed">{check.message}</p>}

      <div className="ai-models">
        <span className="ai-models-label">{t("ai.setup.model")}</span>
        {draft.models.length > 0 ? (
          <div className="ai-model-chips">
            {draft.models.map((m) => (
              <span key={m} className="ai-model-chip">
                {m}
                <button type="button" aria-label={t("ai.setup.removeModel", { model: m })} onClick={() => toggle(m)}>
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <small>{t(check.state === "ok" ? "ai.setup.pickModels" : "ai.setup.testFirst")}</small>
        )}
        {check.state === "ok" && check.models.length > 0 && (
          <>
            {check.models.length > 8 && <input className="ai-model-filter" value={filter} placeholder={t("ai.setup.filterModels")} spellCheck={false} autoCapitalize="off" onChange={(e) => setFilter(e.target.value)} />}
            <ul className="ai-model-list">
              {offered.map((m) => (
                <li key={m}>
                  <label>
                    <input type="checkbox" checked={draft.models.includes(m)} onChange={() => toggle(m)} />
                    <span>{m}</span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
        <input className="ai-model-typed" value={typed} placeholder={t("ai.setup.typeModel")} spellCheck={false} autoCapitalize="off" onChange={(e) => setTyped(e.target.value)} onKeyDown={onTypedKey} onBlur={addTyped} />
      </div>

      <div className="dialog-actions">
        <button className="button" onClick={onDone}>
          {t("dialog.cancel")}
        </button>
        <button className="button primary" onClick={() => void save()}>
          {t("dialog.save")}
        </button>
      </div>
    </div>
  );
}
