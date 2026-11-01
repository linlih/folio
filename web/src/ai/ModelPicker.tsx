import { Menu } from "@base-ui/react/menu";
import { Check, ChevronDown, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { chooseProvider, saveProvider, useAiSettings, type AiProvider } from "./settings";

/** How hard the model may think, as each protocol names it: Anthropic's
 *  effort, or OpenAI's reasoning_effort. */
const EFFORTS: Record<AiProvider["protocol"], string[]> = {
  anthropic: ["low", "medium", "high", "xhigh", "max"],
  openai: ["low", "medium", "high"],
};

/** The model a conversation uses and how hard it thinks, chosen where the
 *  message is written (as in Claude's and ChatGPT's apps); the next turn
 *  uses it. */
export function ModelPicker({ onManage }: { onManage: () => void }) {
  const { t } = useTranslation();
  const { providers, current } = useAiSettings();
  const provider = providers.find((p) => p.id === current) ?? providers[0];
  if (!provider) return null;
  const effort = provider.effort ?? "";
  const levels = EFFORTS[provider.protocol];
  const label = (e: string) => t(e ? `ai.effort.${e}` : "ai.effort.default");
  const hint = (e: string) => (e === "" ? "default" : e === "low" ? "low" : e === levels.at(-1) ? "deepest" : null);
  const setEffort = (e: string) => void saveProvider({ ...provider, effort: e }, null);

  return (
    <Menu.Root>
      <Menu.Trigger className="chat-model" aria-label={t("ai.model")}>
        <span className="chat-model-name">{provider.name}</span>
        {effort && <span className="chat-model-effort">{label(effort)}</span>}
        <ChevronDown size={12} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="chat-model-positioner" side="top" align="start" sideOffset={6}>
          <Menu.Popup className="popup chat-model-menu">
            <div className="popup-label">{t("ai.model")}</div>
            {providers.map((p) => (
              <Menu.Item key={p.id} className="popup-item chat-model-item" onClick={() => void chooseProvider(p.id)}>
                <span>
                  {p.name}
                  {p.model && p.model !== p.name && <small>{p.model}</small>}
                </span>
                {p.id === provider.id && <Check size={13} className="check" />}
              </Menu.Item>
            ))}
            <div className="popup-separator" />
            <div className="popup-label">{t("ai.effort.label")}</div>
            {["", ...levels].map((e) => (
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
