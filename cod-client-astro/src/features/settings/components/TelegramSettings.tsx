import { useEffect, useState } from "react";
import { Bot, Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui";
import { useT } from "@/i18n/react";
import { getTelegramConfig, saveTelegramConfig } from "@/features/settings/api";
import { FieldRow, SettingsSection } from "./SettingsSection";

export function TelegramSettings() {
  const t = useT("settings");
  const [botToken, setBotToken] = useState("");
  const [masked, setMasked] = useState("");
  const [chatId, setChatId] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    void getTelegramConfig().then((v) => {
      setMasked(v.botTokenMasked);
      setChatId(v.chatId);
      setEnabled(v.enabled);
      setSource(v.source);
    });
  }, []);
  async function save() {
    if (!chatId.trim() || (!botToken.trim() && !masked))
      throw new Error(t("store.field_required"));
    const value = await saveTelegramConfig({
      botToken: botToken.trim() || undefined,
      chatId: chatId.trim(),
      enabled,
    });
    setMasked(value.botTokenMasked);
    setSource(value.source);
    setBotToken("");
  }
  return (
    <SettingsSection
      icon={Bot}
      title={t("store.telegram_title")}
      subtitle={t("store.telegram_subtitle")}
      onSave={save}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold">{t("store.telegram_enabled")}</p>
          <p className="text-xs text-muted-foreground">
            {t("store.telegram_enabled_hint")}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => setEnabled((v) => !v)}
          className={`relative inline-flex h-6 w-11 rounded-full border-2 border-transparent transition-colors focus-visible:ring-2 focus-visible:ring-ring ${enabled ? "bg-brand" : "bg-muted-foreground/35"}`}
        >
          <span
            className={`absolute left-0.5 top-0.5 size-4 rounded-full shadow-sm transition-transform ${enabled ? "translate-x-5 bg-brand-foreground" : "translate-x-0 bg-background"}`}
          />
        </button>
      </div>
      <FieldRow
        label={t("store.telegram_token")}
        hint={t("store.telegram_token_hint")}
      >
        <div className="relative">
          <Input
            type={show ? "text" : "password"}
            dir="ltr"
            value={botToken}
            onChange={(e) => setBotToken(e.currentTarget.value)}
            placeholder={masked || t("store.telegram_token_placeholder")}
            autoComplete="off"
            className="pe-10"
          />
          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          >
            {show ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </div>
        {masked && (
          <p className="text-xs text-muted-foreground">
            {t("store.telegram_stored")}: <span dir="ltr">{masked}</span>
          </p>
        )}
      </FieldRow>
      <FieldRow
        label={t("store.telegram_chat_id")}
        hint={t("store.telegram_chat_hint")}
      >
        <Input
          dir="ltr"
          value={chatId}
          onChange={(e) => setChatId(e.currentTarget.value)}
          placeholder="-1001234567890"
        />
      </FieldRow>
      {source === "environment" && (
        <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
          {t("store.telegram_environment")}
        </p>
      )}
    </SettingsSection>
  );
}
