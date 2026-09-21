import type { DragEvent, ReactNode } from "react";
import { AlertCircle, ArrowDown, ArrowUp, Eye, EyeOff, GripVertical, RefreshCw } from "lucide-react";
import { Button, Skeleton } from "@/components/ui";
import { useT } from "@/i18n/react";
import type { WidgetId } from "../model";

export interface WidgetChrome {
  customizing: boolean;
  index: number;
  count: number;
  hidden: boolean;
  onMove: (from: number, to: number) => void;
  onToggle: (id: WidgetId) => void;
}

const DRAG_MIME = "application/x-codflow-widget";

/**
 * Card shell shared by every dashboard widget: title row, optional action
 * slot, loading / error states and the customize-mode controls (drag handle,
 * move up/down, hide/show).
 */
export function WidgetFrame({
  id,
  title,
  subtitle,
  action,
  chrome,
  loading = false,
  skeleton = false,
  error = null,
  onRetry,
  flush = false,
  className = "",
  children,
}: {
  id: WidgetId;
  title: string;
  subtitle?: string;
  action?: ReactNode;
  chrome: WidgetChrome;
  loading?: boolean;
  /** True while the very first load is pending — renders a skeleton. */
  skeleton?: boolean;
  error?: Error | null;
  onRetry?: () => void;
  flush?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const t = useT("dashboard");
  const common = useT("common");
  const { customizing, index, count, hidden, onMove, onToggle } = chrome;

  function handleDragStart(event: DragEvent<HTMLElement>) {
    event.dataTransfer.setData(DRAG_MIME, String(index));
    event.dataTransfer.effectAllowed = "move";
  }
  function handleDrop(event: DragEvent<HTMLElement>) {
    const raw = event.dataTransfer.getData(DRAG_MIME);
    if (!raw) return;
    event.preventDefault();
    const from = Number(raw);
    if (!Number.isNaN(from)) onMove(from, index);
  }

  return (
    <section
      data-widget={id}
      draggable={customizing}
      onDragStart={customizing ? handleDragStart : undefined}
      onDragOver={customizing ? (event) => event.preventDefault() : undefined}
      onDrop={customizing ? handleDrop : undefined}
      className={`relative flex min-w-0 flex-col rounded-xl border bg-card shadow-xs transition-shadow ${
        customizing ? "cursor-grab border-dashed border-brand/50 ring-1 ring-brand/10" : "border-border/80"
      } ${hidden ? "opacity-60" : ""} ${className}`}
    >
      <header className="flex min-h-[48px] flex-wrap items-center justify-between gap-3 border-b border-border/70 px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-2">
          {customizing && <GripVertical size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" />}
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold tracking-tight text-card-foreground">{title}</h2>
            {subtitle && <p className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</p>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {!customizing && action}
          {customizing && (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("customize.move_up")}
                disabled={index === 0}
                onClick={() => onMove(index, index - 1)}
              >
                <ArrowUp size={15} />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("customize.move_down")}
                disabled={index >= count - 1}
                onClick={() => onMove(index, index + 1)}
              >
                <ArrowDown size={15} />
              </Button>
              <Button
                type="button"
                variant={hidden ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={hidden}
                onClick={() => onToggle(id)}
              >
                {hidden ? <Eye size={14} /> : <EyeOff size={14} />}
                {hidden ? t("customize.show") : t("customize.hide")}
              </Button>
            </>
          )}
        </div>
      </header>
      {customizing && hidden ? (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground sm:px-5">{t("customize.hidden_hint")}</p>
      ) : error ? (
        <div className="flex items-start gap-3 px-4 py-6 text-sm sm:px-5">
          <AlertCircle size={18} className="mt-0.5 shrink-0 text-destructive" />
          <div className="min-w-0">
            <p className="font-semibold text-foreground">{common("error_occurred")}</p>
            <p className="mt-1 break-words text-xs text-muted-foreground">{error.message}</p>
            {onRetry && (
              <Button type="button" variant="ghost" size="sm" className="mt-2 px-0" onClick={onRetry}>
                <RefreshCw size={13} />
                {common("retry")}
              </Button>
            )}
          </div>
        </div>
      ) : skeleton ? (
        <div className="space-y-3 p-4 sm:p-5" role="status" aria-busy="true">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <div className={`${flush ? "" : "p-4 sm:p-5"} ${loading ? "opacity-60 transition-opacity" : ""}`} aria-busy={loading}>
          {children}
        </div>
      )}
    </section>
  );
}

export function WidgetSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2.5" role="status" aria-busy="true">
      {Array.from({ length: rows }).map((_, index) => (
        <Skeleton key={index} className="h-8 w-full" />
      ))}
    </div>
  );
}
