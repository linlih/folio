import { Menu } from "@base-ui/react/menu";
import { Check, ChevronDown, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { effortLevels } from "./effort";
import { chooseProvider, saveProvider, useAiSettings } from "./settings";


/** The model a conversation uses and how hard it thinks, chosen where the
 *  message is written (as in Claude's and ChatGPT's apps); the next turn
 *  uses it. */
export function ModelPicker({ onManage }: { onManage: () => void }) {
  const { t } = useTranslation();
  const { providers, current, model } = useAiSettings();
  const provider = providers.find((p) => p.id === current) ?? providers[0];
  if (!provider) return null;
  const chosen = model ?? provider.models[0] ?? "";
  const levels = effortLevels(provider.protocol, chosen);
  // A level kept for another of the provider's models is not shown or sent.
  const effort = levels.includes(provider.effort ?? "") ? provider.effort! : "";
  const label = (e: string) => t(e ? `ai.effort.${e}` : "ai.effort.default");
  const hint = (e: string) => (e === "" ? "default" : e === "low" ? "low" : e === levels.at(-1) ? "deepest" : null);
  const setEffort = (e: string) => void saveProvider({ ...provider, effort: e }, null);

  return (
    <Menu.Root>
      <Menu.Trigger className="chat-model" aria-label={t("ai.model")}>
        <span className="chat-model-name">{chosen || provider.name}</span>
        {effort && <span className="chat-model-effort">{label(effort)}</span>}
        <ChevronDown size={12} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="chat-model-positioner" side="top" align="start" sideOffset={6}>
          <Menu.Popup className="popup chat-model-menu">
            {/* By provider, as Raycast's and Cherry Studio's pickers group them. */}
            {providers.map((p) => (
              <Menu.Group key={p.id}>
                <Menu.GroupLabel className="popup-label">{p.name}</Menu.GroupLabel>
                {p.models.map((m) => (
                  <Menu.Item key={m} className="popup-item chat-model-item" onClick={() => void chooseProvider(p.id, m)}>
                    <span className="chat-model-id">{m}</span>
                    {p.id === provider.id && m === chosen && <Check size={13} className="check" />}
                  </Menu.Item>
                ))}
              </Menu.Group>
            ))}
            {levels.length > 0 && <div className="popup-separator" />}
            {levels.length > 0 && <div className="popup-label">{t("ai.effort.label")}</div>}
            {levels.length > 0 && ["", ...levels].map((e) => (
              <Menu.Item key={e || "default"} className="popup-item chat-model-item" closeOnClick={false} onClick={() => setEffort(e)}>
                <span>
                  {label(e)}
                  {hint(e) && <small>{t(`ai.effort.hints.${hint(e)}`)}</small>}
                </span>
                {e === effort && <Check size={13} className="check" />}
              </Menu.Item>
            ))}
            <div className="popup-separator" />
            <Menu.Item className="popup-item" onClick={onManage}>
              <Settings size={13} /> {t("ai.manageModels")}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
