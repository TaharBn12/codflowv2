import { useEffect, useMemo, useState } from "react";
import { CheckCheck, Loader2, Search, ShieldCheck, ShieldOff } from "lucide-react";
import { Alert, Button, Card, Input, Select } from "@/components/ui";
import { useT } from "@/i18n/react";
import { notify } from "@/lib/notify";
import { getApprovalPolicies, saveAllApprovalPolicies, saveApprovalPolicy } from "../api";
import type { ApprovalMemberRole, ApprovalPoliciesOverview } from "../types";

function PolicySwitch({ checked, disabled, label, onChange }: { checked: boolean; disabled: boolean; label: string; onChange: (value: boolean) => void }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} className={`relative h-7 w-12 shrink-0 rounded-full border-2 border-transparent transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${checked ? "bg-brand" : "bg-muted-foreground/35"}`}><span className={`absolute left-0.5 top-0.5 size-5 rounded-full shadow-sm transition-transform ${checked ? "translate-x-5 bg-brand-foreground" : "translate-x-0 bg-background"}`} /></button>;
}

export function ApprovalPoliciesSettings() {
  const t = useT("settings");
  const [data, setData] = useState<ApprovalPoliciesOverview | null>(null);
  const [role, setRole] = useState<"all" | ApprovalMemberRole>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setError(null);
      const overview = await getApprovalPolicies();
      setData(overview);
      setSelectedId((current) => current || overview.members[0]?.id || "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  useEffect(() => { void load(); }, []);

  const members = useMemo(() => (data?.members ?? []).filter((member) => (role === "all" || member.role === role) && `${member.name} ${member.email}`.toLowerCase().includes(query.toLowerCase())), [data?.members, role, query]);
  useEffect(() => { if (members.length && !members.some((member) => member.id === selectedId)) setSelectedId(members[0].id); }, [members, selectedId]);
  const selected = data?.members.find((member) => member.id === selectedId);
  const actions = (data?.actions ?? []).filter((action) => selected && action.roles.includes(selected.role));
  const enabled = (action: string) => Boolean(data?.policies.find((policy) => policy.userId === selectedId && policy.action === action)?.enabled ?? (action === "commissions.mark_paid"));

  async function toggle(action: string, value: boolean) {
    if (!data?.canManage || !selectedId) return;
    setBusy(action);
    setData((current) => current ? { ...current, policies: [...current.policies.filter((policy) => !(policy.userId === selectedId && policy.action === action)), { userId: selectedId, action, enabled: value }] } : current);
    try {
      await saveApprovalPolicy(selectedId, action, value);
      notify.success(t("store.approval_policy_saved"));
    } catch (cause) {
      notify.error(cause instanceof Error ? cause.message : String(cause));
      await load();
    } finally { setBusy(null); }
  }

  async function toggleAll(value: boolean) {
    if (!data?.canManage || !selectedId) return;
    setBusy("all");
    try {
      await saveAllApprovalPolicies(selectedId, value);
      setData((current) => current ? { ...current, policies: [...current.policies.filter((policy) => policy.userId !== selectedId), ...actions.map((action) => ({ userId: selectedId, action: action.key, enabled: value }))] } : current);
      notify.success(t(value ? "store.approval_all_enabled" : "store.approval_all_disabled"));
    } catch (cause) { notify.error(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  }

  if (error) return <Alert tone="critical">{error}</Alert>;
  if (!data) return <div className="grid min-h-48 place-items-center"><Loader2 className="animate-spin text-muted-foreground" /></div>;

  const grouped = actions.reduce<Record<string, typeof actions>>((result, action) => { (result[action.category] ??= []).push(action); return result; }, {});
  return <div className="space-y-5">
    <div>
      <h2 className="text-lg font-bold">{t("store.approval_policies_title")}</h2>
      <p className="text-sm text-muted-foreground">{t("store.approval_policies_subtitle")}</p>
    </div>
    {!data.canManage && <Alert tone="warning">{t("store.primary_admin_only")}</Alert>}
    <Card className="space-y-4 p-4">
      <div className="grid gap-3 md:grid-cols-[180px_1fr]">
        <Select value={role} onChange={(event) => setRole(event.currentTarget.value as typeof role)}><option value="all">{t("store.role_all")}</option><option value="admin">{t("store.role_admin")}</option><option value="staff">{t("store.role_staff")}</option><option value="confirmer">{t("store.role_confirmer")}</option><option value="driver">{t("store.role_driver")}</option></Select>
        <div className="relative"><Search size={15} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={t("store.search_employee")} className="ps-9" /></div>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">{members.map((member) => <button key={member.id} type="button" onClick={() => setSelectedId(member.id)} className={`min-w-48 rounded-lg border p-3 text-start transition-colors ${member.id === selectedId ? "border-brand bg-brand/5" : "border-border hover:bg-muted/50"}`}><p className="text-sm font-semibold">{member.name}</p><p className="truncate text-xs text-muted-foreground">{member.email}</p><span className="mt-1 inline-block text-[10px] font-bold uppercase text-brand">{t(`store.role_${member.role}`)}</span></button>)}</div>
    </Card>
    {selected && <>
      <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-bold">{selected.name}</p><p className="text-xs text-muted-foreground">{t("store.approval_employee_hint")}</p></div><div className="flex gap-2"><Button variant="brand" disabled={!data.canManage || busy !== null} onClick={() => void toggleAll(true)}><CheckCheck size={15} />{t("store.enable_all")}</Button><Button variant="secondary" disabled={!data.canManage || busy !== null} onClick={() => void toggleAll(false)}><ShieldOff size={15} />{t("store.disable_all")}</Button></div></div>
      {Object.entries(grouped).map(([category, rows]) => <Card key={category} className="overflow-hidden p-0"><div className="flex items-center gap-2 border-b border-border bg-muted/30 px-4 py-3"><ShieldCheck size={16} className="text-brand" /><h3 className="text-sm font-bold">{t(`store.approval_category_${category}`)}</h3></div><div className="divide-y divide-border">{rows.map((action) => <div key={action.key} className="flex items-center justify-between gap-4 px-4 py-3"><div><p className="text-sm font-semibold">{t(`store.approval_action_${action.key.replaceAll(".", "_")}`)}</p><p className="text-xs text-muted-foreground">{t("store.approval_action_hint")}</p></div><PolicySwitch checked={enabled(action.key)} disabled={!data.canManage || busy !== null} label={action.key} onChange={(value) => void toggle(action.key, value)} /></div>)}</div></Card>)}
    </>}
  </div>;
}
