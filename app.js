// Sapucaiu no Samba — UI logic and rendering.
//
// No framework: state lives in a couple of plain objects/arrays, render()
// rebuilds the relevant screen's HTML as a string and swaps #app.innerHTML,
// and a single pair of delegated listeners (click + input) dispatches back
// into state changes. db.js does all the talking to Supabase; this file
// never imports @supabase/supabase-js directly.

import * as db from "./db.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const INSTRUMENTS = ["Tamborim", "Caixa", "Repinique", "Surdo 1a", "Surdo 2a", "Surdo 3a", "Agogô", "Chocalho", "Cuíca", "Timbal", "Leiten"];
const LS_KEY = "sapucaiu:memberId";

const MON = ["JAN", "FEB", "MÄR", "APR", "MAI", "JUN", "JUL", "AUG", "SEP", "OKT", "NOV", "DEZ"];
const MON_LONG = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const WD = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const EMPTY_FORM = { title: "", date: "", ankunft: "", show: "", ende: "", place: "", treff: "", maps: "", outfit: "", setlist: "", geral: "" };

const probeLabel = (t) => {
  if (!t.date) return "Datum offen";
  const d = new Date(t.date + "T12:00:00");
  return WD[d.getDay()] + " " + d.getDate() + ". " + MON_LONG[d.getMonth()].slice(0, 3);
};
const joinDot = (...parts) => parts.filter((p) => p && String(p).trim()).join(" · ");
const initials = (n) => n.split(" ").map((p) => p[0]).slice(0, 2).join("");
const hhmm = (t) => (t || "").slice(0, 5); // Postgres `time` comes back as "19:30:00"
// A couple of events got saved with a bare "HH:MM" for `ende` before this
// suffix was added — display them the same as freshly-saved ones instead
// of only fixing it forward.
const withUhr = (t) => (t && t !== "—" && !/uhr\s*$/i.test(t) ? t + " Uhr" : t);
const AV = [
  ["var(--samba-100)", "var(--samba-700)"],
  ["var(--color-accent-2-200)", "var(--color-accent-2-800)"],
  ["var(--color-accent-200)", "var(--color-accent-800)"],
];

function dateParts(iso) {
  if (!iso) return { day: "–", mon: "", dateLabel: "Datum offen" };
  const d = new Date(iso + "T12:00:00");
  return { day: String(d.getDate()), mon: MON[d.getMonth()], dateLabel: WD[d.getDay()] + " " + d.getDate() + ". " + MON_LONG[d.getMonth()] };
}
function isPast(e) {
  if (!e.date) return false;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return new Date(e.date + "T12:00:00") < today;
}

// Minimal HTML-escaping for any text that ultimately comes from a free-text
// field (member signup name, RSVP comment, organizer notes/links) rather
// than a fixed literal in this file.
function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ── style-hover ──────────────────────────────────────────────────────────
// The prototype used a `style-hover` attribute swapped in by its runtime.
// Plain inline styles can't do :hover, and a stylesheet rule alone loses to
// an inline `style=""` on specificity — so hover rules collected per render
// are emitted with `!important` into a single <style> tag.
let hoverRules = [];
let hoverSeq = 0;
function hv(hoverCss) {
  const cls = "hv" + hoverSeq++;
  hoverRules.push(`.${cls}:hover{${hoverCss.split(";").filter(Boolean).map((d) => d.trim() + " !important").join(";")}}`);
  return cls;
}

// ── data cache (loaded from Supabase, kept in sync via optimistic writes +
// the realtime subscription) ────────────────────────────────────────────
let members = [];
let events = [];   // events, each with a nested `.rehearsals` array
let signups = [];  // all event_signups rows
let attendance = []; // all rehearsal_attendance rows
let unsubscribeRealtime = null;

function upsertLocal(arr, row, matchFn) {
  const idx = arr.findIndex(matchFn);
  if (idx >= 0) arr[idx] = { ...arr[idx], ...row };
  else arr.push(row);
}

// ── UI state (screen, drafts, PIN flow — everything else lives in the
// cache above and in Postgres) ──────────────────────────────────────────
let state = {
  boot: "loading", // "loading" | "config" | "error" | "ready"
  banner: null,
  screen: "name", userId: null, query: "", tab: "next", eventId: null,
  newName: "",
  infoOpen: false, ovFilter: "alle",
  pin: "", pinErr: false, pinChecking: false, orgUnlocked: false, orgPin: null, saved: false,
  orgView: "list", orgNew: false, orgEditId: null, form: { ...EMPTY_FORM }, orgEnsaios: [],
};

function setState(patch) {
  const prevScreen = state.screen, prevOrgView = state.orgView;
  const p = typeof patch === "function" ? patch(state) : patch;
  Object.assign(state, p);
  render();
  // Full-screen navigations should land at the top, not wherever the
  // previous (possibly long) screen happened to be scrolled to.
  if (state.screen !== prevScreen || state.orgView !== prevOrgView) window.scrollTo(0, 0);
}

let bannerTimer = null;
function showBanner(msg) {
  clearTimeout(bannerTimer);
  state.banner = msg;
  render();
  bannerTimer = setTimeout(() => { state.banner = null; render(); }, 4500);
}

function me() {
  return members.find((m) => m.id === state.userId) || null;
}
function ev() {
  return events.find((e) => e.id === state.eventId) || events[0]
    || { id: null, title: "", date: null, place: "", treffpunkt: "", maps_url: "", ankunft: "", showtime: "", outfit: "", setlist_url: "", hinweise: "", rehearsals: [] };
}

// A member's most recent Tanz/Bateria + instrument choice from any other
// event — used as the default for an event they haven't answered yet
// ("vorbelegt mit der letzten Wahl der Person").
function lastChoiceFor(memberId, excludeEventId) {
  const mine = signups
    .filter((s) => s.member_id === memberId && s.event_id !== excludeEventId && (s.does_tanz || s.does_bateria))
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  return mine[0] || null;
}
function mySignup(eventId) {
  const existing = signups.find((s) => s.member_id === state.userId && s.event_id === eventId);
  if (existing) return existing;
  const last = lastChoiceFor(state.userId, eventId);
  return { member_id: state.userId, event_id: eventId, response: null, comment: "", does_tanz: !!last?.does_tanz, does_bateria: !!last?.does_bateria, instruments: last?.instruments || [] };
}
function roleLabel(sig) {
  if (!sig) return "noch offen";
  const parts = [];
  if (sig.does_tanz) parts.push("Tanz");
  if (sig.does_bateria) parts.push(sig.instruments?.length ? "Bateria (" + sig.instruments.join(", ") + ")" : "Bateria");
  return parts.length ? parts.join(" · ") : "noch offen";
}

// Two rapid edits to the same row (e.g. toggling "Bateria" right after
// setting the RSVP) fire two overlapping writes; their server responses can
// come back out of order. A per-key sequence number makes a response from
// an earlier request a no-op once a newer edit has already superseded it,
// instead of silently reverting the row to a stale state.
const writeSeq = {};
function nextSeq(key) { return (writeSeq[key] = (writeSeq[key] || 0) + 1); }

function patchMySignup(patch) {
  if (!state.userId || !state.eventId) return;
  const key = state.userId + ":" + state.eventId;
  const merged = { ...mySignup(state.eventId), ...patch };
  upsertLocal(signups, merged, (s) => s.member_id === merged.member_id && s.event_id === merged.event_id);
  render();
  const seq = nextSeq(key);
  db.upsertSignup(merged)
    .then((saved) => {
      if (writeSeq[key] !== seq) return; // a newer edit already superseded this response
      upsertLocal(signups, saved, (s) => s.member_id === saved.member_id && s.event_id === saved.event_id);
      render();
    })
    .catch((err) => { console.error(err); showBanner("Antwort konnte nicht gespeichert werden – bitte Verbindung prüfen."); });
}

function myAttendance(rehearsalId) {
  const row = attendance.find((a) => a.member_id === state.userId && a.rehearsal_id === rehearsalId);
  return row ? row.response : null;
}
function setAttendance(rehearsalId, response) {
  if (!state.userId) return;
  const key = state.userId + ":" + rehearsalId;
  const row = { member_id: state.userId, rehearsal_id: rehearsalId, response };
  upsertLocal(attendance, row, (a) => a.member_id === row.member_id && a.rehearsal_id === row.rehearsal_id);
  render();
  const seq = nextSeq(key);
  db.upsertAttendance(row)
    .then((saved) => {
      if (writeSeq[key] !== seq) return;
      upsertLocal(attendance, saved, (a) => a.member_id === saved.member_id && a.rehearsal_id === saved.rehearsal_id);
      render();
    })
    .catch((err) => { console.error(err); showBanner("Probenantwort konnte nicht gespeichert werden."); });
}

function formFrom(e) {
  return {
    title: e.title || "", date: e.date || "", ankunft: hhmm(e.ankunft), show: hhmm(e.showtime),
    ende: hhmm(e.ende), place: e.place || "", treff: e.treffpunkt || "", maps: e.maps_url || "",
    geral: e.hinweise || "", outfit: e.outfit || "", setlist: e.setlist_url || "",
  };
}

async function commitEvent() {
  const f = state.form;
  const payload = {
    id: state.orgNew ? null : state.orgEditId,
    title: f.title.trim() || "Neues Event", date: f.date || null,
    place: f.place.trim(), treffpunkt: f.treff.trim(), maps_url: f.maps.trim(),
    ankunft: f.ankunft ? f.ankunft + " Uhr" : "—", showtime: f.show ? f.show + " Uhr" : "—", ende: f.ende ? f.ende + " Uhr" : "—",
    outfit: f.outfit.trim(), setlist_url: f.setlist.trim(), hinweise: f.geral.trim(),
  };
  const rehearsals = state.orgEnsaios.map((t) => ({ date: t.date || null, time: t.time || null, place: t.place || "" }));
  try {
    const saved = await db.organizerSaveEvent(state.orgPin, payload, rehearsals);
    events = await db.listEvents();
    setState({ orgNew: false, orgEditId: saved.id, saved: true });
  } catch (err) {
    console.error(err);
    showBanner("Event konnte nicht gespeichert werden — falscher PIN oder keine Verbindung.");
  }
}

async function deleteEvent(id) {
  try {
    await db.organizerDeleteEvent(state.orgPin, id);
    events = await db.listEvents();
    signups = await db.listSignups();
    attendance = await db.listAttendance();
    setState({ orgView: "list", orgEditId: null, saved: false, eventId: state.eventId === id ? null : state.eventId });
  } catch (err) {
    console.error(err);
    showBanner("Event konnte nicht gelöscht werden — falscher PIN oder keine Verbindung.");
  }
}

// ── shared style helpers (identical logic to the prototype) ────────────────
function bigBtn(active, tone) {
  const bg = { ja: "var(--color-accent-2)", nein: "var(--color-neutral-700)", viel: "var(--samba)" }[tone];
  const fg = tone === "viel" ? "var(--samba-700)" : "#fff";
  return "min-height:62px;border-radius:22px;cursor:pointer;font-family:'Caprasimo',serif;font-size:16px;line-height:1.1;"
    + (active
      ? `background:${bg};color:${tone === "viel" ? "#3a2905" : fg};border:2px solid ${bg};box-shadow:var(--shadow-md)`
      : `background:transparent;color:var(--color-text);border:2px solid var(--color-divider)`);
}
function miniBtn(active, tone) {
  const bg = { ja: "var(--color-accent-2)", nein: "var(--color-neutral-700)", viel: "var(--samba)" }[tone];
  return "width:34px;height:34px;border-radius:999px;cursor:pointer;font:600 13px 'Figtree',system-ui;"
    + (active ? `background:${bg};color:${tone === "viel" ? "#3a2905" : "#fff"};border:1.5px solid ${bg}`
      : "background:transparent;color:var(--color-neutral-700);border:1.5px solid var(--color-divider)");
}
function pillTab(active) {
  return "min-height:38px;border-radius:999px;cursor:pointer;font:600 13.5px 'Figtree',system-ui;border:none;"
    + (active ? "background:var(--color-bg);color:var(--color-text);box-shadow:var(--shadow-sm)"
      : "background:transparent;color:var(--color-neutral-700)");
}
function navBtn(active) {
  return "padding:8px 16px;min-height:38px;border-radius:999px;border:none;cursor:pointer;font:600 13px 'Figtree',system-ui;"
    + (active ? "background:var(--color-accent);color:#fff" : "background:var(--color-surface);color:var(--color-neutral-800)");
}
function choiceBtn(active) {
  return "min-height:52px;border-radius:999px;cursor:pointer;font-family:'Caprasimo',serif;font-size:15px;"
    + (active ? "background:var(--color-accent-2);color:#fff;border:2px solid var(--color-accent-2)"
      : "background:transparent;color:var(--color-text);border:2px solid var(--color-divider)");
}

function dot(v) {
  const map = {
    ja: ["var(--color-accent-2)", "#fff", "J", "Ja"],
    nein: ["var(--color-neutral-300)", "var(--color-neutral-800)", "N", "Nein"],
    vielleicht: ["var(--samba)", "#3a2905", "?", "Vielleicht"],
  };
  const c = map[v] || ["transparent", "var(--color-neutral-800)", "–", "Offen"];
  return { mark: c[2], title: c[3], style: `width:24px;height:24px;border-radius:999px;display:grid;place-items:center;font:600 11px 'Figtree',system-ui;background:${c[0]};color:${c[1]};border:1px solid ${v ? "transparent" : "var(--color-divider)"}` };
}
function badge(v) {
  const map = { ja: ["var(--color-accent-2-200)", "var(--color-accent-2-800)", "Ja"], nein: ["var(--color-neutral-200)", "var(--color-neutral-800)", "Nein"], vielleicht: ["var(--samba-100)", "var(--samba-700)", "Vielleicht"] };
  const c = map[v] || ["transparent", "var(--color-neutral-800)", "offen"];
  return { rsvpLabel: c[2], rsvpStyle: `flex:none;padding:4px 11px;border-radius:999px;font:600 11px 'Figtree',system-ui;background:${c[0]};color:${c[1]};border:1px solid ${v ? "transparent" : "var(--color-divider)"}` };
}

// ── derive all display data for the current state ───────────────────────
function computeView() {
  const s = state, e = ev();
  const meRec = me();
  const sig = state.eventId ? mySignup(state.eventId) : null;
  const rsvp = sig?.response || null;
  const role = { tanz: !!sig?.does_tanz, bateria: !!sig?.does_bateria };
  const myInstrs = sig?.instruments || [];
  const myMeta = roleLabel(sig);
  const q = s.query.trim().toLowerCase();

  const memberList = members.map((m) => ({ id: m.id, name: m.name, initials: initials(m.name) }));
  const filteredMembers = (q ? memberList.filter((m) => m.name.toLowerCase().indexOf(q) >= 0) : memberList)
    .map((m, idx) => ({ ...m, avatarBg: AV[idx % 3][0], avatarFg: AV[idx % 3][1] }));

  const jaCount = (eventId) => signups.filter((s2) => s2.event_id === eventId && s2.response === "ja").length;
  const shownEvents = events.filter((e2) => (s.tab === "next" ? !isPast(e2) : isPast(e2))).map((e2) => {
    const dp = dateParts(e2.date);
    return { id: e2.id, day: dp.day, mon: dp.mon, title: e2.title, meta: joinDot(dp.dateLabel, e2.place),
      pct: Math.round((jaCount(e2.id) / Math.max(members.length, 1)) * 100) + "%",
      summary: jaCount(e2.id) + "/" + members.length + " Ja",
      dateBg: isPast(e2) ? "var(--color-neutral-300)" : "var(--samba)",
      dateFg: isPast(e2) ? "var(--color-neutral-800)" : "#3a2905" };
  });

  const ensaios = (e.rehearsals || []).map((t) => {
    const v = myAttendance(t.id);
    return { id: t.id, label: probeLabel(t), sub: joinDot(hhmm(t.time) ? hhmm(t.time) + " Uhr" : "", t.place),
      jaStyle: miniBtn(v === "ja", "ja"), neinStyle: miniBtn(v === "nein", "nein"), vielStyle: miniBtn(v === "vielleicht", "viel") };
  });

  const rows = members.map((m, idx) => {
    const own = m.id === state.userId;
    const msig = signups.find((x) => x.member_id === m.id && x.event_id === e.id) || null;
    const r = msig?.response || null;
    const b = badge(r);
    const dots = (e.rehearsals || []).map((t) => {
      const a = attendance.find((x) => x.member_id === m.id && x.rehearsal_id === t.id);
      return dot(a ? a.response : null);
    });
    return { name: own ? m.name + " (du)" : m.name, initials: initials(m.name), meta: own ? myMeta : roleLabel(msig),
      avatarBg: AV[idx % 3][0], avatarFg: AV[idx % 3][1], rsvpLabel: b.rsvpLabel, rsvpStyle: b.rsvpStyle, rsvpKey: r || "offen", dots };
  });
  const tally = (v) => rows.filter((r) => r.rsvpLabel === v).length;

  const dp = dateParts(e.date);
  return {
    isName: s.screen === "name", isSignup: s.screen === "signup", isEvents: s.screen === "events",
    isDetail: s.screen === "detail", isOverview: s.screen === "overview",
    isOrgLocked: s.screen === "org" && !s.orgUnlocked,
    isOrgList: s.screen === "org" && s.orgUnlocked && s.orgView === "list",
    isOrgForm: s.screen === "org" && s.orgUnlocked && s.orgView === "form",
    orgFormTitle: s.orgNew ? "Neues Event" : "Event bearbeiten",
    orgEventList: events.map((e2) => { const p = dateParts(e2.date); return { id: e2.id, title: e2.title, dayLabel: p.day + ". " + (p.mon || ""), dayColor: isPast(e2) ? "var(--color-neutral-600)" : "var(--color-accent-700)", sub: joinDot(p.dateLabel, e2.place) }; }),
    f: s.form,
    showTabs: ["events", "detail", "overview", "org"].indexOf(s.screen) >= 0,
    showUserChip: !!meRec && s.screen !== "name" && s.screen !== "signup",
    userShort: meRec ? meRec.name.split(" ")[0] : "",

    query: s.query, filteredMembers,

    newName: s.newName, signupDisabled: !s.newName.trim(),
    signupBtnStyle: "min-height:52px;font-size:16px;margin-top:8px;width:100%;max-width:420px" + (s.newName.trim() ? "" : ";opacity:.45;cursor:not-allowed"),

    tab: s.tab, tabNextStyle: pillTab(s.tab === "next"), tabPastStyle: pillTab(s.tab === "past"), shownEvents,

    detailTally: tally("Ja") + " Ja · " + tally("Vielleicht") + " Vielleicht · " + tally("Nein") + " Nein · " + tally("offen") + " offen",
    ev: { ...e, day: dp.day, mon: dp.mon, dateLabel: dp.dateLabel, treff: e.treffpunkt, maps: e.maps_url, show: e.showtime, setlist: e.setlist_url, geral: e.hinweise, ende: withUhr(e.ende) },
    ensaios, evMeta: joinDot(dp.dateLabel, e.place),
    infoOpen: s.infoOpen, hasMaps: !!e.maps_url,
    infoToggleLabel: s.infoOpen ? "Infos ausblenden" : "Alle Infos anzeigen",
    chevronStyle: s.infoOpen ? "display:block;transform:rotate(180deg);transition:transform .18s" : "display:block;transition:transform .18s",
    hasProben: (e.rehearsals || []).length > 0, noProben: (e.rehearsals || []).length === 0,
    probenHint: (e.rehearsals || []).length > 0 ? "Markiere jeden Probentermin einzeln." : "Die Termine kommen von der Organisation.",
    roleHint: myMeta !== "noch offen" ? "Für dieses Event: " + myMeta + "." : "Nur für dieses Event — Tanz, Bateria oder beides.",
    showInstr: role.bateria, tanzStyle: choiceBtn(role.tanz), bateriaStyle: choiceBtn(role.bateria),
    instrChoices: INSTRUMENTS.map((label) => {
      const on = myInstrs.indexOf(label) >= 0;
      return { label, on, style: "padding:9px 15px;min-height:40px;border-radius:999px;cursor:pointer;font:600 13px 'Figtree',system-ui;"
        + (on ? "background:var(--color-accent);color:var(--color-bg);border:1.5px solid var(--color-accent)" : "background:var(--color-surface);color:var(--color-text);border:1.5px solid var(--color-divider)") };
    }),
    rsvpHint: rsvp ? "Deine Antwort ist gespeichert — du kannst sie jederzeit ändern." : "Antworte bis spätestens eine Woche vorher.",
    jaStyle: bigBtn(rsvp === "ja", "ja"), neinStyle: bigBtn(rsvp === "nein", "nein"), vielStyle: bigBtn(rsvp === "vielleicht", "viel"),
    comment: sig?.comment || "",

    overviewRows: s.ovFilter === "alle" ? rows : rows.filter((r) => r.rsvpKey === s.ovFilter),
    filterEmpty: s.ovFilter !== "alle" && rows.filter((r) => r.rsvpKey === s.ovFilter).length === 0,
    filters: [
      { key: "alle", label: "Alle " + rows.length, tint: ["var(--color-accent-200)", "var(--color-accent-800)"] },
      { key: "ja", label: "Ja " + tally("Ja"), tint: ["var(--color-accent-2-200)", "var(--color-accent-2-800)"] },
      { key: "vielleicht", label: "Vielleicht " + tally("Vielleicht"), tint: ["var(--samba-100)", "var(--samba-700)"] },
      { key: "nein", label: "Nein " + tally("Nein"), tint: ["var(--color-neutral-200)", "var(--color-neutral-800)"] },
      { key: "offen", label: "Offen " + tally("offen"), tint: ["var(--color-surface)", "var(--color-neutral-800)"] },
    ].map((f) => {
      const on = s.ovFilter === f.key;
      return { key: f.key, label: f.label, style: "padding:7px 14px;min-height:36px;border-radius:999px;cursor:pointer;font:600 12.5px 'Figtree',system-ui;"
        + (on ? "background:" + f.tint[0] + ";color:" + f.tint[1] + ";border:1.5px solid " + f.tint[1] : "background:transparent;color:var(--color-neutral-800);border:1.5px solid var(--color-divider)") };
    }),

    pinDots: [0, 1, 2, 3].map((i) => ({ style: `width:13px;height:13px;border-radius:999px;background:${i < s.pin.length ? "var(--color-accent)" : "transparent"};border:1.5px solid ${s.pinErr ? "var(--color-accent-600)" : "var(--color-divider)"}` })),
    pinMsg: s.pinChecking ? "Prüfe…" : s.pinErr ? "Falscher PIN — nochmal versuchen." : "Nur für Organisator:innen.",
    pinMsgColor: s.pinErr ? "var(--color-accent-700)" : "var(--color-neutral-700)",
    keypad: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "←", "0", "OK"].map((k) => ({
      label: k, style: "min-height:52px;border-radius:999px;cursor:pointer;font:600 17px 'Figtree',system-ui;"
        + (k === "OK" ? "background:var(--color-accent);color:var(--color-bg);border:none"
          : k === "←" ? "background:transparent;color:var(--color-neutral-700);border:1px solid var(--color-divider)"
          : "background:var(--color-surface);color:var(--color-text);border:none"),
    })),

    orgEnsaios: s.orgEnsaios.map((t, i) => ({ index: i, date: t.date || "", time: hhmm(t.time), place: t.place || "" })),
    saveLabel: s.saved ? "Gespeichert ✓" : "Event speichern",
    navEventsStyle: navBtn(s.screen === "events"),
  };
}

// ── templates ────────────────────────────────────────────────────────────
function renderHeader(v) {
  const logoCls = hv("background:var(--color-accent-100)");
  const chipCls = hv("border-color:var(--color-accent);background:var(--color-accent-100)");
  return `
<header style="position:sticky;top:0;z-index:20;background:var(--color-bg);border-bottom:1px solid var(--color-divider)">
<div style="max-width:1060px;margin:0 auto;padding:12px clamp(16px,4vw,32px);display:flex;align-items:center;gap:14px;flex-wrap:wrap">
<button class="${logoCls}" data-action="go-events" title="Zu den Veranstaltungen" style="display:flex;align-items:center;gap:14px;flex:1;min-width:120px;background:transparent;border:none;padding:4px 6px 4px 0;margin:0;border-radius:16px;cursor:pointer;text-align:left;font-family:'Figtree',system-ui;color:var(--color-text)">
<img src="assets/logo.png" alt="Sapucaiu no Samba" width="38" height="38" style="flex:none;display:block">
<span style="flex:1;min-width:0">
<span style="display:block;font-family:'Caprasimo',serif;font-size:clamp(17px,2.4vw,21px);line-height:1.1">Sapucaiu no Samba</span>
<span style="display:block;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--color-neutral-700)">Berlin</span>
</span>
</button>
${v.showTabs ? `
<nav style="display:flex;gap:4px;flex-wrap:wrap;order:3;width:100%">
<button data-action="go-events" style="${v.navEventsStyle}">Alle Veranstaltungen</button>
</nav>` : ""}
${v.showUserChip ? `
<button class="${chipCls}" data-action="go-name" title="Anderen Namen wählen" style="display:flex;align-items:center;gap:6px;border:1px solid var(--color-divider);background:var(--color-surface);border-radius:999px;padding:6px 8px 6px 14px;font:600 13px 'Figtree',system-ui;color:var(--color-text);cursor:pointer">
<span>${esc(v.userShort)}</span>
<span style="width:19px;height:19px;flex:none;border-radius:999px;display:grid;place-items:center;background:var(--color-accent-200);color:var(--color-accent-800);font-size:12px;line-height:1">×</span>
</button>` : ""}
</div>
</header>`;
}

function renderName(v) {
  return `
<div style="max-width:1060px;margin:0 auto;padding:24px clamp(16px,4vw,32px) 72px">
<h2 style="font-size:27px;margin:0 0 6px">Wer bist du?</h2>
<p style="font-size:13px;color:var(--color-neutral-700);margin:0 0 14px">Wähle deinen Namen aus der Liste. Beim nächsten Mal erkennt dich die App wieder.</p>
<input class="input" data-field="query" placeholder="Namen suchen" value="${esc(v.query)}" style="margin-bottom:16px;max-width:340px">
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:8px">
${v.filteredMembers.map((m) => {
  const cls = hv("border-color:var(--color-accent);background:var(--color-accent-100)");
  return `<button class="${cls}" data-action="pick-member" data-id="${esc(m.id)}" style="display:flex;align-items:center;gap:12px;width:100%;text-align:left;background:var(--color-surface);border:1px solid transparent;border-radius:999px;padding:10px 14px;cursor:pointer;font-family:'Figtree',system-ui">
<span style="width:34px;height:34px;flex:none;border-radius:999px;display:grid;place-items:center;font:600 13px 'Figtree',system-ui;background:${m.avatarBg};color:${m.avatarFg}">${esc(m.initials)}</span>
<span style="flex:1;min-width:0;font:600 15px 'Figtree',system-ui">${esc(m.name)}</span>
</button>`;
}).join("")}
</div>
<div style="margin-top:22px;padding:20px;border-radius:28px;border:1.5px dashed var(--color-accent-300);background:var(--color-accent-100);max-width:420px">
<div style="font-family:'Caprasimo',serif;font-size:18px;margin-bottom:4px">Neu hier?</div>
<p style="font-size:12px;color:var(--color-accent-800);margin:0 0 10px">Trag dich einmal mit deinem Namen ein.</p>
<button class="btn btn-primary btn-block" data-action="go-signup" style="min-height:46px;font-size:15px">Ich bin neu hier</button>
</div>
</div>`;
}

function renderSignup(v) {
  return `
<div style="max-width:1060px;margin:0 auto;padding:24px clamp(16px,4vw,32px) 72px">
<button class="btn btn-ghost" data-action="go-name" style="padding-left:0;margin-bottom:6px;color:var(--color-accent-700)">← Zurück</button>
<h2 style="font-size:27px;margin:0 0 14px;max-width:560px">Willkommen!</h2>
<div class="field" style="margin-bottom:16px;max-width:420px">
<label>Vor- und Nachname</label>
<input class="input" data-field="newName" placeholder="z.B. Lina Bergmann" value="${esc(v.newName)}" style="min-height:46px">
</div>
<p style="font-size:13px;color:var(--color-neutral-800);margin:0 0 16px;max-width:420px">Tanz oder Bateria wählst du später pro Veranstaltung — beides ist möglich.</p>
<button class="btn btn-primary" data-action="submit-signup" ${v.signupDisabled ? "disabled" : ""} style="${v.signupBtnStyle}">Los geht's</button>
</div>`;
}

function renderEvents(v) {
  return `
<div style="max-width:1060px;margin:0 auto;padding:24px clamp(16px,4vw,32px) 72px">
<h2 style="font-size:27px;margin:0 0 12px">Veranstaltungen</h2>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:4px;background:var(--color-surface);border-radius:999px;margin-bottom:18px;max-width:300px">
<button data-action="tab" data-value="next" style="${v.tabNextStyle}">Nächste</button>
<button data-action="tab" data-value="past" style="${v.tabPastStyle}">Vergangene</button>
</div>
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:14px">
${v.shownEvents.map((e) => {
  const cls = hv("border-color:var(--color-accent-300)");
  return `<button class="${cls}" data-action="open-event" data-id="${esc(e.id)}" style="display:block;width:100%;text-align:left;background:var(--color-surface);border:1px solid transparent;border-radius:28px;padding:14px;cursor:pointer;font-family:'Figtree',system-ui">
<span style="display:flex;gap:13px;align-items:flex-start">
<span style="flex:none;width:52px;border-radius:18px;padding:8px 0;text-align:center;background:${e.dateBg};color:${e.dateFg}">
<span style="display:block;font-family:'Caprasimo',serif;font-size:21px;line-height:1">${esc(e.day)}</span>
<span style="display:block;font-size:9.5px;letter-spacing:.1em">${esc(e.mon)}</span>
</span>
<span style="flex:1;min-width:0">
<span style="display:block;font-family:'Caprasimo',serif;font-size:17px;line-height:1.15">${esc(e.title)}</span>
<span style="display:block;font-size:12px;color:var(--color-neutral-700);margin-top:3px">${esc(e.meta)}</span>
<span style="display:flex;align-items:center;gap:7px;margin-top:9px">
<span style="flex:1;height:6px;border-radius:999px;background:var(--color-neutral-300);overflow:hidden">
<span style="display:block;height:6px;border-radius:999px;background:var(--color-accent-2);width:${e.pct}"></span>
</span>
<span style="font-size:11px;color:var(--color-neutral-700);white-space:nowrap">${esc(e.summary)}</span>
</span>
</span>
</span>
</button>`;
}).join("")}
</div>
${v.shownEvents.length === 0 ? `<p style="font-size:13px;color:var(--color-neutral-700)">Keine Veranstaltungen in dieser Ansicht.</p>` : ""}
</div>`;
}

function renderDetail(v) {
  const toggleCls = hv("background:rgba(255,255,255,.16)");
  const overviewCls = hv("border-color:var(--color-accent);background:var(--color-accent-100)");
  return `
<div style="max-width:1060px;margin:0 auto;padding:24px clamp(16px,4vw,32px) 72px">
<div style="background:var(--color-accent-2-700);color:var(--color-accent-2-100);padding:18px clamp(16px,3vw,26px) 20px;border-radius:28px;box-shadow:var(--shadow-md)">
<button class="btn btn-ghost" data-action="go-events" style="color:var(--samba-100);padding-left:0;margin-bottom:4px">← Veranstaltungen</button>
<div style="font-family:'Caprasimo',serif;font-size:23px;line-height:1.1;color:#fff">${esc(v.ev.title)}</div>
<div style="font-size:12px;color:var(--color-accent-2-200);margin-top:3px">${esc(v.evMeta)}</div>
<button class="${toggleCls}" data-action="toggle-info" style="display:flex;align-items:center;gap:8px;width:100%;margin-top:11px;padding:8px 12px;border-radius:999px;border:1px solid rgba(255,255,255,.28);background:rgba(255,255,255,.08);cursor:pointer;font:600 12.5px 'Figtree',system-ui;color:#fff">
<span style="flex:1;min-width:0;text-align:left">${esc(v.infoToggleLabel)}</span>
<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--samba)" stroke-width="2.75" stroke-linecap="round" style="${v.chevronStyle}"><polyline points="6 9 12 15 18 9"></polyline></svg>
</button>
${v.infoOpen ? `
<div style="display:grid;grid-template-columns:auto 1fr;gap:7px 12px;margin-top:13px;font-size:12.5px">
<span style="color:var(--samba-100);font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;padding-top:2px">Treffpunkt</span><span style="color:#fff">${esc(v.ev.treff)}${v.hasMaps ? `<a href="${esc(v.ev.maps)}" target="_blank" style="display:inline-block;margin-left:7px;color:#fff;text-decoration:underline">Karte öffnen</a>` : ""}</span>
<span style="color:var(--samba-100);font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;padding-top:2px">Ankunft</span><span style="color:#fff">${esc(v.ev.ankunft)}</span>
<span style="color:var(--samba-100);font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;padding-top:2px">Showtime</span><span style="color:#fff">${esc(v.ev.show)}</span>
<span style="color:var(--samba-100);font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;padding-top:2px">Ende (ca.)</span><span style="color:#fff">${esc(v.ev.ende)}</span>
<span style="color:var(--samba-100);font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;padding-top:2px">Outfit</span><span style="color:#fff">${esc(v.ev.outfit)}</span>
<span style="color:var(--samba-100);font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;padding-top:2px">Setlist</span><span><a href="#setlist" style="color:#fff;text-decoration:underline">${esc(v.ev.setlist)}</a></span>
<span style="color:var(--samba-100);font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;padding-top:2px">Hinweise</span><span style="color:#fff;white-space:pre-line">${esc(v.ev.geral)}</span>
</div>` : ""}
</div>

<button class="${overviewCls}" data-action="go-overview" style="display:flex;align-items:center;gap:12px;width:100%;margin-top:14px;padding:12px 16px;border-radius:24px;border:1.5px solid var(--color-divider);background:var(--color-surface);cursor:pointer;text-align:left;font-family:'Figtree',system-ui;color:var(--color-text)">
<span style="flex:1;min-width:0">
<span style="display:block;font:600 14.5px 'Figtree',system-ui">Wer kommt mit?</span>
<span style="display:block;font-size:12px;color:var(--color-neutral-700);margin-top:2px">${esc(v.detailTally)}</span>
</span>
<span style="flex:none;color:var(--color-accent-700);font:600 13px 'Figtree',system-ui">Alle ansehen ›</span>
</button>

<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:clamp(20px,3vw,36px);margin-top:24px;align-items:start">
<div>
<h4 style="font-size:19px;margin:0 0 3px">Bist du dabei?</h4>
<p style="font-size:12px;color:var(--color-neutral-700);margin:0 0 10px">${esc(v.rsvpHint)}</p>
<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
<button data-action="set-rsvp" data-value="ja" style="${v.jaStyle}">Ja</button>
<button data-action="set-rsvp" data-value="nein" style="${v.neinStyle}">Nein</button>
<button data-action="set-rsvp" data-value="vielleicht" style="${v.vielStyle}">Vielleicht</button>
</div>
<div class="field" style="margin-top:14px">
<label>Kommentar (optional)</label>
<textarea class="input" data-field="comment" placeholder="z.B. Komme direkt von der Arbeit, ca. 20 Min später." style="border-radius:22px;min-height:74px">${esc(v.comment)}</textarea>
</div>

<h4 style="font-size:19px;margin:22px 0 3px">Was machst du hier?</h4>
<p style="font-size:12px;color:var(--color-neutral-700);margin:0 0 10px">${esc(v.roleHint)}</p>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
<button data-action="toggle-tanz" style="${v.tanzStyle}">Tanz</button>
<button data-action="toggle-bateria" style="${v.bateriaStyle}">Bateria</button>
</div>
${v.showInstr ? `
<div style="margin-top:12px">
<div style="font-size:12px;color:var(--color-neutral-700);margin-bottom:7px">Instrumente — mehrere möglich</div>
<div style="display:flex;flex-wrap:wrap;gap:7px">
${v.instrChoices.map((c) => `<button data-action="pick-instr" data-label="${esc(c.label)}" style="${c.style}">${esc(c.label)}</button>`).join("")}
</div>
</div>` : ""}

</div>
<div>
<h4 style="font-size:19px;margin:0 0 3px">Proben für dieses Event</h4>
<p style="font-size:12px;color:var(--color-neutral-700);margin:0 0 10px">${esc(v.probenHint)}</p>
<div style="display:flex;flex-direction:column;gap:8px">
${v.ensaios.map((t) => `
<div style="background:var(--color-surface);border-radius:22px;padding:11px 13px;display:flex;align-items:center;gap:10px">
<span style="flex:1;min-width:0">
<span style="display:block;font:600 13.5px 'Figtree',system-ui">${esc(t.label)}</span>
<span style="display:block;font-size:11px;color:var(--color-neutral-700)">${esc(t.sub)}</span>
</span>
<span style="display:flex;gap:5px;flex:none">
<button data-action="set-ens" data-tid="${esc(t.id)}" data-value="ja" style="${t.jaStyle}">J</button>
<button data-action="set-ens" data-tid="${esc(t.id)}" data-value="nein" style="${t.neinStyle}">N</button>
<button data-action="set-ens" data-tid="${esc(t.id)}" data-value="vielleicht" style="${t.vielStyle}">?</button>
</span>
</div>`).join("")}
</div>
${v.noProben ? `<div style="background:var(--color-surface);border-radius:22px;padding:14px;font-size:12.5px;color:var(--color-neutral-700)">Noch keine Probentermine eingetragen.</div>` : ""}
<button class="btn btn-primary btn-block" data-action="save-and-overview" style="min-height:50px;font-size:15px;margin-top:16px">Speichern</button>
</div>
</div>
</div>`;
}

function renderOverview(v) {
  return `
<div style="max-width:1060px;margin:0 auto;padding:24px clamp(16px,4vw,32px) 72px">
<button class="btn btn-ghost" data-action="go-detail" style="padding-left:0;margin-bottom:2px;color:var(--color-accent-700)">← ${esc(v.ev.title)}</button>
<h2 style="font-size:26px;margin:0 0 4px">Übersicht</h2>
<p style="font-size:12px;color:var(--color-neutral-700);margin:0 0 12px">${esc(v.evMeta)} · nur lesen</p>
<div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:14px">
${v.filters.map((f) => `<button data-action="filter" data-value="${esc(f.key)}" style="${f.style}">${esc(f.label)}</button>`).join("")}
</div>
${v.filterEmpty ? `<div style="background:var(--color-surface);border-radius:24px;padding:16px;font-size:13px;color:var(--color-neutral-700)">Niemand mit dieser Antwort.</div>` : ""}
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px">
${v.overviewRows.map((r) => `
<div style="background:var(--color-surface);border-radius:24px;padding:12px 14px">
<div style="display:flex;align-items:center;gap:10px">
<span style="width:30px;height:30px;flex:none;border-radius:999px;display:grid;place-items:center;font:600 12px 'Figtree',system-ui;background:${r.avatarBg};color:${r.avatarFg}">${esc(r.initials)}</span>
<span style="flex:1;min-width:0">
<span style="display:block;font:600 14px 'Figtree',system-ui">${esc(r.name)}</span>
<span style="display:block;font-size:11px;color:var(--color-neutral-700)">${esc(r.meta)}</span>
</span>
<span style="${r.rsvpStyle}">${esc(r.rsvpLabel)}</span>
</div>
${v.hasProben ? `
<div style="display:flex;align-items:center;gap:6px;margin-top:10px">
<span style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--color-neutral-700);margin-right:2px">Proben</span>
${r.dots.map((d) => `<span title="${esc(d.title)}" style="${d.style}">${esc(d.mark)}</span>`).join("")}
</div>` : ""}
</div>`).join("")}
</div>
</div>`;
}

function renderOrgLocked(v) {
  return `
<div style="max-width:430px;margin:0 auto;padding:44px clamp(16px,4vw,32px) 72px;text-align:center">
<img src="assets/logo.png" alt="" width="60" height="60" style="display:block;margin:0 auto 12px">
<h2 style="font-size:24px;margin:0 0 4px">Organisator-Modus</h2>
<p style="font-size:12.5px;color:var(--color-neutral-700);margin:0 0 16px">PIN eingeben, um Events und Proben zu bearbeiten.</p>
<div style="display:flex;justify-content:center;gap:9px;margin-bottom:8px">
${v.pinDots.map((p) => `<span style="${p.style}"></span>`).join("")}
</div>
<div style="font-size:11.5px;color:${v.pinMsgColor};min-height:18px;margin-bottom:12px">${esc(v.pinMsg)}</div>
<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:9px;max-width:250px;margin:0 auto">
${v.keypad.map((k) => `<button data-action="press-key" data-key="${esc(k.label)}" style="${k.style}">${esc(k.label)}</button>`).join("")}
</div>
</div>`;
}

function renderOrgList(v) {
  return `
<div style="max-width:1060px;margin:0 auto;padding:24px clamp(16px,4vw,32px) 72px">
<div style="display:flex;align-items:baseline;gap:8px;margin-bottom:4px">
<h2 style="font-size:26px;margin:0">Organisator</h2>
<span class="tag tag-accent" style="flex:none">PIN ok</span>
</div>
<p style="font-size:12px;color:var(--color-neutral-700);margin:0 0 14px">Event anlegen oder ein bestehendes bearbeiten.</p>
<button class="btn btn-primary" data-action="org-new" style="min-height:50px;font-size:15px;margin-bottom:18px;width:100%;max-width:320px">+ Neues Event anlegen</button>
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:8px">
${v.orgEventList.map((e) => {
  const cls = hv("border-color:var(--color-accent-300)");
  return `<button class="${cls}" data-action="org-edit" data-id="${esc(e.id)}" style="display:flex;align-items:center;gap:12px;width:100%;text-align:left;background:var(--color-surface);border:1px solid transparent;border-radius:999px;padding:10px 16px 10px 12px;cursor:pointer;font-family:'Figtree',system-ui">
<span style="flex:none;width:44px;text-align:center;font-family:'Caprasimo',serif;font-size:15px;color:${e.dayColor}">${esc(e.dayLabel)}</span>
<span style="flex:1;min-width:0">
<span style="display:block;font:600 14px 'Figtree',system-ui">${esc(e.title)}</span>
<span style="display:block;font-size:11px;color:var(--color-neutral-700)">${esc(e.sub)}</span>
</span>
<span style="flex:none;color:var(--color-neutral-600);font-size:15px">›</span>
</button>`;
}).join("")}
</div>
<button class="btn btn-secondary" data-action="lock-org" style="min-height:44px;margin-top:20px;width:100%;max-width:320px">Organisator-Modus verlassen</button>
</div>`;
}

function renderOrgForm(v) {
  const f = v.f;
  const field = (label, key, type, placeholder) => `<div class="field" style="margin-bottom:12px"><label>${esc(label)}</label><input class="input" type="${type}" placeholder="${esc(placeholder || "")}" data-field="form.${key}" value="${esc(f[key])}" style="min-height:44px"></div>`;
  return `
<div style="max-width:1060px;margin:0 auto;padding:24px clamp(16px,4vw,32px) 72px">
<button class="btn btn-ghost" data-action="org-back" style="padding-left:0;margin-bottom:2px;color:var(--color-accent-700)">← Organisator</button>
<div style="display:flex;align-items:baseline;gap:8px;margin-bottom:10px">
<h2 style="font-size:26px;margin:0">${esc(v.orgFormTitle)}</h2>
</div>
<div style="max-width:660px">
${field("Titel", "title", "text", "z.B. Berlin Samba Parade")}
<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
<div class="field"><label>Datum</label><input class="input" type="date" data-field="form.date" value="${esc(f.date)}" style="min-height:44px"></div>
<div class="field"><label>Ankunftszeit</label><input class="input" type="time" data-field="form.ankunft" value="${esc(f.ankunft)}" style="min-height:44px"></div>
</div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
<div class="field"><label>Showtime</label><input class="input" type="time" data-field="form.show" value="${esc(f.show)}" style="min-height:44px"></div>
<div class="field"><label>Ende (ca.)</label><input class="input" type="time" data-field="form.ende" value="${esc(f.ende)}" style="min-height:44px"></div>
</div>
${field("Ort", "place", "text", "Stadtteil, Strecke oder Location")}
${field("Treffpunkt", "treff", "text", "Genauer Treffpunkt")}
${field("Google-Maps-Link zum Treffpunkt", "maps", "text", "https://maps.app.goo.gl/…")}
${field("Outfit", "outfit", "text", "z.B. Gelb-grüne Fantasia")}
${field("Setlist-Link", "setlist", "text", "https://…")}
<div class="field" style="margin-bottom:18px"><label>Hinweise</label><textarea class="input" data-field="form.geral" placeholder="Offene Notizen: Kontakt vor Ort, Anfahrt, Besonderheiten …" style="border-radius:22px;min-height:96px">${esc(f.geral)}</textarea></div>

<div style="border-top:1px solid var(--color-divider);padding-top:16px">
<h4 style="font-size:18px;margin:0 0 8px">Probentermine</h4>
<div style="display:flex;flex-direction:column;gap:8px">
${v.orgEnsaios.map((t) => {
  const rmCls = hv("background:var(--color-accent-100);color:var(--color-accent-700)");
  return `<div style="background:var(--color-surface);border-radius:24px;padding:11px 12px">
<div style="display:flex;align-items:center;gap:8px">
<input class="input" type="date" data-field="ensaio.${t.index}.date" value="${esc(t.date)}" style="flex:1;min-height:40px;background:var(--color-bg)">
<input class="input" type="time" data-field="ensaio.${t.index}.time" value="${esc(t.time)}" style="width:104px;min-height:40px;background:var(--color-bg)">
<button class="${rmCls}" data-action="org-remove-ensaio" data-index="${t.index}" style="width:32px;height:32px;flex:none;border-radius:999px;border:1px solid var(--color-divider);background:transparent;cursor:pointer;color:var(--color-neutral-700);font-size:15px">×</button>
</div>
<input class="input" placeholder="Ort der Probe" data-field="ensaio.${t.index}.place" value="${esc(t.place)}" style="margin-top:8px;min-height:40px;background:var(--color-bg)">
</div>`;
}).join("")}
</div>
<button class="btn btn-secondary btn-block" data-action="org-add-ensaio" style="min-height:44px;margin-top:10px">+ Termin hinzufügen</button>
</div>

<div style="display:flex;gap:9px;margin-top:20px">
<button class="btn btn-secondary" data-action="org-back" style="flex:1;min-height:48px">Abbrechen</button>
<button class="btn btn-primary" data-action="org-save" style="flex:2;min-height:48px;font-size:15px">${esc(v.saveLabel)}</button>
</div>
${!state.orgNew ? `<button class="btn btn-ghost" data-action="org-delete-event" style="margin-top:10px;color:var(--color-accent-700)">Event löschen</button>` : ""}
</div>
</div>`;
}

function renderFooter(v) {
  if (!v.showTabs) return "";
  const cls = hv("color:var(--color-accent-700)");
  return `
<footer style="border-top:1px solid var(--color-divider)">
<div style="max-width:1060px;margin:0 auto;padding:18px clamp(16px,4vw,32px) 32px;display:flex;align-items:center;gap:14px;flex-wrap:wrap">
<span style="flex:1;min-width:140px;font-size:11.5px;color:var(--color-neutral-700)">Sapucaiu no Samba · Berlin</span>
<button class="${cls}" data-action="go-org" style="background:transparent;border:none;padding:6px 0;cursor:pointer;font:600 12px 'Figtree',system-ui;color:var(--color-neutral-700);text-decoration:underline;text-underline-offset:3px">Organisator-Modus</button>
</div>
</footer>`;
}

function renderBanner(v) {
  if (!state.banner) return "";
  return `<div style="position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:40;max-width:min(420px,92vw);background:var(--color-accent-700);color:#fff;padding:11px 18px;border-radius:999px;font:600 13px 'Figtree',system-ui;box-shadow:var(--shadow-lg);text-align:center">${esc(state.banner)}</div>`;
}

function renderScreen(v) {
  if (v.isName) return renderName(v);
  if (v.isSignup) return renderSignup(v);
  if (v.isEvents) return renderEvents(v);
  if (v.isDetail) return renderDetail(v);
  if (v.isOverview) return renderOverview(v);
  if (v.isOrgLocked) return renderOrgLocked(v);
  if (v.isOrgList) return renderOrgList(v);
  if (v.isOrgForm) return renderOrgForm(v);
  return "";
}

function renderBootScreen() {
  const msg = state.boot === "config"
    ? { title: "Setup nötig", body: "Trag SUPABASE_URL und SUPABASE_ANON_KEY in config.js ein (siehe supabase/schema.sql für die Einrichtung), dann neu laden." }
    : state.boot === "error"
    ? { title: "Keine Verbindung", body: "Die Daten konnten nicht geladen werden. Prüfe die Internetverbindung und ob config.js korrekt ausgefüllt ist." }
    : { title: "Lädt …", body: "" };
  return `
<div style="min-height:100vh;background:var(--color-bg);color:var(--color-text);font-family:'Figtree',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px">
<div style="max-width:360px;text-align:center">
<img src="assets/logo.png" alt="" width="56" height="56" style="display:block;margin:0 auto 14px">
<h2 style="font-size:22px;margin:0 0 8px">${esc(msg.title)}</h2>
<p style="font-size:13px;color:var(--color-neutral-700)">${esc(msg.body)}</p>
</div>
</div>`;
}

// ── render + focus preservation ─────────────────────────────────────────
const app = document.getElementById("app");
let hoverStyleEl = null;

function render() {
  if (state.boot !== "ready") {
    app.innerHTML = renderBootScreen();
    return;
  }

  hoverRules = [];
  hoverSeq = 0;

  const active = document.activeElement;
  const focusKey = active && active.dataset ? active.dataset.field : null;
  const selStart = active && "selectionStart" in active ? active.selectionStart : null;
  const selEnd = active && "selectionEnd" in active ? active.selectionEnd : null;

  const v = computeView();
  app.innerHTML = `<div style="min-height:100vh;background:var(--color-bg);font-family:'Figtree',system-ui,sans-serif;color:var(--color-text)">`
    + renderHeader(v)
    + `<div style="position:relative">` + renderScreen(v) + `</div>`
    + renderFooter(v)
    + `</div>`
    + renderBanner(v);

  if (!hoverStyleEl) {
    hoverStyleEl = document.createElement("style");
    document.head.appendChild(hoverStyleEl);
  }
  hoverStyleEl.textContent = hoverRules.join("\n");

  if (focusKey) {
    const next = app.querySelector(`[data-field="${CSS.escape(focusKey)}"]`);
    if (next) {
      next.focus();
      if (selStart != null) {
        try { next.setSelectionRange(selStart, selEnd); } catch (_) { /* not all input types support it */ }
      }
    }
  }

  // Subscribe to realtime updates only while the read-only Übersicht is
  // open — that's the one screen where seeing someone else's change live
  // actually matters, and it keeps the number of open channels at zero
  // the rest of the time.
  if (v.isOverview && !unsubscribeRealtime) {
    unsubscribeRealtime = db.subscribeToResponses(async () => {
      try {
        [signups, attendance] = await Promise.all([db.listSignups(), db.listAttendance()]);
        render();
      } catch (err) { console.error(err); }
    });
  } else if (!v.isOverview && unsubscribeRealtime) {
    unsubscribeRealtime();
    unsubscribeRealtime = null;
  }
}

// ── event delegation ─────────────────────────────────────────────────────
app.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;
  const val = el.dataset.value;

  switch (action) {
    case "go-events": return setState({ screen: "events" });
    case "go-name": return setState({ screen: "name", query: "" });
    case "go-signup": return setState({ screen: "signup" });
    case "go-detail": return setState({ screen: "detail" });
    case "go-overview": return setState({ screen: "overview" });
    case "go-org": return setState({ screen: "org", orgView: "list", saved: false });
    case "lock-org": return setState({ orgUnlocked: false, orgPin: null, screen: "events", orgView: "list", saved: false });
    case "pick-member": {
      localStorage.setItem(LS_KEY, el.dataset.id);
      return setState({ userId: el.dataset.id, screen: "events" });
    }
    case "submit-signup": {
      const n = state.newName.trim();
      if (!n) return;
      db.createMember(n).then((m) => {
        members.push(m);
        localStorage.setItem(LS_KEY, m.id);
        setState({ userId: m.id, screen: "events", newName: "" });
      }).catch((err) => {
        console.error(err);
        const existing = members.find((m) => m.name.toLowerCase() === n.toLowerCase());
        if (existing) { localStorage.setItem(LS_KEY, existing.id); return setState({ userId: existing.id, screen: "events", newName: "" }); }
        showBanner("Registrierung fehlgeschlagen — bitte erneut versuchen.");
      });
      return;
    }
    case "tab": return setState({ tab: val });
    case "open-event": return setState({ eventId: el.dataset.id, screen: "detail", infoOpen: false });
    case "toggle-info": return setState((s) => ({ infoOpen: !s.infoOpen }));
    case "set-rsvp": return patchMySignup({ response: val });
    case "toggle-tanz": return patchMySignup({ does_tanz: !mySignup(state.eventId).does_tanz });
    case "toggle-bateria": return patchMySignup({ does_bateria: !mySignup(state.eventId).does_bateria });
    case "pick-instr": {
      const cur = mySignup(state.eventId).instruments || [];
      const label = el.dataset.label;
      const next = cur.indexOf(label) >= 0 ? cur.filter((x) => x !== label) : cur.concat([label]);
      return patchMySignup({ instruments: next });
    }
    case "set-ens": return setAttendance(el.dataset.tid, val);
    case "save-and-overview": return setState({ screen: "overview", ovFilter: "alle" });
    case "filter": return setState({ ovFilter: val });
    case "press-key": {
      const k = el.dataset.key;
      if (k === "←") return setState((s) => ({ pin: s.pin.slice(0, -1), pinErr: false }));
      if (k === "OK") {
        const attempted = state.pin;
        setState({ pin: "", pinChecking: true });
        db.verifyPin(attempted).then((ok) => {
          if (ok) return setState({ orgUnlocked: true, orgPin: attempted, screen: "org", orgView: "list", pinErr: false, pinChecking: false });
          setState({ pinErr: true, pinChecking: false });
        }).catch((err) => {
          console.error(err);
          setState({ pinChecking: false });
          showBanner("PIN konnte nicht geprüft werden — bitte Verbindung prüfen.");
        });
        return;
      }
      return setState((s) => (s.pin.length >= 4 ? {} : { pin: s.pin + k, pinErr: false }));
    }
    case "org-new": return setState({ orgView: "form", orgNew: true, orgEditId: null, form: { ...EMPTY_FORM }, orgEnsaios: [], saved: false });
    case "org-edit": {
      const found = events.find((e) => e.id === el.dataset.id);
      if (!found) return;
      return setState({ orgView: "form", orgNew: false, orgEditId: found.id, form: formFrom(found), saved: false, orgEnsaios: (found.rehearsals || []).map((t) => ({ ...t })) });
    }
    case "org-back": return setState({ orgView: "list", saved: false });
    case "org-add-ensaio": return setState((s) => ({ saved: false, orgEnsaios: s.orgEnsaios.concat([{ date: "", time: "19:30", place: "Saal Weichselstraße" }]) }));
    case "org-remove-ensaio": {
      const idx = Number(el.dataset.index);
      return setState((s) => ({ orgEnsaios: s.orgEnsaios.filter((_, j) => j !== idx), saved: false }));
    }
    case "org-save": return commitEvent();
    case "org-delete-event": {
      if (!state.orgEditId) return;
      if (!window.confirm("Dieses Event inkl. aller Proben, Zusagen und Anwesenheiten wirklich löschen?")) return;
      return deleteEvent(state.orgEditId);
    }
    default: return;
  }
});

app.addEventListener("input", (e) => {
  const el = e.target;
  const field = el.dataset.field;
  if (!field) return;
  const value = el.value;

  if (field === "query") return setState({ query: value });
  if (field === "newName") return setState({ newName: value });
  if (field === "comment") return patchMySignup({ comment: value });

  if (field.startsWith("form.")) {
    const key = field.slice(5);
    return setState((s) => ({ form: { ...s.form, [key]: value }, saved: false }));
  }
  if (field.startsWith("ensaio.")) {
    const [, idxStr, key] = field.split(".");
    const idx = Number(idxStr);
    return setState((s) => ({ orgEnsaios: s.orgEnsaios.map((t, j) => (j === idx ? { ...t, [key]: value } : t)), saved: false }));
  }
});

// ── boot ─────────────────────────────────────────────────────────────────
async function boot() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    state.boot = "config";
    render();
    return;
  }
  try {
    [members, events, signups, attendance] = await Promise.all([
      db.listMembers(), db.listEvents(), db.listSignups(), db.listAttendance(),
    ]);
  } catch (err) {
    console.error(err);
    state.boot = "error";
    render();
    return;
  }
  const savedId = localStorage.getItem(LS_KEY);
  if (savedId && members.some((m) => m.id === savedId)) {
    state.userId = savedId;
    state.screen = "events"; // returning visitor — skip the name picker
  }
  state.boot = "ready";
  render();
}

render(); // immediate "Lädt …" paint
boot();
