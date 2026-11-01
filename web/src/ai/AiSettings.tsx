import { Menu } from "@base-ui/react/menu";
import { Check, ChevronRight, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { backend } from "../platform";
import { useShell } from "../shell/tabs";
import "./ai.css";
import { loadAiSettings, PRESETS, providerModels, refreshModels, removeProvider, saveProvider, useAiSettings, type AiProvider, type Preset } from "./settings";
import type { AiModelInfo } from "./types";

export type Draft = Omit<AiProvider, "id" | "model"> & { id?: string; key: string; keyless?: boolean; custom: boolean };

export const fromPreset = (p: Preset): Draft => ({
  name: p.name,
  protocol: p.protocol,
  baseUrl: p.baseUrl,
  models: [],
  effort: p.effort ?? "",
  key: "",
  keyless: p.keyless,
  custom: !p.baseUrl,
});

/** Settings → AI: the providers the assistant may use, each with one key;
 *  their models come from the provider itself and stay current (as in
 *  Raycast). Which model, how hard it thinks and whether changes are asked
 *  first are chosen where the message is written. */
export function AiSettingsPanel() {
  const { t } = useTranslation();
  const s = useAiSettings();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    if (!s.loaded) void loadAiSettings();
    else void refreshModels(true);
  }, [s.loaded]);

  const form = draft && <ProviderForm draft={draft} hasKey={!!draft.id && s.keys.includes(draft.id)} onChange={setDraft} onDone={() => setDraft(null)} />;

  return (
    <div className="ai-settings">
      <h3 className="ai-settings-title">{t("ai.setup.providers")}</h3>
      {s.providers.length === 0 && !draft && <p className="ai-settings-hint">{t("ai.setup.none")}</p>}
      <ul className="ai-providers">
        {s.providers.map((p) => {
          const models = providerModels(p, s.catalog);
          return draft?.id === p.id ? (
            <li key={p.id} className="editing">
              {form}
            </li>
          ) : (
            <li key={p.id}>
              <div className="ai-provider-main">
                <span className="ai-provider-name">{p.name}</span>
                <span className="ai-provider-models">{models.length ? t("ai.setup.modelCount", { count: models.length }) : t("ai.setup.noModels")}</span>
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
          );
        })}
      </ul>

      {draft && !draft.id ? form : !draft && <AddProvider onPick={(p) => setDraft(fromPreset(p))} />}
    </div>
  );
}

/** "Add a provider", with the common ones to start from. */
export function AddProvider({ onPick }: { onPick: (p: Preset) => void }) {
  const { t } = useTranslation();
  return (
    <Menu.Root>
      <Menu.Trigger className="button ai-add-provider">
        <Plus size={14} /> {t("ai.setup.addProvider")}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="ai-add-positioner" side="bottom" align="start" sideOffset={4}>
          <Menu.Popup className="popup">
            {PRESETS.map((p) => (
              <Menu.Item key={p.id} className="popup-item" onClick={() => onPick(p)}>
                {p.name || t("ai.setup.custom")}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

type Probe = { state: "idle" } | { state: "checking" } | { state: "ok"; models: AiModelInfo[] } | { state: "failed"; message: string };

/** Adding or changing one provider: its key, and a check that the key and
 *  address work, which also fetches the models it offers. A model it does
 *  not list can be added by id. */
export function ProviderForm({ draft, hasKey, onChange, onDone }: { draft: Draft; hasKey: boolean; onChange: (d: Draft) => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [check, setCheck] = useState<Probe>({ state: "idle" });
  const [typed, setTyped] = useState("");
  const [advanced, setAdvanced] = useState(draft.custom);
  const [showAll, setShowAll] = useState(false);
  const run = useRef(0);
  const testing = useRef<Promise<AiModelInfo[] | null> | null>(null);
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });

  const test = (d = draft): Promise<AiModelInfo[] | null> => (testing.current = probe(d));
  const probe = async (d: Draft): Promise<AiModelInfo[] | null> => {
    if (!d.baseUrl.trim()) return (setCheck({ state: "failed", message: t("ai.setup.needBaseUrl") }), null);
    const n = ++run.current;
    setCheck({ state: "checking" });
    try {
      const models = await backend.aiModels({ protocol: d.protocol, baseUrl: d.baseUrl.trim(), key: d.key.trim() || undefined, provider: d.id });
      if (n === run.current) setCheck({ state: "ok", models });
      return models;
    } catch (e) {
      if (n === run.current) setCheck({ state: "failed", message: String(e).replace(/^Error: /, "") });
      return null;
    }
  };

  // What the provider offers is fetched as soon as it can be: a provider
  // being changed that has its key, or a local server that needs none.
  useEffect(() => {
    if ((draft.id && hasKey) || draft.keyless) void test();
  }, []);

  // A key typed or pasted is checked once typing stops, not when the field
  // is left: the result would move the buttons under the pointer.
  useEffect(() => {
    if (!draft.key.trim()) return;
    const timer = setTimeout(() => void test(), 900);
    return () => clearTimeout(timer);
  }, [draft.key]);

  const removeModel = (m: string) => set({ models: draft.models.filter((x) => x !== m) });
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
    // Checked when saved if not before (or the check under way awaited):
    // the models come from there.
    const listed = check.state === "ok" ? check.models : check.state === "checking" && testing.current ? await testing.current : draft.key.trim() || hasKey || draft.keyless ? await test() : null;
    if (!listed?.length && draft.models.length === 0) {
      if (check.state !== "failed") setCheck({ state: "failed", message: t("ai.setup.needModel") });
      return;
    }
    try {
      // A provider keeps its key unless a new one is typed.
      const { key, keyless: _, custom: __, ...provider } = draft;
      await saveProvider(provider, key.trim() || null, listed ?? undefined);
      onDone();
    } catch (e) {
      useShell.getState().setNotice(t("error.generic", { message: String(e) }));
    }
  };

  const listed = check.state === "ok" ? providerModels({ id: "", name: "", protocol: draft.protocol, baseUrl: "", model: "", models: [] }, { "": { at: 0, models: check.models } }) : [];

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
        <div className="ai-check ok">
          <Check size={12} />
          <span>
            {t("ai.setup.testOk", { count: listed.length })}
            {listed.length > 0 && (
              <button type="button" className="chat-link" onClick={() => setShowAll((v) => !v)}>
                {t(showAll ? "ai.setup.hideModels" : "ai.setup.showModels")}
              </button>
            )}
          </span>
        </div>
      )}
      {check.state === "ok" && showAll && <p className="ai-model-preview">{listed.join(" · ")}</p>}
      {check.state === "failed" && <p className="ai-check failed">{check.message}</p>}

      <div className="ai-models">
        <span className="ai-models-label">{t("ai.setup.moreModels")}</span>
        {draft.models.length > 0 && (
          <div className="ai-model-chips">
            {draft.models.map((m) => (
              <span key={m} className="ai-model-chip">
                {m}
                <button type="button" aria-label={t("ai.setup.removeModel", { model: m })} onClick={() => removeModel(m)}>
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
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
