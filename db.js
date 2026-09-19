// All Supabase calls live here — app.js never talks to Supabase directly.
// Uses the official ESM CDN build, so no bundler/build step is needed.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function check(result) {
  if (result.error) throw result.error;
  return result.data;
}

export async function listMembers() {
  return check(await supabase.from("members").select("*").order("name"));
}

export async function createMember(name) {
  return check(await supabase.from("members").insert({ name }).select().single());
}

// Events with their rehearsals nested, oldest first — app.js derives
// "Nächste"/"Vergangene" from `date` at render time.
export async function listEvents() {
  return check(await supabase.from("events").select("*, rehearsals(*)").order("date"));
}

export async function listSignups() {
  return check(await supabase.from("event_signups").select("*"));
}

export async function listAttendance() {
  return check(await supabase.from("rehearsal_attendance").select("*"));
}

export async function upsertSignup(row) {
  // row: { member_id, event_id, response, comment, does_tanz, does_bateria, instruments }
  return check(await supabase.from("event_signups").upsert(row, { onConflict: "member_id,event_id" }).select().single());
}

export async function upsertAttendance(row) {
  // row: { member_id, rehearsal_id, response }
  return check(await supabase.from("rehearsal_attendance").upsert(row, { onConflict: "member_id,rehearsal_id" }).select().single());
}

// PIN-gated organizer writes — the anon key alone cannot write `events` or
// `rehearsals` directly (see supabase/schema.sql); these RPCs check the PIN
// server-side on every call.
export async function verifyPin(pin) {
  return check(await supabase.rpc("verify_pin", { p_pin: pin }));
}

export async function organizerSaveEvent(pin, event, rehearsals) {
  return check(await supabase.rpc("organizer_save_event", { p_pin: pin, p_event: event, p_rehearsals: rehearsals }));
}

export async function organizerDeleteEvent(pin, id) {
  check(await supabase.rpc("organizer_delete_event", { p_pin: pin, p_id: id }));
}

// Realtime (nice-to-have, per the brief): fires `cb()` whenever any signup
// or rehearsal-attendance row changes, so the Übersicht screen can refetch
// and re-tally without a manual reload. Returns an unsubscribe function.
export function subscribeToResponses(cb) {
  const channel = supabase
    .channel("responses-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "event_signups" }, cb)
    .on("postgres_changes", { event: "*", schema: "public", table: "rehearsal_attendance" }, cb)
    .subscribe();
  return () => supabase.removeChannel(channel);
}
