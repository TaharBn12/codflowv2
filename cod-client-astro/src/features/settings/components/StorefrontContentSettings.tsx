import { useState } from "react";
import { Languages, RotateCcw } from "lucide-react";
import { useT, useLocale } from "@/i18n/react";
import type { StoreConfig } from "@/features/settings/types";
import {
  CONTENT_DEFAULTS,
  CONTENT_SECTIONS,
  type StoreContentLang,
} from "@/features/settings/content-catalog";
import {
  CONTENT_SECTION_TITLES,
  contentFieldLabel,
} from "@/features/settings/content-labels";
import {
  buildContentJson,
  customizedCount,
  hasPlaceholders,
  isCustomized,
  parseContentOverrides,
  type ContentOverrides,
} from "@/features/settings/content-editor";
import { SettingsSection } from "@/features/settings/components/SettingsSection";

const LANG_LABEL_KEYS: Record<StoreContentLang, string> = { ar: "store.lang_ar", en: "store.lang_en" };

export function StorefrontContentSettings({
  storeConfig,
  onSave,
}: {
  storeConfig: StoreConfig;
  onSave: (payload: { contentJson: string | null }) => Promise<void>;
}) {
  const t = useT("settings");
  const locale = useLocale();
  const [overrides, setOverrides] = useState<ContentOverrides>(() =>
    parseContentOverrides(storeConfig.contentJson, storeConfig.lang),
  );
  const [activeLang, setActiveLang] = useState<StoreContentLang>(storeConfig.lang);

  function setField(key: string, value: string) {
    setOverrides((prev) => ({ ...prev, [activeLang]: { ...prev[activeLang], [key]: value } }));
  }

  function normalizeField(key: string) {
    setOverrides((prev) => {
      const raw = prev[activeLang][key];
      if (raw != null && (raw === "" || raw === CONTENT_DEFAULTS[activeLang][key])) {
        const next = { ...prev[activeLang] };
        delete next[key];
        return { ...prev, [activeLang]: next };
      }
      return prev;
    });
  }

  function resetField(key: string) {
    setOverrides((prev) => {
      const next = { ...prev[activeLang] };
      delete next[key];
      return { ...prev, [activeLang]: next };
    });
  }

  function resetLanguage() {
    setOverrides((prev) => ({ ...prev, [activeLang]: {} }));
  }

  return (
    <SettingsSection
      icon={Languages}
      title={t("store.storefront_title")}
      subtitle={t("store.storefront_subtitle")}
      onSave={async () => {
        await onSave({ contentJson: buildContentJson(overrides) });
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2" role="group" aria-label={t("store.storefront_title")}>
          {(["ar", "en"] as StoreContentLang[]).map((lang) => {
            const isActive = activeLang === lang;
            const count = customizedCount(lang, overrides);
            return (
              <button
                key={lang}
                type="button"
                aria-pressed={isActive}
                onClick={() => setActiveLang(lang)}
                className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
                  isActive
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "bg-muted text-muted-foreground hover:bg-muted/70"
                }`}
              >
                {t(LANG_LABEL_KEYS[lang])}
                {count > 0 && (
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none ${
                      isActive ? "bg-primary-foreground/20" : "bg-background/60"
                    }`}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={resetLanguage}
          disabled={customizedCount(activeLang, overrides) === 0}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RotateCcw size={13} aria-hidden="true" />
          {t("store.content_reset_lang")}
        </button>
      </div>

      <p className="text-xs text-muted-foreground">{t("store.content_hint")}</p>

      <div className="space-y-8">
        {CONTENT_SECTIONS.map((section) => (
          <div key={section.id}>
            <h3 className="mb-3 border-b border-border pb-2 text-sm font-bold text-foreground">
              {CONTENT_SECTION_TITLES[section.id]?.[locale] ?? section.id}
            </h3>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {section.keys.map((key) => {
                // Show the raw edit while it exists (including an in-progress
                // empty value); fall back to the theme default when the field
                // has no override.
                const rawValue = overrides[activeLang][key];
                const value = rawValue != null ? rawValue : (CONTENT_DEFAULTS[activeLang][key] ?? "");
                const customized = isCustomized(activeLang, key, overrides);
                const defaultValue = CONTENT_DEFAULTS[activeLang][key] ?? "";
                const long = defaultValue.length > 60;
                const inputDir = activeLang === "ar" ? "rtl" : "ltr";
                return (
                  <div key={key} className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <label
                        className="text-sm font-semibold text-foreground"
                        htmlFor={`content-${activeLang}-${key}`}
                      >
                        {contentFieldLabel(locale, key)}
                      </label>
                      <div className="flex items-center gap-2">
                        {customized && (
                          <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-bold text-violet-700">
                            {t("store.content_modified")}
                          </span>
                        )}
                        {customized && (
                          <button
                            type="button"
                            onClick={() => resetField(key)}
                            title={t("store.content_reset")}
                            aria-label={`${t("store.content_reset")} — ${contentFieldLabel(locale, key)}`}
                            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          >
                            <RotateCcw size={13} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    </div>
                    {long ? (
                      <textarea
                        id={`content-${activeLang}-${key}`}
                        dir={inputDir}
                        value={value}
                        rows={2}
                        onChange={(event) => setField(key, event.currentTarget.value)}
                        onBlur={() => normalizeField(key)}
                        className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
                      />
                    ) : (
                      <input
                        id={`content-${activeLang}-${key}`}
                        dir={inputDir}
                        value={value}
                        onChange={(event) => setField(key, event.currentTarget.value)}
                        onBlur={() => normalizeField(key)}
                        className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
                      />
                    )}
                    {hasPlaceholders(activeLang, key) && (
                      <p className="text-[11px] text-muted-foreground">
                        {t("store.content_placeholder_hint")}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </SettingsSection>
  );
}
