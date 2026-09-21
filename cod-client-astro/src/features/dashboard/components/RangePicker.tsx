import { useState } from "react";
import { CalendarDays } from "lucide-react";
import { Input, Select } from "@/components/ui";
import { useT } from "@/i18n/react";
import { RANGE_PRESETS, resolveRange, toLocalDateInput, type DateRange, type RangePreset } from "../model";

export function RangePicker({ range, onChange }: { range: DateRange; onChange: (range: DateRange) => void }) {
  const t = useT("dashboard");
  const [customFrom, setCustomFrom] = useState(toLocalDateInput(range.from));
  const [customTo, setCustomTo] = useState(toLocalDateInput(new Date(new Date(range.to).getTime() - 1).toISOString()));

  function applyPreset(preset: RangePreset) {
    if (preset === "custom") {
      onChange(resolveRange("custom", new Date(), { from: customFrom, to: customTo }));
    } else {
      onChange(resolveRange(preset));
    }
  }

  function applyCustom(from: string, to: string) {
    setCustomFrom(from);
    setCustomTo(to);
    if (from && to) onChange(resolveRange("custom", new Date(), { from, to }));
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        aria-label={t("range.label")}
        value={range.preset}
        onChange={(event) => applyPreset(event.currentTarget.value as RangePreset)}
        prefix={<CalendarDays size={15} />}
        size="sm"
      >
        {RANGE_PRESETS.map((preset) => (
          <option key={preset} value={preset}>
            {t(`range.${preset}`)}
          </option>
        ))}
      </Select>
      {range.preset === "custom" && (
        <div className="flex items-center gap-1.5">
          <Input
            type="date"
            aria-label={t("range.from")}
            value={customFrom}
            max={customTo || undefined}
            onChange={(event) => applyCustom(event.currentTarget.value, customTo)}
            className="h-8 w-[150px] py-1 text-xs"
          />
          <span className="text-xs text-muted-foreground">→</span>
          <Input
            type="date"
            aria-label={t("range.to")}
            value={customTo}
            min={customFrom || undefined}
            onChange={(event) => applyCustom(customFrom, event.currentTarget.value)}
            className="h-8 w-[150px] py-1 text-xs"
          />
        </div>
      )}
    </div>
  );
}
