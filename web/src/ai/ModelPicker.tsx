// What the next turn uses, chosen where the message is written (as in the
// Claude and ChatGPT apps): the model, how hard it thinks, and whether its
// changes to notes are asked first (as Claude's permission mode is).

import { Menu } from "@base-ui/react/menu";
import { Brain, Check, ChevronDown, Hand, Search, Settings, Zap } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { effortLevels } from "./effort";
import { chooseProvider, modelInfo, providerModels, refreshModels, saveProvider, setWriteMode, useAiSettings, type AiProvider } from "./settings";

/** The provider and model chats use now. */
function useCurrent(): { provider: AiProvider; model: string } | null {
  const { providers, current, model, catalog } = useAiSettings();
  const provider = providers.find((p) => p.id === current) ?? providers[0];
  if (!provider) return null;
  return { provider, model: model ?? providerModels(provider, catalog)[0] ?? provider.model };
}

/** A menu that lists every provider's models, as each provider lists them
 *  (kept current), with a search when there are many. */
export function ModelPicker({ onManage }: { onManage: () => void }) {
  const { t } = useTranslation();
  const { providers, catalog } = useAiSettings();
  const [query, setQuery] = useState("");
  const now = useCurrent();
  if (!now) return null;
  const lists = providers.map((p) => ({ p, models: providerModels(p, catalog) }));
  const total = lists.reduce((n, l) => n + l.models.length, 0);
  const q = query.trim().toLowerCase();

  return (
    <Menu.Root onOpenChange={(open) => (open ? void refreshModels() : setQuery(""))}>
      <Menu.Trigger className="chat-model" aria-label={t("ai.model")} title={now.provider.name}>
        <span className="chat-model-name">{now.model || now.provider.name}</span>
        <ChevronDown size={12} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="chat-model-positioner" side="top" align="start" sideOffset={6}>
          <Menu.Popup className="popup chat-model-menu">
            {total > 10 && (
              <label className="chat-model-search">
                <Search size={13} />
                <input
                  value={query}
                  placeholder={t("ai.searchModels")}
                  spellCheck={false}
                  autoCapitalize="off"
                  onChange={(e) => setQuery(e.target.value)}
                  // Typing is for the search, not the menu's own type-to-find.
                  onKeyDown={(e) => e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Escape" && e.stopPropagation()}
                />
              </label>
            )}
            {lists.map(({ p, models }) => {
              const shown = q ? models.filter((m) => m.toLowerCase().includes(q)) : models;
              if (q && shown.length === 0) return null;
              return (
                <Menu.Group key={p.id}>
                  <Menu.GroupLabel className="popup-label">{p.name}</Menu.GroupLabel>
                  {shown.length === 0 && <div className="chat-model-none">{t("ai.noModelsYet")}</div>}
                  {shown.map((m) => (
                    <Menu.Item key={m} className="popup-item chat-model-item" onClick={() => void chooseProvider(p.id, m)}>
                      <span className="chat-model-id">{m}</span>
                      {p.id === now.provider.id && m === now.model && <Check size={13} className="check" />}
                    </Menu.Item>
                  ))}
                </Menu.Group>
              );
            })}
            <div className="popup-separator" />
            <Menu.Item className="popup-item" onClick={onManage}>
              <Settings size={13} /> {t("ai.manageProviders")}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** How hard the model thinks, for models that take it: the levels the
 *  provider says it takes (or known for it). Kept per provider. */
export function EffortPicker() {
  const { t } = useTranslation();
  useAiSettings((s) => s.catalog);
  const now = useCurrent();
  if (!now) return null;
  const { provider, model } = now;
  const levels = effortLevels(provider.protocol, model, modelInfo(provider.id, model)?.efforts);
  if (levels.length === 0) return null;
  // A level kept for another of the provider's models is not shown or sent.
  const effort = levels.includes(provider.effort ?? "") ? provider.effort! : "";
  const label = (e: string) => t(e ? `ai.effort.${e}` : "ai.effort.default");
  const hint = (e: string) => (e === "" ? "default" : e === "low" ? "low" : e === levels.at(-1) ? "deepest" : null);

  return (
    <Menu.Root>
      <Menu.Trigger className="chat-model chat-chip" aria-label={t("ai.effort.label")} title={t("ai.effort.label")}>
        <Brain size={13} />
        <span>{label(effort)}</span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="chat-model-positioner" side="top" align="start" sideOffset={6}>
          <Menu.Popup className="popup chat-model-menu">
            <div className="popup-label">{t("ai.effort.label")}</div>
            {["", ...levels].map((e) => (
              <Menu.Item key={e || "default"} className="popup-item chat-model-item" onClick={() => void saveProvider({ ...provider, effort: e }, null)}>
                <span className="chat-model-option">
                  {label(e)}
                  {hint(e) && <small>{t(`ai.effort.hints.${hint(e)}`)}</small>}
                </span>
                {e === effort && <Check size={13} className="check" />}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** Whether the assistant's changes to notes are shown first or made at
 *  once, switched where the message is written (as Claude's permission
 *  mode is); shared by the workspace's devices. */
export function WriteModePicker() {
  const { t } = useTranslation();
  const writes = useAiSettings((s) => s.writes);
  const Icon = writes === "auto" ? Zap : Hand;
  return (
    <Menu.Root>
      <Menu.Trigger className={`chat-model chat-chip${writes === "auto" ? " auto" : ""}`} aria-label={t("ai.setup.writes")} title={t("ai.setup.writes")}>
        <Icon size={13} />
        <span>{t(`ai.writeShort.${writes}`)}</span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="chat-model-positioner" side="top" align="start" sideOffset={6}>
          <Menu.Popup className="popup chat-model-menu">
            <div className="popup-label">{t("ai.setup.writes")}</div>
            {(["ask", "auto"] as const).map((m) => (
              <Menu.Item key={m} className="popup-item chat-model-item" onClick={() => void setWriteMode(m)}>
                <span className="chat-model-option">
                  {t(`ai.setup.writeModes.${m}`)}
                  <small>{t(`ai.setup.writeHints.${m}`)}</small>
                </span>
                {m === writes && <Check size={13} className="check" />}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
