import { useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  GripVertical,
  Loader2,
  Monitor,
  Pencil,
  RotateCcw,
  Smartphone,
  UploadCloud,
  X,
} from "lucide-react";
import { canScope, RequireAuth, useIdentity } from "@/features/auth/components/RequireAuth";
import { Alert, Badge, Button, ConfirmDialogProvider, IconButton } from "@/components/ui";
import { useT } from "@/i18n/react";
import { notify } from "@/lib/notify";
import { SCOPES } from "../../../../../cod-shared/rbac/scopes";
import {
  deleteLandingPageImage,
  getLandingPage,
  getPresignedLandingUploadUrl,
  publishLandingPage,
  reorderLandingPageImages,
  saveLandingPageImage,
  unpublishLandingPage,
  updateLandingPage,
} from "@/features/landing-pages/api";
import { landingPageErrorMessage, landingPagePublicUrl } from "@/features/landing-pages/model";
import type { LandingPage, LandingPageImage } from "@/features/landing-pages/types";

const ACCEPTED = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"];
const MAX_MB = 10;
const SLUG_PATTERN = /^[a-z0-9-]{3,60}$/;

function swapAt<T>(arr: T[], i: number, j: number): T[] {
  const next = [...arr];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/** Intrinsic pixel size of a file, measured locally before upload. Resolves
 *  null on decode failure — dimension capture is fail-open, never blocks an
 *  upload; the storefront just renders that image without reserved space. */
function measureImage(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img.naturalWidth > 0 && img.naturalHeight > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : null);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

type SaveState = "idle" | "saving" | "saved" | "error";
type PreviewDevice = "mobile" | "desktop";

function SettingSection({ title, children, open = false }: {
  title: string;
  children: React.ReactNode;
  open?: boolean;
}) {
  return (
    <details open={open} className="group border-b border-border bg-card">
      <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3.5 text-sm font-bold transition-colors hover:bg-muted/60 [&::-webkit-details-marker]:hidden">
        {title}
        <ChevronDown size={15} className="text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-4 px-4 pb-5">{children}</div>
    </details>
  );
}

function SaveIndicator({ state, label }: { state: SaveState; label: string }) {
  return (
    <span
      className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      {state === "saving" ? (
        <Loader2 size={13} className="animate-spin" />
      ) : state === "saved" ? (
        <Check size={13} className="text-[var(--success)]" />
      ) : state === "error" ? (
        <AlertCircle size={13} className="text-destructive" />
      ) : null}
      <span className="hidden sm:inline">{label}</span>
    </span>
  );
}

/**
 * The Studio's own chrome — deliberately NOT the dashboard layout.
 *
 * An editor surface owns the whole viewport: a compact studio bar (back,
 * identity, autosave, publish, link actions, slug editing) over a three-pane
 * work area, each pane scrolling independently. No main sidebar, no dashboard
 * topbar — the merchant is "inside" the page they're building. Authentication
 * and scope gating stay identical to every dashboard surface.
 */
function StudioShell({
  title,
  saveState,
  saveLabel,
  toolbar,
  children,
}: {
  title: string;
  saveState: SaveState;
  saveLabel: string;
  toolbar?: React.ReactNode;
  children: React.ReactNode;
}) {
  const t = useT("landing-pages");
  return (
    <ConfirmDialogProvider>
      <div className="flex h-[100dvh] flex-col overflow-hidden bg-background text-foreground">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card px-3 sm:px-4">
          <a
            href="/landing-pages"
            className="flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-sm font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title={t("page_title")}
          >
            <ArrowRight size={16} className="rtl:rotate-180" />
            <span className="hidden text-xs font-bold lg:inline">{t("page_title")}</span>
          </a>
          <span className="hidden h-5 w-px bg-border sm:block" aria-hidden="true" />
          <h1 className="min-w-0 truncate text-sm font-bold">{title}</h1>
          <div className="flex-1" />
          {toolbar}
          <SaveIndicator state={saveState} label={saveLabel} />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto lg:overflow-hidden">
          <div className="grid h-full grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)_320px]">
            {children}
          </div>
        </div>
      </div>
    </ConfirmDialogProvider>
  );
}

function Gated({ landingPageId }: { landingPageId: string }) {
  const t = useT("landing-pages");
  const common = useT("common");
  const auth = useT("auth");
  const identity = useIdentity();

  // ── ALL hooks, before any early return (hooks-order discipline) ──────────
  const [lp, setLp] = useState<LandingPage | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [name, setName] = useState("");
  const [imageGap, setImageGap] = useState(0);
  const [design, setDesign] = useState({
    sidePadding: 0, contentMaxWidth: 0,
    showImages: true, showOrderForm: true, showStickyCta: true,
    backgroundColor: "#ffffff", buttonColor: "#7c3aed",
    buttonTextColor: "#ffffff", buttonRadius: 12,
  });
  const [previewDevice, setPreviewDevice] = useState<PreviewDevice>("mobile");
  const [previewZoom, setPreviewZoom] = useState(85);
  // Defer the expensive creative stack repaint so range/color controls stay
  // responsive even when a landing page contains many large images.
  const previewDesign = useDeferredValue(design);
  const previewGap = useDeferredValue(imageGap);

  // Slug editing: committed value (autosaved) + in-flight draft while editing
  const [slugDraft, setSlugDraft] = useState<string | null>(null);
  const [slugSaving, setSlugSaving] = useState(false);
  const slugInputRef = useRef<HTMLInputElement>(null);

  const [publishOpen, setPublishOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const canManage = canScope(identity, SCOPES.LANDING_PAGES_MANAGE);
  const canRead = canScope(identity, SCOPES.LANDING_PAGES_READ);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await getLandingPage(landingPageId);
      setLp(data);
      setName(data.name);
      setImageGap(data.imageGap);
      setDesign({
        sidePadding: data.sidePadding, contentMaxWidth: data.contentMaxWidth,
        showImages: data.showImages, showOrderForm: data.showOrderForm,
        showStickyCta: data.showStickyCta, backgroundColor: data.backgroundColor,
        buttonColor: data.buttonColor, buttonTextColor: data.buttonTextColor,
        buttonRadius: data.buttonRadius,
      });
      setSlugDraft(null);
      setSaveState("idle");
    } catch (cause) {
      setLoadError(cause);
    }
  }, [landingPageId]);

  useEffect(() => {
    if (canRead) void load();
  }, [canRead, load, identity?.role, identity?.scopes.join(",")]);

  const baseline = lp;
  const isDirty = baseline !== null && (
    (name.trim() !== "" && name !== baseline.name) ||
    imageGap !== baseline.imageGap ||
    (Object.keys(design) as Array<keyof typeof design>).some((key) => design[key] !== baseline[key])
  );

  // Edits stay entirely local until the merchant explicitly saves everything.
  // This prevents network responses, loading overlays, and page repainting while typing.
  const saveAll = useCallback(async () => {
    if (!lp || !canManage || !isDirty || saveState === "saving") return;
    setSaveState("saving");
    try {
      const updated = await updateLandingPage(landingPageId, {
        ...(name.trim() !== "" ? { name: name.trim() } : {}),
        imageGap,
        ...design,
      });
      setLp(updated.data);
      setName(updated.data.name);
      setSaveState("saved");
      notify.success(t("studio.saved"));
    } catch (cause) {
      setSaveState("error");
      notify.error(landingPageErrorMessage(cause, t));
    }
  }, [lp, canManage, isDirty, saveState, landingPageId, name, imageGap, design, t]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveAll();
      }
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!isDirty) return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [isDirty, saveAll]);

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      if (!canManage) return;
      const selected = Array.from(files);
      if (selected.some((file) => !ACCEPTED.includes(file.type)))
        notify.error(common("feedback.unsupported_file"));
      const accepted = selected.filter((file) => ACCEPTED.includes(file.type));
      if (accepted.some((file) => file.size > MAX_MB * 1024 * 1024))
        notify.error(common("feedback.file_too_large"));
      const arr = accepted.filter((file) => file.size <= MAX_MB * 1024 * 1024);
      if (!arr.length) return;

      setUploading(true);
      try {
        for (const file of arr) {
          const { presignedUrl, key, publicUrl } = await getPresignedLandingUploadUrl(file.type);
          const putRes = await fetch(presignedUrl, {
            method: "PUT",
            headers: { "Content-Type": file.type },
            body: file,
          });
          if (!putRes.ok) throw new Error(`R2 upload failed: ${putRes.status}`);
          const dims = await measureImage(file);
          const images = await saveLandingPageImage(landingPageId, {
            key,
            src: publicUrl,
            ...(dims ?? {}),
          });
          setLp((prev) => (prev ? { ...prev, images } : prev));
        }
        notify.success(common("feedback.uploaded"));
      } catch (cause) {
        setActionError(landingPageErrorMessage(cause, t));
        notify.error(landingPageErrorMessage(cause, t));
      } finally {
        setUploading(false);
      }
    },
    [canManage, landingPageId, common, t],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      void handleFiles(event.dataTransfer.files);
    },
    [handleFiles],
  );

  const onMove = useCallback(
    async (image: LandingPageImage, direction: -1 | 1) => {
      const images = lp?.images ?? [];
      const index = images.findIndex((img) => img.id === image.id);
      const target = index + direction;
      if (index === -1 || target < 0 || target >= images.length) return;
      const nextIds = swapAt(images, index, target).map((img) => img.id);
      try {
        const nextImages = await reorderLandingPageImages(landingPageId, nextIds);
        setLp((prev) => (prev ? { ...prev, images: nextImages } : prev));
      } catch (cause) {
        setActionError(landingPageErrorMessage(cause, t));
        notify.error(landingPageErrorMessage(cause, t));
      }
    },
    [lp, landingPageId, t],
  );

  const onRemove = useCallback(
    async (image: LandingPageImage) => {
      try {
        await deleteLandingPageImage(landingPageId, image.id);
        setLp((prev) =>
          prev ? { ...prev, images: prev.images.filter((img) => img.id !== image.id) } : prev,
        );
        notify.success(common("feedback.deleted"));
      } catch (cause) {
        setActionError(landingPageErrorMessage(cause, t));
        notify.error(landingPageErrorMessage(cause, t));
      }
    },
    [landingPageId, common, t],
  );

  const onTogglePublish = useCallback(async () => {
    if (!lp) return;
    setPublishing(true);
    setPublishOpen(false);
    try {
      const res =
        lp.status === "published"
          ? await unpublishLandingPage(landingPageId)
          : await publishLandingPage(landingPageId);
      setLp(res.data);
      notify.success(common("feedback.updated"));
    } catch (cause) {
      setActionError(landingPageErrorMessage(cause, t));
      notify.error(landingPageErrorMessage(cause, t));
    } finally {
      setPublishing(false);
    }
  }, [lp, landingPageId, common, t]);

  const onCopyLink = useCallback(() => {
    if (!lp) return;
    const url = landingPagePublicUrl(lp);
    void navigator.clipboard?.writeText(url).then(
      () => notify.success(t("list.link_copied")),
      () => notify.error(t("error_generic")),
    );
  }, [lp, t]);

  const startSlugEdit = useCallback(() => {
    if (!lp || !canManage) return;
    setSlugDraft(lp.slug);
    // Focus after the input mounts
    requestAnimationFrame(() => slugInputRef.current?.select());
  }, [lp, canManage]);

  const applySlug = useCallback(async () => {
    if (!lp || slugDraft === null) return;
    const next = slugDraft.trim();
    if (!SLUG_PATTERN.test(next)) {
      notify.error(t("studio.slug_invalid"));
      return;
    }
    if (next === lp.slug) {
      setSlugDraft(null);
      return;
    }
    setSlugSaving(true);
    try {
      const updated = await updateLandingPage(landingPageId, { slug: next });
      setLp(updated.data);
      setSlugDraft(null);
      notify.success(t("studio.saved"));
    } catch (cause) {
      notify.error(landingPageErrorMessage(cause, t));
    } finally {
      setSlugSaving(false);
    }
  }, [lp, slugDraft, landingPageId, t]);

  // ── Early returns AFTER every hook ────────────────────────────────────────
  const saveLabel =
    saveState === "saving"
      ? t("studio.saving")
      : saveState === "error"
        ? t("error_generic")
        : isDirty
          ? t("studio.unsaved")
          : t("studio.saved");

  if (!canRead)
    return (
      <StudioShell title={t("studio.title")} saveState={saveState} saveLabel={saveLabel}>
        <div className="col-span-full p-6">
          <Alert role="alert" tone="critical">{auth("no_access")}</Alert>
        </div>
      </StudioShell>
    );

  if (loadError)
    return (
      <StudioShell title={t("studio.title")} saveState={saveState} saveLabel={saveLabel}>
        <div className="col-span-full p-6">
          <Alert role="alert" tone="critical">
            <AlertCircle size={18} className="shrink-0" />
            <div className="flex-1">
              <p className="font-semibold">{t("error_generic")}</p>
              <button
                type="button"
                onClick={() => void load()}
                className="mt-3 text-xs font-semibold underline underline-offset-4"
              >
                {common("retry")}
              </button>
            </div>
          </Alert>
        </div>
      </StudioShell>
    );

  if (lp === null)
    return (
      <StudioShell title={t("studio.title")} saveState={saveState} saveLabel={saveLabel}>
        <div className="col-span-full flex items-center justify-center py-24" role="status" aria-busy="true">
          <Loader2 size={22} className="animate-spin text-muted-foreground" />
        </div>
      </StudioShell>
    );

  // ── Render ─────────────────────────────────────────────────────────────────
  const isPublished = lp.status === "published";
  const publicUrl = landingPagePublicUrl(lp);
  const editingSlug = slugDraft !== null;

  const toolbar = (
    <>
      {/* Slug: inline display, pencil to edit, apply/✕ while editing */}
      <div className="flex items-center" dir="ltr">
        {editingSlug ? (
          <>
            <span className="hidden font-mono text-xs text-muted-foreground sm:inline">/lp/</span>
            <input
              ref={slugInputRef}
              type="text"
              value={slugDraft}
              onChange={(event) => setSlugDraft(event.currentTarget.value.toLowerCase())}
              onKeyDown={(event) => {
                if (event.key === "Enter") void applySlug();
                if (event.key === "Escape") setSlugDraft(null);
              }}
              aria-label={t("studio.slug_label")}
              className="h-8 w-36 rounded-lg border border-input bg-background px-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-44"
              spellCheck={false}
              autoComplete="off"
              maxLength={60}
            />
            <button
              type="button"
              onClick={() => void applySlug()}
              disabled={slugSaving}
              className="ms-1 flex h-8 items-center gap-1 rounded-lg bg-primary px-2 text-xs font-bold text-primary-foreground disabled:opacity-60"
              title={t("studio.slug_apply")}
            >
              {slugSaving ? <Loader2 size={12} className="animate-spin" /> : <Check size={13} />}
            </button>
            <button
              type="button"
              onClick={() => setSlugDraft(null)}
              className="ms-0.5 flex h-8 w-8 items-center justify-center rounded-lg hover:bg-muted"
              title={common("cancel")}
            >
              <X size={13} />
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={startSlugEdit}
            disabled={!canManage}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2 font-mono text-xs text-muted-foreground transition-colors hover:border-input hover:text-foreground disabled:opacity-50"
            title={t("studio.slug_edit")}
          >
            <span className="max-w-40 truncate">/lp/{lp.slug}</span>
            {canManage && <Pencil size={12} className="shrink-0 opacity-70" />}
          </button>
        )}
      </div>

      {isPublished && (
        <>
          <button
            type="button"
            onClick={() => onCopyLink()}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-xs font-semibold transition-colors hover:bg-muted"
            title={publicUrl}
          >
            <Copy size={14} />
            <span className="hidden md:inline">{t("list.copy_link")}</span>
          </button>
          <a
            href={publicUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-xs font-semibold transition-colors hover:bg-muted"
            title={t("list.view")}
          >
            <ExternalLink size={14} />
            <span className="hidden md:inline">{t("list.view")}</span>
          </a>
        </>
      )}

      {canManage && (
        <Button
          type="button"
          onClick={() => void saveAll()}
          disabled={!isDirty || saveState === "saving"}
          className="h-8 px-3 text-xs"
        >
          {saveState === "saving" ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
          {t("studio.save_all")}
        </Button>
      )}

      {/* Publish toggle */}
      {canManage && (
        <div className="relative">
          <button
            type="button"
            onClick={() => setPublishOpen((open) => !open)}
            disabled={publishing || isDirty}
            title={isDirty ? t("studio.save_before_publish") : undefined}
            className="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-bold text-primary-foreground disabled:opacity-60"
          >
            {publishing ? <Loader2 size={13} className="animate-spin" /> : null}
            {isPublished ? t("status_published") : t("actions.publish")}
            <ChevronDown size={13} className={publishOpen ? "rotate-180 transition-transform" : "transition-transform"} />
          </button>
          {publishOpen && (
            <>
              <div
                className="fixed inset-0 z-10 bg-transparent"
                aria-hidden="true"
                onClick={() => setPublishOpen(false)}
              />
              <div className="absolute end-0 top-9 z-20 w-52 rounded-xl border border-border bg-popover p-1.5 shadow-lg">
                <p className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
                  {isPublished ? t("status_published") : t("status_draft")}
                </p>
                <button
                  type="button"
                  onClick={() => void onTogglePublish()}
                  disabled={publishing}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs font-semibold hover:bg-muted"
                >
                  {isPublished ? <ChevronDown size={14} /> : <Check size={14} />}
                  {isPublished ? t("actions.unpublish") : t("actions.publish")}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );

  return (
    <StudioShell title={lp.name} saveState={isDirty ? "idle" : saveState} saveLabel={saveLabel} toolbar={toolbar}>
      {actionError && (
        <div className="col-span-full px-4 pt-3">
          <Alert role="alert" tone="critical">
            <AlertCircle size={18} className="shrink-0" />
            <span className="flex-1">{actionError}</span>
          </Alert>
        </div>
      )}

      {/* LEFT — identity, upload & stack */}
      <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto border-e border-border p-4">
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-muted-foreground">
              {t("studio.name_label")}
            </span>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              disabled={!canManage}
              className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm"
            />
          </label>
          <div className="flex items-center gap-2">
            <Badge tone={isPublished ? "success" : "warning"}>
              {isPublished ? t("status_published") : t("status_draft")}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {lp.product?.name ?? ""}
            </span>
          </div>
        </div>

        <div className="border-t border-border pt-4">
          <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            {t("studio.left_title")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{t("studio.left_hint")}</p>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={!canManage || uploading}
            onDragOver={(event) => event.preventDefault()}
            onDrop={onDrop}
            className="mt-3 flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border p-5 text-sm text-muted-foreground transition hover:border-brand/50 disabled:opacity-50"
          >
            {uploading ? (
              <>
                <Loader2 size={20} className="animate-spin" />
                {t("studio.uploading")}
              </>
            ) : (
              <>
                <UploadCloud size={20} />
                {t("studio.upload")}
              </>
            )}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED.join(",")}
            multiple
            className="hidden"
            onChange={(event) => {
              if (event.target.files) void handleFiles(event.target.files);
              event.target.value = "";
            }}
          />

          <div className="mt-4 space-y-2 pb-2">
            {lp.images.length === 0 && (
              <p className="py-6 text-center text-xs text-muted-foreground">
                {t("studio.no_images")}
              </p>
            )}
            {lp.images.map((image, index) => (
              <div
                key={image.id}
                className="flex items-center gap-2 rounded-lg border border-border bg-background p-2"
              >
                <GripVertical size={14} className="shrink-0 text-muted-foreground/50" />
                <span className="w-5 shrink-0 text-center text-[0.7rem] font-bold text-muted-foreground">
                  {index + 1}
                </span>
                <img
                  src={image.src}
                  alt={image.altText ?? ""}
                  loading="lazy"
                  className="h-12 w-12 shrink-0 rounded object-cover"
                />
                <div className="flex-1" />
                {canManage && (
                  <div className="flex flex-col gap-0.5">
                    <IconButton
                      type="button"
                      aria-label={common("move_up")}
                      title={common("move_up")}
                      onClick={() => void onMove(image, -1)}
                      disabled={index === 0}
                      className="size-6"
                    >
                      <ChevronUp size={13} />
                    </IconButton>
                    <IconButton
                      type="button"
                      aria-label={common("move_down")}
                      title={common("move_down")}
                      onClick={() => void onMove(image, 1)}
                      disabled={index === lp.images.length - 1}
                      className="size-6"
                    >
                      <ChevronDown size={13} />
                    </IconButton>
                  </div>
                )}
                {canManage && (
                  <IconButton
                    type="button"
                    aria-label={t("studio.remove")}
                    title={t("studio.remove")}
                    onClick={() => void onRemove(image)}
                    className="size-7 text-destructive"
                  >
                    <X size={14} />
                  </IconButton>
                )}
              </div>
            ))}
          </div>
        </div>
      </aside>

      {/* CENTER — responsive live preview, isolated from autosave network state */}
      <section className="relative flex min-h-[520px] min-w-0 flex-col overflow-hidden bg-[radial-gradient(circle_at_center,hsl(var(--muted))_1px,transparent_1px)] [background-size:20px_20px]">
        <div className="sticky top-0 z-10 flex h-12 shrink-0 items-center justify-center gap-2 border-b border-border bg-card/95 px-3 backdrop-blur">
          <div className="flex rounded-lg border border-border bg-background p-0.5">
            <button type="button" onClick={() => setPreviewDevice("mobile")}
              className={`grid size-8 place-items-center rounded-md ${previewDevice === "mobile" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
              title={t("studio.mobile_preview")}><Smartphone size={15} /></button>
            <button type="button" onClick={() => setPreviewDevice("desktop")}
              className={`grid size-8 place-items-center rounded-md ${previewDevice === "desktop" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
              title={t("studio.desktop_preview")}><Monitor size={15} /></button>
          </div>
          <label className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
            <input type="range" min={50} max={100} step={5} value={previewZoom}
              onChange={(event) => setPreviewZoom(Number(event.currentTarget.value))}
              className="w-20 accent-primary" />
            {previewZoom}%
          </label>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-6">
          <div
            className={`mx-auto shrink-0 overflow-hidden bg-white shadow-2xl transition-[width,border-radius] duration-300 ${previewDevice === "mobile" ? "rounded-[2rem] border-[7px] border-slate-800" : "rounded-lg border border-border"}`}
            style={{
              width: previewDevice === "mobile" ? 390 : 900,
              maxWidth: previewDevice === "mobile" ? "100%" : "none",
              transform: `scale(${previewZoom / 100})`,
              transformOrigin: "top center",
              backgroundColor: previewDesign.backgroundColor,
              minHeight: 520,
              marginBottom: `${Math.max(0, (previewZoom - 100) * 5)}px`,
            }}
          >
            {previewDevice === "mobile" && (
              <div className="flex h-6 items-center justify-center bg-slate-800">
                <span className="h-1.5 w-16 rounded-full bg-white/30" />
              </div>
            )}
            {previewDesign.showImages && (lp.images.length === 0 ? (
              <div className="flex h-64 items-center justify-center text-xs text-slate-500">
                {t("studio.no_images")}
              </div>
            ) : (
              <div className="mx-auto" style={{ paddingInline: previewDesign.sidePadding, maxWidth: previewDesign.contentMaxWidth || undefined }}>
                {lp.images.map((image, index) => (
                  <img key={image.id} src={image.src} alt={image.altText ?? ""}
                    loading={index === 0 ? "eager" : "lazy"} className="block w-full"
                    style={index === 0 ? undefined : { marginTop: previewGap }} />
                ))}
              </div>
            ))}
            {previewDesign.showOrderForm && (
              <div className="mx-auto p-4" style={{ maxWidth: previewDesign.contentMaxWidth || 576 }}>
                <div className="rounded-xl border border-slate-200 bg-white p-5 text-center shadow-sm">
                  <span className="block text-sm font-bold text-slate-800">{lp.product?.name ?? ""}</span>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <span className="h-9 rounded-lg bg-slate-100" />
                    <span className="h-9 rounded-lg bg-slate-100" />
                    <span className="col-span-2 h-9 rounded-lg bg-slate-100" />
                  </div>
                  <span className="mt-3 block h-10 text-xs font-bold leading-10 shadow-sm"
                    style={{ backgroundColor: previewDesign.buttonColor, color: previewDesign.buttonTextColor, borderRadius: previewDesign.buttonRadius }}>
                    {t("studio.order_button_preview")}
                  </span>
                </div>
              </div>
            )}
            {previewDesign.showStickyCta && previewDesign.showOrderForm && (
              <div className="sticky bottom-3 mx-auto mb-3 w-[min(24rem,calc(100%-2rem))] h-11 text-center text-xs font-bold leading-[2.75rem] shadow-lg"
                style={{ backgroundColor: previewDesign.buttonColor, color: previewDesign.buttonTextColor, borderRadius: previewDesign.buttonRadius }}>
                {t("studio.order_button_preview")}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* RIGHT — Shopify-style grouped settings inspector */}
      <aside className="flex min-h-0 flex-col overflow-y-auto border-s border-border bg-card">
        <div className="sticky top-0 z-10 border-b border-border bg-card px-4 py-3">
          <p className="text-sm font-bold">{t("studio.settings_title")}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{t("studio.instant_preview_hint")}</p>
        </div>

        <SettingSection title={t("studio.elements_section")} open>
          {(["showImages", "showOrderForm", "showStickyCta"] as const).map((key) => (
            <label key={key} className="flex items-center justify-between gap-3 text-xs font-semibold">
              <span>{t(`studio.${key}`)}</span>
              <span className={`relative h-6 w-11 rounded-full transition-colors ${design[key] ? "bg-primary" : "bg-muted"}`}>
                <input type="checkbox" checked={design[key]} disabled={!canManage}
                  onChange={(e) => setDesign((v) => ({ ...v, [key]: e.currentTarget.checked }))}
                  className="peer sr-only" />
                <span className={`absolute top-1 size-4 rounded-full bg-white shadow transition-transform ${design[key] ? "start-6" : "start-1"}`} />
              </span>
            </label>
          ))}
        </SettingSection>

        <SettingSection title={t("studio.layout_section")} open>
          {(["imageGap", "sidePadding", "contentMaxWidth"] as const).map((key) => {
            const value = key === "imageGap" ? imageGap : design[key];
            const max = key === "contentMaxWidth" ? 1200 : 96;
            const setValue = (next: number) => key === "imageGap"
              ? setImageGap(next)
              : setDesign((v) => ({ ...v, [key]: next }));
            return (
              <label key={key} className="block">
                <span className="mb-2 flex items-center justify-between text-xs font-semibold">
                  {t(`studio.${key}`)}
                  <input type="number" min={0} max={max} value={value} disabled={!canManage}
                    onChange={(e) => setValue(Math.max(0, Math.min(max, Number(e.currentTarget.value))))}
                    className="h-7 w-20 rounded-md border border-border bg-background px-2 text-end text-xs tabular-nums" />
                </span>
                <input type="range" min={0} max={max} value={value} disabled={!canManage}
                  onChange={(e) => setValue(Number(e.currentTarget.value))}
                  className="w-full accent-primary" />
              </label>
            );
          })}
        </SettingSection>

        <SettingSection title={t("studio.colors_section")}>
          {(["backgroundColor", "buttonColor", "buttonTextColor"] as const).map((key) => (
            <label key={key} className="flex items-center justify-between gap-3 text-xs font-semibold">
              <span>{t(`studio.${key}`)}</span>
              <span className="flex items-center gap-2 rounded-lg border border-border bg-background p-1.5">
                <input type="color" value={design[key]} disabled={!canManage}
                  onChange={(e) => setDesign((v) => ({ ...v, [key]: e.currentTarget.value }))}
                  className="size-6 cursor-pointer rounded border-0 bg-transparent p-0" />
                <span className="w-[4.5rem] font-mono text-[10px] uppercase text-muted-foreground">{design[key]}</span>
              </span>
            </label>
          ))}
        </SettingSection>

        <SettingSection title={t("studio.button_section")}>
          <label className="block">
            <span className="mb-2 flex items-center justify-between text-xs font-semibold">
              {t("studio.buttonRadius")}
              <span className="tabular-nums text-muted-foreground">{design.buttonRadius}px</span>
            </span>
            <input type="range" min={0} max={50} value={design.buttonRadius} disabled={!canManage}
              onChange={(e) => setDesign((v) => ({ ...v, buttonRadius: Number(e.currentTarget.value) }))}
              className="w-full accent-primary" />
          </label>
          <div className="h-10 text-center text-xs font-bold leading-10 shadow-sm"
            style={{ backgroundColor: design.buttonColor, color: design.buttonTextColor, borderRadius: design.buttonRadius }}>
            {t("studio.order_button_preview")}
          </div>
        </SettingSection>

        <SettingSection title={t("studio.page_health")}>
          <div className="space-y-2 text-xs">
            {[
              [lp.images.length > 0, t("studio.health_images")],
              [Boolean(lp.product), t("studio.health_product")],
              [Boolean(lp.metaTitle), t("studio.health_seo")],
              [isPublished, t("studio.health_published")],
            ].map(([done, label]) => (
              <div key={String(label)} className="flex items-center gap-2">
                <span className={`grid size-5 place-items-center rounded-full ${done ? "bg-emerald-500/15 text-emerald-600" : "bg-muted text-muted-foreground"}`}>
                  {done ? <Check size={12} /> : <span className="size-1.5 rounded-full bg-current" />}
                </span>
                <span className={done ? "font-semibold" : "text-muted-foreground"}>{String(label)}</span>
              </div>
            ))}
          </div>
        </SettingSection>

        <div className="mt-auto space-y-3 border-t border-border p-4">
          <Button type="button" variant="secondary" className="w-full" disabled={!canManage}
            onClick={() => {
              setImageGap(0);
              setDesign({ sidePadding: 0, contentMaxWidth: 0, showImages: true, showOrderForm: true,
                showStickyCta: true, backgroundColor: "#ffffff", buttonColor: "#7c3aed",
                buttonTextColor: "#ffffff", buttonRadius: 12 });
            }}>
            <RotateCcw size={14} /> {t("studio.reset_design")}
          </Button>
          <div className="rounded-xl border border-border bg-muted/30 p-3">
            <dl className="space-y-1.5 text-xs">
              <div className="flex justify-between"><dt className="text-muted-foreground">{t("list.views")}</dt><dd className="font-bold tabular-nums">{lp.views.toLocaleString()}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">{t("list.orders")}</dt><dd className="font-bold tabular-nums">{lp.stats.orders.toLocaleString()}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">{t("list.revenue")}</dt><dd className="font-bold tabular-nums">{lp.stats.revenue.toLocaleString()}</dd></div>
            </dl>
          </div>
        </div>
      </aside>
    </StudioShell>
  );
}

export default function LandingPageStudioApp({ landingPageId }: { landingPageId: string }) {
  return (
    <RequireAuth>
      <Gated landingPageId={landingPageId} />
    </RequireAuth>
  );
}
