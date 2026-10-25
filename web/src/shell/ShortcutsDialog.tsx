import { useTranslation } from "react-i18next";
import { DialogFrame } from "./Dialog";
import { keyLabel, SHORTCUT_GROUPS } from "./shortcuts";

/** Mod+/: every shortcut, app-wide and in the editor. */
export function ShortcutsDialog() {
  const { t } = useTranslation();
  return (
    <DialogFrame title={t("shortcuts.title")} description={t("shortcuts.description")} wide>
      <div className="shortcut-groups">
        {SHORTCUT_GROUPS.map((g) => (
          <section key={g.title} className="shortcut-group">
            <h3>{t(`shortcuts.groups.${g.title}`)}</h3>
            <dl>
              {g.items.map(([combo, label]) => (
                <div key={combo + label} className="shortcut-row">
                  <dt>{t(`shortcuts.${label}`)}</dt>
                  <dd>
                    <kbd>{keyLabel(combo)}</kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </DialogFrame>
  );
}
