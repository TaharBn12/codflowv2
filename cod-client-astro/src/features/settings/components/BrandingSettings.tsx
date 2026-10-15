import { useRef, useState } from "react";
import { ImagePlus, Loader2, Palette, Trash2 } from "lucide-react";
import { Input } from "@/components/ui";
import { useT } from "@/i18n/react";
import { notify } from "@/lib/notify";
import { uploadStoreImage } from "@/features/settings/api";
import type { StoreConfig } from "@/features/settings/types";
import { ColorField, FieldRow, SettingsSection } from "@/features/settings/components/SettingsSection";

const ACCEPTED = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"];
const MAX_MB = 10;

export function BrandingSettings({
  storeConfig,
  onSave,
}: {
  storeConfig: StoreConfig;
  onSave: (payload: {
    primaryColor?: string;
    accentColor?: string;
    bgColor?: string;
    fontFamily?: string;
    logoUrl?: string | null;
  }) => Promise<void>;
}) {
  const t = useT("settings");
  const common = useT("common");
  const [primaryColor, setPrimaryColor] = useState(storeConfig.primaryColor);
  const [accentColor, setAccentColor] = useState(storeConfig.accentColor);
  const [bgColor, setBgColor] = useState(storeConfig.bgColor);
  const [fontFamily, setFontFamily] = useState(storeConfig.fontFamily);
  const [logoUrl, setLogoUrl] = useState<string | null>(storeConfig.logoUrl);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleLogoFile(file: File | undefined) {
    if (!file) return;
    if (!ACCEPTED.includes(file.type)) {
      notify.error(common("feedback.unsupported_file"));
      return;
    }
    if (file.size > MAX_MB * 1024 * 1024) {
      notify.error(common("feedback.file_too_large"));
      return;
    }
    setUploading(true);
    try {
      const uploaded = await uploadStoreImage(file);
      setLogoUrl(uploaded.url);
      notify.success(common("feedback.uploaded"));
    } catch {
      notify.error(common("feedback.upload_failed"));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <SettingsSection
      icon={Palette}
      title={t("store.branding_title")}
      subtitle={t("store.branding_subtitle")}
      onSave={async () => {
        await onSave({
          primaryColor,
          accentColor,
          bgColor,
          fontFamily: fontFamily.trim() || storeConfig.fontFamily,
          logoUrl,
        });
      }}
    >
      <FieldRow label={t("store.logo_label")} hint={t("store.logo_hint")}>
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED.join(",")}
          className="hidden"
          onChange={(event) => void handleLogoFile(event.currentTarget.files?.[0])}
        />
        <div className="flex flex-wrap items-center gap-3">
          {logoUrl ? (
            <img
              src={logoUrl}
              alt=""
              className="h-12 max-w-48 rounded-lg border border-border bg-muted object-contain p-1.5"
            />
          ) : (
            <div className="grid h-12 w-32 place-items-center rounded-lg border border-dashed border-border bg-muted text-xs text-muted-foreground">
              —
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm font-semibold text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
            >
              {uploading ? (
                <Loader2 size={15} className="animate-spin" aria-hidden="true" />
              ) : (
                <ImagePlus size={15} aria-hidden="true" />
              )}
              {uploading ? t("store.logo_uploading") : t("store.logo_upload")}
            </button>
            {logoUrl && (
              <button
                type="button"
                disabled={uploading}
                onClick={() => setLogoUrl(null)}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm font-semibold text-destructive transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Trash2 size={15} aria-hidden="true" />
                {t("store.logo_remove")}
              </button>
            )}
          </div>
        </div>
      </FieldRow>

      <div className="flex h-8 w-full overflow-hidden rounded-lg border border-border" aria-hidden="true">
        <div className="flex-1" style={{ background: primaryColor }} />
        <div className="flex-1" style={{ background: accentColor }} />
        <div className="flex-1" style={{ background: bgColor }} />
      </div>

      <ColorField
        label={t("store.primary_color_label")}
        hint={t("store.primary_color_hint")}
        value={primaryColor}
        onChange={setPrimaryColor}
      />
      <ColorField
        label={t("store.accent_color_label")}
        hint={t("store.accent_color_hint")}
        value={accentColor}
        onChange={setAccentColor}
      />
      <ColorField
        label={t("store.bg_color_label")}
        hint={t("store.bg_color_hint")}
        value={bgColor}
        onChange={setBgColor}
      />
      <FieldRow label={t("store.font_family_label")}>
        <Input
          dir="ltr"
          value={fontFamily}
          onChange={(event) => setFontFamily(event.currentTarget.value)}
          placeholder={t("store.font_family_placeholder")}
        />
      </FieldRow>
    </SettingsSection>
  );
}


