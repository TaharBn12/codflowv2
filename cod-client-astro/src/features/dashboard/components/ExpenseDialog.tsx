import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button, Dialog, Field, Input, Select, Textarea } from "@/components/ui";
import { useT } from "@/i18n/react";
import { notify } from "@/lib/notify";
import { AD_PLATFORMS, EXPENSE_CATEGORIES, type ExpenseCategory } from "../../../../../cod-shared/db/schema";
import type { ExpenseInput, ExpenseRecord } from "../../../../../cod-shared/queries/analytics";
import { createExpense, updateExpense } from "../api";
import { toLocalDateInput } from "../model";

export interface ExpenseDialogProps {
  open: boolean;
  onClose: () => void;
  onSaved: (record: ExpenseRecord) => void;
  /** Existing record to edit; omit to create. */
  expense?: ExpenseRecord | null;
  /** Preselected category when creating (e.g. "ads" from the ROAS widget). */
  defaultCategory?: ExpenseCategory;
  landingPages?: Array<{ id: string; name: string }>;
}

export function ExpenseDialog({ open, onClose, onSaved, expense, defaultCategory = "ads", landingPages = [] }: ExpenseDialogProps) {
  const t = useT("dashboard");
  const common = useT("common");
  const [date, setDate] = useState(toLocalDateInput(new Date().toISOString()));
  const [category, setCategory] = useState<ExpenseCategory>(defaultCategory);
  const [platform, setPlatform] = useState<string>("meta");
  const [amount, setAmount] = useState("");
  const [landingPageId, setLandingPageId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (expense) {
      setDate(expense.date);
      setCategory(expense.category);
      setPlatform(expense.platform ?? "meta");
      setAmount(String(expense.amount));
      setLandingPageId(expense.landingPageId ?? "");
      setNote(expense.note ?? "");
    } else {
      setDate(toLocalDateInput(new Date().toISOString()));
      setCategory(defaultCategory);
      setPlatform("meta");
      setAmount("");
      setLandingPageId("");
      setNote("");
    }
  }, [open, expense, defaultCategory]);

  async function submit(event: { preventDefault(): void }) {
    event.preventDefault();
    const numeric = Number(amount);
    if (!date || !Number.isFinite(numeric) || numeric < 0) {
      setError(t("expenses.invalid_amount"));
      return;
    }
    const payload: ExpenseInput = {
      date,
      category,
      platform: category === "ads" ? platform : null,
      amount: Math.round(numeric),
      landingPageId: landingPageId || null,
      note: note.trim() || null,
    };
    setBusy(true);
    setError(null);
    try {
      const record = expense ? await updateExpense(expense.id, payload) : await createExpense(payload);
      notify.success(t("expenses.saved"));
      onSaved(record);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : common("error_occurred"));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={expense ? t("expenses.edit_title") : t("expenses.add_title")}
      description={t("expenses.dialog_description")}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            {common("cancel")}
          </Button>
          <Button type="submit" form="expense-form" disabled={busy}>
            {busy && <Loader2 size={14} className="animate-spin" />}
            {t("expenses.save")}
          </Button>
        </div>
      }
    >
      <form id="expense-form" onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("expenses.date")}>
            <Input type="date" value={date} onChange={(event) => setDate(event.currentTarget.value)} required />
          </Field>
          <Field label={t("expenses.amount")}>
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              value={amount}
              onChange={(event) => setAmount(event.currentTarget.value)}
              placeholder="0"
              dir="ltr"
              required
            />
          </Field>
          <Field label={t("expenses.category")}>
            <Select value={category} onChange={(event) => setCategory(event.currentTarget.value as ExpenseCategory)}>
              {EXPENSE_CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {t(`expenses.categories.${value}`)}
                </option>
              ))}
            </Select>
          </Field>
          {category === "ads" && (
            <Field label={t("expenses.platform")}>
              <Select value={platform} onChange={(event) => setPlatform(event.currentTarget.value)}>
                {AD_PLATFORMS.map((value) => (
                  <option key={value} value={value}>
                    {t(`expenses.platforms.${value}`)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {landingPages.length > 0 && (
            <Field label={t("expenses.landing_page")} hint={t("expenses.landing_page_hint")}>
              <Select value={landingPageId} onChange={(event) => setLandingPageId(event.currentTarget.value)}>
                <option value="">{t("expenses.all_landing_pages")}</option>
                {landingPages.map((page) => (
                  <option key={page.id} value={page.id}>
                    {page.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        <Field label={t("expenses.note")}>
          <Textarea value={note} onChange={(event) => setNote(event.currentTarget.value)} maxLength={500} rows={2} className="min-h-16" />
        </Field>
        {error && <p className="text-sm font-medium text-destructive">{error}</p>}
      </form>
    </Dialog>
  );
}
