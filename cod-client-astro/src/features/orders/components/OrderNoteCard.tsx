import { useState } from "react";
import { StickyNote } from "lucide-react";
import { useT } from "@/i18n/react";
import { notify } from "@/lib/notify";
import { Button, Card, Textarea } from "@/components/ui";
import { addOrderNote } from "@/features/orders/api";
import { NOTE_MAX_LENGTH } from "../../../../../cod-shared/lib/order-contact";

export function OrderNoteCard({ orderId }: { orderId: string }) {
  const t = useT("orders");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const value = note.trim();
    if (!value) return;
    setBusy(true);
    try {
      await addOrderNote(orderId, value);
      setNote("");
      notify.success(t("notes.added"));
    } catch {
      notify.error(t("notes.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t("notes.title")}>
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Textarea
          value={note}
          maxLength={NOTE_MAX_LENGTH}
          onChange={(event) => setNote(event.currentTarget.value)}
          placeholder={t("notes.placeholder")}
          aria-label={t("notes.title")}
          className="min-h-20"
          disabled={busy}
        />
        <div className="flex justify-end">
          <Button type="submit" variant="secondary" size="sm" disabled={busy || !note.trim()}>
            <StickyNote size={14} aria-hidden="true" />
            {t("notes.add")}
          </Button>
        </div>
      </form>
    </Card>
  );
}
