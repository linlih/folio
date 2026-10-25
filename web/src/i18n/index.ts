import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import zh from "./locales/zh.json";

export const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "zh", label: "简体中文" },
] as const;

export type Language = (typeof LANGUAGES)[number]["code"];

/** The device-local setting that holds the chosen UI language. */
export const LANGUAGE_SETTING = "ui.language";

export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.some((l) => l.code === value);
}

/** The system language when supported, English otherwise. */
export function systemLanguage(locales: readonly string[] = navigator.languages): Language {
  for (const locale of locales) {
    const base = locale.toLowerCase().split("-")[0];
    if (isLanguage(base)) return base;
  }
  return "en";
}

export function initI18n(language: Language) {
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  return i18n.use(initReactI18next).init({
    resources: { en: { translation: en }, zh: { translation: zh } },
    lng: language,
    fallbackLng: "en",
    interpolation: { escapeValue: false },
  });
}

export async function changeLanguage(language: Language) {
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  await i18n.changeLanguage(language);
}

export default i18n;
