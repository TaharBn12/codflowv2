import { useEffect, useState } from "react";
import { CheckCircle2, Copy, Eye, EyeOff, Loader2, Mail, MessageCircle, Plus, RefreshCw, Send, TicketCheck } from "lucide-react";
import { DashboardChrome } from "@/components/layout/chrome";
import { Alert, Button, Card, EmptyState, Input, PageHeader, Select } from "@/components/ui";
import { RequireAuth, useIdentity } from "@/features/auth/components/RequireAuth";
import { useT } from "@/i18n/react";
import { notify } from "@/lib/notify";
import { createConversation, createTicket, listChannels, listConversations, listMessages, listTickets, saveChannel, sendMessage, updateConversation, updateTicket, type Conversation, type SupportChannel, type SupportMessage, type SupportTicket } from "../api";

type Tab = "inbox" | "tickets" | "channels";
function SupportContent() {
  const t = useT("support"); const identity = useIdentity(); const isAdmin = identity?.role === "admin";
  const [tab, setTab] = useState<Tab>("inbox"); const [channels, setChannels] = useState<SupportChannel[]>([]); const [conversations, setConversations] = useState<Conversation[]>([]); const [tickets, setTickets] = useState<SupportTicket[]>([]); const [selected, setSelected] = useState<Conversation | null>(null); const [messages, setMessages] = useState<SupportMessage[]>([]); const [draft, setDraft] = useState(""); const [internal, setInternal] = useState(false); const [loading, setLoading] = useState(true); const [error, setError] = useState<string | null>(null);
  const [newConversation, setNewConversation] = useState({ channelId: "", contact: "", contactName: "", subject: "" }); const [showNewConversation, setShowNewConversation] = useState(false); const [newTicket, setNewTicket] = useState({ subject: "", description: "", priority: "normal" }); const [showNewTicket, setShowNewTicket] = useState(false);
  async function load() { setLoading(true); setError(null); try { const [nextChannels, nextConversations, nextTickets] = await Promise.all([listChannels(), listConversations(), listTickets()]); setChannels(nextChannels); setConversations(nextConversations); setTickets(nextTickets); if (!newConversation.channelId && nextChannels[0]) setNewConversation((v) => ({ ...v, channelId: nextChannels[0].id })); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setLoading(false); } }
  useEffect(() => { void load(); }, []);
  async function openConversation(row: Conversation) { setSelected(row); setMessages(await listMessages(row.id)); setConversations((all) => all.map((item) => item.id === row.id ? { ...item, unreadCount: 0 } : item)); }
  async function submitMessage() { if (!selected || !draft.trim()) return; try { const value = await sendMessage(selected.id, draft.trim(), internal); setMessages((all) => [...all, value]); setDraft(""); if (value.deliveryStatus === "failed") notify.error(value.errorCode ?? t("send_failed")); } catch (cause) { notify.error(cause instanceof Error ? cause.message : String(cause)); } }
  async function submitConversation() { if (!newConversation.channelId || !newConversation.contact.trim()) return; const row = await createConversation(newConversation); setConversations((all) => [row, ...all]); setShowNewConversation(false); setNewConversation({ channelId: channels[0]?.id ?? "", contact: "", contactName: "", subject: "" }); await openConversation({ ...row, channelType: channels.find((v) => v.id === row.channelId)?.type ?? "email", channelName: channels.find((v) => v.id === row.channelId)?.name ?? "", assigneeName: null } as Conversation); }
  async function submitTicket() { if (!newTicket.subject.trim()) return; const row = await createTicket({ ...newTicket, conversationId: selected?.id }); setTickets((all) => [row, ...all]); setShowNewTicket(false); setNewTicket({ subject: "", description: "", priority: "normal" }); notify.success(t("ticket_created")); }
  return <div className="space-y-6"><PageHeader title={t("title")} subtitle={t("description")} actions={<Button variant="secondary" onClick={() => void load()} disabled={loading}><RefreshCw size={16}/>{t("refresh")}</Button>} />
    {error && <Alert tone="critical">{error}</Alert>}
    <div className="flex gap-2 border-b border-border">{(["inbox", "tickets", "channels"] as Tab[]).map((value) => <button key={value} type="button" onClick={() => setTab(value)} className={`border-b-2 px-4 py-3 text-sm font-semibold ${tab === value ? "border-primary text-primary" : "border-transparent text-muted-foreground"}`}>{t(value)}</button>)}</div>
    {tab === "inbox" && <div className="grid min-h-[620px] overflow-hidden rounded-xl border border-border bg-card lg:grid-cols-[320px_1fr]">
      <aside className="border-e border-border"><div className="flex items-center justify-between border-b p-3"><b>{t("conversations")}</b><Button size="sm" onClick={() => setShowNewConversation((v) => !v)}><Plus size={14}/></Button></div>
        {showNewConversation && <div className="space-y-2 border-b p-3"><Select value={newConversation.channelId} onChange={(e) => setNewConversation({ ...newConversation, channelId: e.target.value })}>{channels.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select><Input placeholder={t("contact")} value={newConversation.contact} onChange={(e) => setNewConversation({ ...newConversation, contact: e.currentTarget.value })}/><Input placeholder={t("contact_name")} value={newConversation.contactName} onChange={(e) => setNewConversation({ ...newConversation, contactName: e.currentTarget.value })}/><Input placeholder={t("subject")} value={newConversation.subject} onChange={(e) => setNewConversation({ ...newConversation, subject: e.currentTarget.value })}/><Button className="w-full" onClick={() => void submitConversation()}>{t("create")}</Button></div>}
        <div className="max-h-[560px] overflow-y-auto divide-y">{conversations.map((row) => <button key={row.id} onClick={() => void openConversation(row)} className={`w-full p-4 text-start hover:bg-muted/50 ${selected?.id === row.id ? "bg-primary/5" : ""}`}><div className="flex items-center gap-2">{row.channelType === "whatsapp" ? <MessageCircle size={15} className="text-emerald-600"/> : <Mail size={15} className="text-blue-600"/>}<b className="truncate text-sm">{row.contactName || row.contact}</b>{row.unreadCount > 0 && <span className="ms-auto rounded-full bg-primary px-2 py-0.5 text-[10px] text-primary-foreground">{row.unreadCount}</span>}</div><p className="mt-1 truncate text-xs text-muted-foreground">{row.subject || row.contact}</p></button>)}</div></aside>
      <section className="flex min-h-[620px] flex-col">{!selected ? <div className="grid flex-1 place-items-center"><EmptyState icon={<MessageCircle/>} title={t("select_conversation")}/></div> : <><header className="flex flex-wrap items-center gap-3 border-b p-4"><div className="flex-1"><b>{selected.contactName || selected.contact}</b><p className="text-xs text-muted-foreground">{selected.channelName} · {selected.contact}</p></div><Select value={selected.status} onChange={async (e) => { const status = e.target.value as Conversation["status"]; await updateConversation(selected.id, { status }); setSelected({ ...selected, status }); }}><option value="open">{t("status_open")}</option><option value="pending">{t("status_pending")}</option><option value="resolved">{t("status_resolved")}</option><option value="closed">{t("status_closed")}</option></Select><Button variant="secondary" onClick={() => { setNewTicket((v) => ({ ...v, subject: selected.subject || `${t("ticket_for")} ${selected.contactName || selected.contact}` })); setShowNewTicket(true); setTab("tickets"); }}><TicketCheck size={15}/>{t("create_ticket")}</Button></header><div className="flex-1 space-y-3 overflow-y-auto bg-muted/20 p-4">{messages.map((message) => <div key={message.id} className={`max-w-[80%] rounded-xl p-3 text-sm ${message.direction === "inbound" ? "bg-card border" : message.direction === "internal" ? "ms-auto bg-amber-100 text-amber-950" : "ms-auto bg-primary text-primary-foreground"}`}><p className="whitespace-pre-wrap">{message.body}</p><p className="mt-1 text-[10px] opacity-60">{message.deliveryStatus} · {new Date(message.createdAt).toLocaleString()}</p></div>)}</div><footer className="border-t p-3"><textarea className="min-h-20 w-full rounded-md border border-input bg-background p-3 text-sm" value={draft} onChange={(e) => setDraft(e.currentTarget.value)} placeholder={t("reply_placeholder")}/><div className="mt-2 flex items-center justify-between"><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.currentTarget.checked)}/>{t("internal_note")}</label><Button onClick={() => void submitMessage()} disabled={!draft.trim()}><Send size={15}/>{t("send")}</Button></div></footer></>}</section></div>}
    {tab === "tickets" && <div className="space-y-4"><div className="flex justify-end"><Button onClick={() => setShowNewTicket((v) => !v)}><Plus size={15}/>{t("new_ticket")}</Button></div>{showNewTicket && <Card className="grid gap-3 p-4 md:grid-cols-2"><Input placeholder={t("subject")} value={newTicket.subject} onChange={(e) => setNewTicket({ ...newTicket, subject: e.currentTarget.value })}/><Select value={newTicket.priority} onChange={(e) => setNewTicket({ ...newTicket, priority: e.target.value })}><option value="low">{t("priority_low")}</option><option value="normal">{t("priority_normal")}</option><option value="high">{t("priority_high")}</option><option value="urgent">{t("priority_urgent")}</option></Select><textarea className="min-h-24 rounded-md border border-input bg-background p-3 md:col-span-2" placeholder={t("description_label")} value={newTicket.description} onChange={(e) => setNewTicket({ ...newTicket, description: e.currentTarget.value })}/><Button onClick={() => void submitTicket()}>{t("create")}</Button></Card>}<div className="grid gap-3">{tickets.map((ticket) => <Card key={ticket.id} className="flex flex-col gap-3 p-4 md:flex-row md:items-center"><div className="flex-1"><p className="text-xs font-semibold text-primary">{ticket.ticketNumber}</p><b>{ticket.subject}</b><p className="text-xs text-muted-foreground">{ticket.assigneeName || t("unassigned")} · {t(`priority_${ticket.priority}`)}</p></div><Select value={ticket.status} onChange={async (e) => { const status = e.target.value as SupportTicket["status"]; await updateTicket(ticket.id, { status }); setTickets((all) => all.map((v) => v.id === ticket.id ? { ...v, status } : v)); }}><option value="open">{t("status_open")}</option><option value="in_progress">{t("status_in_progress")}</option><option value="waiting_customer">{t("status_waiting_customer")}</option><option value="resolved">{t("status_resolved")}</option><option value="closed">{t("status_closed")}</option></Select></Card>)}</div></div>}
    {tab === "channels" && <div className="grid gap-4 lg:grid-cols-2">{channels.map((channel) => <ChannelCard key={channel.id} value={channel} onSaved={(next) => setChannels((all) => all.map((v) => v.id === next.id ? next : v))} />)}{channels.length < 2 && isAdmin && (["whatsapp", "email"] as const).filter((type) => !channels.some((v) => v.type === type)).map((type) => <ChannelCard key={type} value={{ id: type, type, name: type === "whatsapp" ? "WhatsApp" : "Email", provider: type === "whatsapp" ? "meta_cloud" : "sendili", enabled: false, senderId: null, accessTokenMasked: "", verifyTokenMasked: "", appSecretMasked: "", webhookSecretMasked: "", updatedAt: "", webhookUrl: "" }} onSaved={(next) => setChannels((all) => [...all, next])}/>)}</div>}
  </div>;
}
function ChannelSwitch({ checked, disabled, label, onChange }: { checked: boolean; disabled?: boolean; label: string; onChange: (value: boolean) => void }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} className={`relative h-7 w-12 shrink-0 rounded-full border-2 border-transparent transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 ${checked ? "bg-brand" : "bg-muted-foreground/35"}`}><span className={`absolute left-0.5 top-0.5 size-5 rounded-full shadow-sm transition-transform ${checked ? "translate-x-5 bg-brand-foreground" : "translate-x-0 bg-background"}`} /></button>;
}

function ChannelCard({ value, onSaved }: { value: SupportChannel; onSaved: (value: SupportChannel) => void }) {
  const t = useT("support");
  const isWhatsApp = value.type === "whatsapp";
  const [form, setForm] = useState({
    name: value.name,
    provider: value.provider,
    senderId: value.senderId ?? "",
    enabled: value.enabled,
    accessToken: "",
    verifyToken: value.verifyTokenMasked ? "" : crypto.randomUUID().replaceAll("-", ""),
    appSecret: "",
    webhookSecret: "",
  });
  const [showSecrets, setShowSecrets] = useState(false);
  const [saving, setSaving] = useState(false);

  const configured = isWhatsApp
    ? Boolean(form.senderId && (form.accessToken || value.accessTokenMasked) && (form.appSecret || value.appSecretMasked) && (form.verifyToken || value.verifyTokenMasked))
    : Boolean(form.webhookSecret || value.webhookSecretMasked);

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    notify.success(t("copied"));
  }

  async function save() {
    if (form.enabled && !configured) {
      notify.error(t(isWhatsApp ? "whatsapp_required" : "email_required"));
      return;
    }
    setSaving(true);
    try {
      const next = await saveChannel(value.type, form);
      onSaved(next);
      setForm((current) => ({ ...current, accessToken: "", appSecret: "", webhookSecret: "" }));
      notify.success(t("channel_saved"));
    } catch (cause) {
      notify.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return <Card className="overflow-hidden p-0">
    <div className="flex items-center gap-3 border-b border-border p-5">
      <span className={`grid size-10 place-items-center rounded-xl ${isWhatsApp ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-blue-500/10 text-blue-600 dark:text-blue-400"}`}>
        {isWhatsApp ? <MessageCircle size={20} /> : <Mail size={20} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2"><b>{isWhatsApp ? "WhatsApp" : t("email_channel")}</b><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${form.enabled ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-muted text-muted-foreground"}`}>{t(form.enabled ? "connected" : "disabled")}</span></div>
        <p className="text-xs text-muted-foreground">{t(isWhatsApp ? "whatsapp_setup_hint" : "email_setup_hint")}</p>
      </div>
      <ChannelSwitch checked={form.enabled} disabled={saving} label={t("enable_channel")} onChange={(enabled) => setForm((current) => ({ ...current, enabled }))} />
    </div>

    <div className="space-y-4 p-5">
      {isWhatsApp ? <>
        <div className="rounded-lg border border-brand/20 bg-brand/5 p-3 text-xs text-muted-foreground">
          <p className="font-bold text-foreground">{t("whatsapp_quick_setup")}</p>
          <ol className="mt-2 list-decimal space-y-1 ps-5"><li>{t("whatsapp_step_credentials")}</li><li>{t("whatsapp_step_save")}</li><li>{t("whatsapp_step_webhook")}</li></ol>
        </div>
        <label className="space-y-1.5"><span className="text-xs font-semibold">{t("phone_number_id")}</span><Input dir="ltr" value={form.senderId} onChange={(e) => setForm({ ...form, senderId: e.currentTarget.value })} placeholder="123456789012345" /></label>
        <label className="space-y-1.5"><span className="text-xs font-semibold">{t("access_token")}</span><div className="relative"><Input type={showSecrets ? "text" : "password"} dir="ltr" value={form.accessToken} onChange={(e) => setForm({ ...form, accessToken: e.currentTarget.value })} placeholder={value.accessTokenMasked || t("access_token")} className="pe-10" /><button type="button" onClick={() => setShowSecrets((current) => !current)} className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground">{showSecrets ? <EyeOff size={15} /> : <Eye size={15} />}</button></div></label>
        <label className="space-y-1.5"><span className="text-xs font-semibold">{t("app_secret")}</span><Input type={showSecrets ? "text" : "password"} dir="ltr" value={form.appSecret} onChange={(e) => setForm({ ...form, appSecret: e.currentTarget.value })} placeholder={value.appSecretMasked || t("app_secret")} /></label>
        <label className="space-y-1.5"><span className="text-xs font-semibold">{t("verify_token")}</span><div className="flex gap-2"><Input dir="ltr" value={form.verifyToken} onChange={(e) => setForm({ ...form, verifyToken: e.currentTarget.value })} placeholder={value.verifyTokenMasked || t("verify_token")} /><Button type="button" variant="secondary" size="sm" disabled={!form.verifyToken} onClick={() => void copy(form.verifyToken)}><Copy size={14} /></Button></div><span className="block text-[11px] text-muted-foreground">{t("verify_token_hint")}</span></label>
      </> : <>
        <label className="space-y-1.5"><span className="text-xs font-semibold">{t("channel_name")}</span><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} /></label>
        <label className="space-y-1.5"><span className="text-xs font-semibold">{t("webhook_secret")}</span><Input type={showSecrets ? "text" : "password"} dir="ltr" value={form.webhookSecret} onChange={(e) => setForm({ ...form, webhookSecret: e.currentTarget.value })} placeholder={value.webhookSecretMasked || t("webhook_secret")} /></label>
      </>}

      {value.webhookUrl && <div className="rounded-lg bg-muted p-3"><p className="text-xs font-semibold">{t("webhook_url")}</p><div className="mt-2 flex items-center gap-2"><code dir="ltr" className="min-w-0 flex-1 break-all text-xs">{value.webhookUrl}</code><button type="button" onClick={() => void copy(value.webhookUrl)} className="text-muted-foreground hover:text-foreground"><Copy size={15} /></button></div></div>}
      <Button className="w-full" onClick={() => void save()} disabled={saving}>{saving ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}{saving ? t("saving_channel") : t(form.enabled ? "save_and_activate" : "save_channel")}</Button>
    </div>
  </Card>;
}
export default function SupportPageApp() { return <RequireAuth><DashboardChrome currentPath="/support"><SupportContent/></DashboardChrome></RequireAuth>; }
