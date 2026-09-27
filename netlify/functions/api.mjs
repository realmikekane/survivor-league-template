import { randomBytes } from "node:crypto";
import { makeToken, verifyToken } from "../../lib/token.mjs";
import { mailConfig, sendReminderBatch, sendPlain, summaryText } from "../../lib/mailer.mjs";
import { LEAGUE_TZ, tzLabel } from "../../lib/tz.mjs";
import { defaultRulesText } from "../../lib/rules-text.mjs";
import { fetchSurvivorGrid } from "../../lib/survivorgrid.mjs";
import { cleanText, isClean } from "../../lib/clean.mjs";
import { askHost, hostConfigured, hostShouldReply, DEFAULT_HOST_NAME, HOST_PERSONA_PRESETS, PERSONA_MAX } from "../../lib/host.mjs";
import { blobStore, getJSON, setJSON, listJSON, listKeys, getManyJSON, mutateDoc } from "../../lib/store.mjs";
import { fetchClosingLine, fetchWeek, isStale } from "../../lib/espn.mjs";
import {
  computeStandings, aggregateStandings, currentWeek, evaluateSlot, validatePick, validateBuyback, standingOf, stalePickWeek,
  gameForTeam, gameStarted, publicSlotView, computePot,
} from "../../lib/rules.mjs";

export const config = { path: "/api/*" };

/* ---------- small helpers ---------- */

/* Bumped on client-affecting deploys. Served on /api/state so long-suspended
   phone tabs notice they are stale and refresh themselves. */
const APP_BUILD = "2026-09-27b";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const bad = (error, status = 400) => json({ error }, status);


const newId = (prefix) => `${prefix}_${randomBytes(4).toString("hex")}`;
const newPin = () => String(Math.floor(1000 + Math.random() * 9000));

async function readBody(req) {
  try { return await req.json(); } catch { return {}; }
}

/* ---------- storage access ---------- */

const KEYS = {
  cfg: "cfg",
  roster: (s) => `roster:${s}`,
  slots: (s) => `slots:${s}`,
  payments: (s) => `payments:${s}`,
  revivals: (s) => `revivals:${s}`,
  overrides: (s) => `overrides:${s}`,
  sched: (s, w) => `sched:${s}:${w}`,
  pick: (s, slotId, w) => `pick:${s}:${slotId}:${w}`,
  pickPrefix: (s, slotId = "") => (slotId ? `pick:${s}:${slotId}:` : `pick:${s}:`),
  snapshot: (s) => `snapshot:${s}`,
  news: (s) => `news:${s}`,
  log: (s) => `log:${s}:`,
  host: (s) => `host:${s}`,
  snuffed: (s) => `snuffed:${s}`,
  chat: (s) => `chat:${s}:`,
};

async function loadDoc(store, key, fallback) {
  return (await getJSON(store, key)) ?? fallback;
}

async function appendLog(store, S, entry) {
  const key = `${KEYS.log(S)}${Date.now().toString().padStart(14, "0")}-${randomBytes(3).toString("hex")}`;
  await setJSON(store, key, { ts: new Date().toISOString(), ...entry });
}

/* A slot that lost and hasn't bought back can't hold a pick for the week in
   play (evaluateSlot already sets it aside). Delete it for real and say why in
   the slot's log. `slot` needs id and label; `picks` is week -> pick record. */
async function clearStalePick(store, S, slot, evaluation, picks) {
  const w = stalePickWeek(evaluation, picks);
  if (!w) return false;
  const team = picks[w].team;
  await store.delete(KEYS.pick(S, slot.id, w));
  delete picks[w];
  await appendLog(store, S, {
    action: "pick-cleared", actor: "system", slotId: slot.id, slotLabel: slot.label, week: w, before: team,
    note: `Cleared: the week ${evaluation.openLoss.lossWeek} loss isn't bought back. Buy back, then pick again.`,
  });
  return true;
}

/* Schedule cache: fetch from ESPN only when the cached copy is stale for its heat. */
async function getSchedule(store, cfg, week, now) {
  const key = KEYS.sched(cfg.seasonYear, week);
  let cached = await getJSON(store, key);
  if (!cached || isStale(cached, now)) {
    try {
      const fresh = await fetchWeek(cfg.seasonYear, week);
      // A blank answer (outage, throttling) must not replace a real week for hours.
      if (!fresh.games?.length && cached?.games?.length) throw new Error("ESPN returned no games; keeping the cached week");
      // ESPN drops the point spread once a game is final. Keep the last line we
      // saw so "riskiest pick", the recap, and reminders still know it.
      const prior = new Map((cached?.games || []).filter((g) => g.odds).map((g) => [g.id, g.odds]));
      const checked = new Set((cached?.games || []).filter((g) => g.oddsChecked).map((g) => g.id));
      let lookups = 0;
      for (const g of fresh.games || []) {
        if (!g.odds && prior.has(g.id)) g.odds = prior.get(g.id);
        if (checked.has(g.id)) g.oddsChecked = true;
        // A final with no line on record (cold cache, or it finished before we
        // remembered lines): ask the game summary once for the closing line.
        if (!g.odds && g.completed && !g.oddsChecked && lookups < 4) {
          lookups++;
          try { g.odds = await fetchClosingLine(g.id); } catch {}
          g.oddsChecked = true;
        }
      }
      cached = fresh;
      await setJSON(store, key, cached);
    } catch (e) {
      if (!cached) throw e; // no cache and no network: bubble up
    }
  }
  return cached;
}

/* Load every schedule the evaluation needs: weeks 1..current(+1), the sudden
   death week (deadline), and any week that already has a pick on file. */
async function getSchedules(store, cfg, pickWeeks, now, overrides = {}) {
  const schedules = {};
  const total = cfg.totalWeeks ?? 18;
  let w = 1;
  while (w <= total) {
    schedules[w] = await getSchedule(store, cfg, w, now);
    const allDone = schedules[w].games.length && schedules[w].games.every((g) => g.completed || overrides[g.id]);
    if (!allDone) break;
    w++;
  }
  const cur = Math.min(w, total);
  const wanted = new Set([cur, Math.min(cur + 1, total), cfg.suddenDeathWeek ?? 4, ...pickWeeks]);
  await Promise.all([...wanted]
    .filter((wk) => wk >= 1 && wk <= total && !schedules[wk])
    .map((wk) => getSchedule(store, cfg, wk, now).then((s) => { schedules[wk] = s; })));
  return schedules;
}

async function loadLeague(store, cfg, now) {
  const S = cfg.seasonYear;
  const [roster, slotsDoc, payments, revivals, overrides] = await Promise.all([
    loadDoc(store, KEYS.roster(S), { players: [] }),
    loadDoc(store, KEYS.slots(S), { slots: [] }),
    loadDoc(store, KEYS.payments(S), { entries: [] }),
    loadDoc(store, KEYS.revivals(S), { entries: [] }),
    loadDoc(store, KEYS.overrides(S), {}),
  ]);
  const pickBlobs = await listJSON(store, KEYS.pickPrefix(S));
  const picksBySlot = {};
  const pickWeeks = new Set();
  for (const { key, value } of pickBlobs) {
    const [, , slotId, week] = key.split(":");
    (picksBySlot[slotId] = picksBySlot[slotId] || {})[Number(week)] = value;
    pickWeeks.add(Number(week));
  }
  const schedules = await getSchedules(store, cfg, pickWeeks, now, overrides);
  return { S, roster, slotsDoc, payments, revivals, overrides, picksBySlot, schedules };
}

function nextKickoffOf(sched, now) {
  const future = (sched?.games || []).map((g) => new Date(g.date)).filter((d) => d > now).sort((a, b) => a - b);
  return future[0]?.toISOString() ?? null;
}

/* Rebuild the public snapshot, persisting any rule-8 defaults that just
   locked in. A short-lived lock coalesces the thundering herd: when many
   viewers hit a stale snapshot at once, one rebuilds and the rest are
   served the latest stored snapshot. Write paths pass force:true. */
async function rebuild(store, cfg, now = new Date(), { force = false, existing = null } = {}) {
  const S0 = cfg.seasonYear;
  const lockKey = `rebuildlock:${S0}`;
  if (!force) {
    // Compare-and-set: exactly one caller in a burst takes the lock; the
    // rest serve the stored snapshot instead of each rebuilding the league.
    let held = false;
    await mutateDoc(store, lockKey, null, (lock) => {
      if (lock?.at && now - new Date(lock.at) < 15000) { held = true; return undefined; }
      return { at: now.toISOString() };
    }, 2).catch(() => {});
    if (held) {
      const current = existing || await getJSON(store, KEYS.snapshot(S0));
      if (current) return current;
    }
  }

  const { S, roster, slotsDoc, payments, revivals, overrides, picksBySlot, schedules } = await loadLeague(store, cfg, now);
  const snap = computeStandings({
    cfg, players: roster.players, slots: slotsDoc.slots, picksBySlot,
    revivals: revivals.entries, payments, schedules, overrides, now,
  });

  await Promise.all(snap.slots.filter((row) => row.status === "buyback-available")
    .map((row) => clearStalePick(store, S, row, row, picksBySlot[row.id] || {})));

  // Persist virtual defaults so they become part of the permanent record.
  // Re-check the blob first so racing rebuilds don't double-log the default pick.
  const defaults = [];
  for (const row of snap.slots) {
    for (const [w, rec] of Object.entries(row.weeks)) {
      if (rec?.virtual && rec.team) { defaults.push({ row, w, rec }); rec.virtual = false; }
    }
  }
  await Promise.all(defaults.map(async ({ row, w, rec }) => {
    const already = await getJSON(store, KEYS.pick(S, row.id, w));
    if (already) return;
    await setJSON(store, KEYS.pick(S, row.id, w), { team: rec.team, ts: now.toISOString(), actor: "system", source: "auto-default" });
    await appendLog(store, S, {
      action: "auto-default", slotId: row.id, slotLabel: row.label, week: Number(w),
      after: rec.team, note: "No pick at final kickoff; granted the default pick",
    });
  }));

  snap.nextKickoff = nextKickoffOf(schedules[snap.week], now);
  await setJSON(store, KEYS.snapshot(S), snap);
  return snap;
}

/* O(one slot) snapshot refresh for pick/unpick/buy-back writes: re-evaluate
   just the touched slot, splice it into the stored snapshot, and recompute
   aggregates. Falls back to a full rebuild when the snapshot is missing. */
async function refreshSlotSnapshot(store, cfg, slotId, now = new Date(), pre = {}) {
  const S = cfg.seasonYear;
  const [roster, slotsDoc, payments, revivals, overrides] = await Promise.all([
    pre.roster || loadDoc(store, KEYS.roster(S), { players: [] }),
    pre.slotsDoc || loadDoc(store, KEYS.slots(S), { slots: [] }),
    pre.payments || loadDoc(store, KEYS.payments(S), { entries: [] }),
    pre.revivals || loadDoc(store, KEYS.revivals(S), { entries: [] }),
    pre.overrides || loadDoc(store, KEYS.overrides(S), {}),
  ]);
  const slot = slotsDoc.slots.find((s) => s.id === slotId && !s.withdrawn);
  if (!slot) return rebuild(store, cfg, now, { force: true });
  let picks = pre.picks;
  if (!picks) {
    picks = {};
    for (const { key, value } of await listJSON(store, KEYS.pickPrefix(S, slotId))) picks[Number(key.split(":")[3])] = value;
  }
  const schedules = pre.schedules || await getSchedules(store, cfg, new Set(Object.keys(picks).map(Number)), now, overrides);
  const evaluation = evaluateSlot({ slot, picks, revivals: revivals.entries, schedules, overrides, cfg, now });
  await clearStalePick(store, S, slot, evaluation, picks);
  const row = {
    id: slot.id, label: slot.label, playerId: slot.playerId,
    playerName: roster.players.find((p) => p.id === slot.playerId)?.name || slot.label,
    ...evaluation,
  };
  // Splice under compare-and-set so two simultaneous picks never drop each other,
  // and keep the stored snapshot's clock: a write must not postpone the next rebuild
  // that reveals picks whose games just kicked off.
  let next = null;
  await mutateDoc(store, KEYS.snapshot(S), null, (snap) => {
    if (!snap?.slots) return undefined;
    const rows = snap.slots.filter((r) => r.id !== slotId);
    rows.push(row);
    next = { builtAt: snap.builtAt, ...aggregateStandings(rows, { cfg, slots: slotsDoc.slots, payments, schedules, now, overrides }) };
    next.nextKickoff = snap.nextKickoff ?? nextKickoffOf(schedules[next.week], now);
    return next;
  });
  if (!next) return rebuild(store, cfg, now, { force: true });
  return next;
}

function snapshotIsStale(snap, now) {
  if (!snap?.builtAt) return true;
  const age = (now - new Date(snap.builtAt)) / 1000;
  if (snap.nextKickoff && now >= new Date(snap.nextKickoff) && age > 30) return true;
  if (snap.liveNow) return age > 45;
  return age > 300;
}

/* PIN guessing: 8 misses in 15 minutes locks that account (and that IP) for 15 minutes. */
const AUTH_MAX = 8, AUTH_WINDOW_MS = 15 * 60e3;
const authKeys = (S, id, ip) => [`authfail:${S}:${id}`, ...(ip ? [`authfail:${S}:ip:${ip}`] : [])];
async function authLocked(store, S, id, ip, now) {
  for (const k of authKeys(S, id, ip)) {
    const d = await getJSON(store, k).catch(() => null);
    if (d?.until && now < new Date(d.until)) return true;
  }
  return false;
}
async function authMiss(store, S, id, ip, now) {
  for (const k of authKeys(S, id, ip)) {
    await mutateDoc(store, k, { n: 0, first: null }, (d) => {
      if (!d.first || now - new Date(d.first) > AUTH_WINDOW_MS) { d.n = 0; d.first = now.toISOString(); d.until = null; }
      d.n += 1;
      if (d.n >= AUTH_MAX) d.until = new Date(now.getTime() + AUTH_WINDOW_MS).toISOString();
      return d;
    }, 2).catch(() => {});
  }
}
async function authHit(store, S, id) { try { await store.delete(`authfail:${S}:${id}`); } catch {} }

/* A row as the client renders it. 285 slots x 18 weeks of kickoff/opponent
   metadata the UI never reads was most of the /api/state payload. */
const WEEK_KEEP = ["team", "result", "locked", "source", "buyback", "buybackBy", "note", "hidden"];
function slimRow(r) {
  const weeks = {};
  for (const [w, rec] of Object.entries(r.weeks || {})) {
    if (!rec) continue;
    const o = {};
    for (const k of WEEK_KEEP) if (rec[k] !== undefined && rec[k] !== null) o[k] = rec[k];
    weeks[w] = o;
  }
  const { slotId: _sid, ...rest } = r;
  return { ...rest, weeks };
}

/* Self-serve sign-ups end when week 1's last game kicks off. Returns the reason, or null. */
async function joinClosedReason(store, cfg, now) {
  if (!cfg.joinOpen) return "Sign-ups are closed. Text the commissioner.";
  try {
    const games = (await getSchedule(store, cfg, 1, now)).games || [];
    const last = games.slice().sort((x, y) => new Date(x.date) - new Date(y.date)).pop();
    if (last && gameStarted(last, now)) return "Sign-ups closed when Week 1's last game kicked off. Text the commissioner if you still want in.";
  } catch {} // no schedule on hand: fall back to the switch alone
  return null;
}
const MAX_HOUSEHOLD = 10;
const csvSafe = (s) => (/^[=+\-@\t\r]/.test(s) ? " " + s : s); // a leading space defuses spreadsheet formulas
/* Chat keys sort by time; a per-instance counter keeps same-millisecond posts in order. */
let chatSeq = 0;
const chatKey = (S) => `chat:${S}:${Date.now().toString().padStart(14, "0")}-${String(chatSeq++ % 10000).padStart(4, "0")}-${randomBytes(2).toString("hex")}`;

/* ---------- the Host ---------- */
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString("en-US", { timeZone: LEAGUE_TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " " + tzLabel() : "");
const tzParts = (now) => {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: LEAGUE_TZ, weekday: "short", hour: "numeric", hour12: false, month: "short", day: "numeric" }).formatToParts(now);
  const get = (t) => p.find((x) => x.type === t)?.value;
  return { weekday: get("weekday"), hour: Number(get("hour")) % 24, label: `${get("weekday")} ${get("month")} ${get("day")}` };
};
const tzDay = (now) => new Intl.DateTimeFormat("en-CA", { timeZone: LEAGUE_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
const spreadText = (g, team) => {
  const d = g?.odds?.details;
  if (!d) return null;
  if (/EVEN|PK/i.test(d)) return "PK";
  const m = d.match(/^([A-Z]{2,4})\s*(-?\d+(\.\d+)?)/);
  if (!m) return null;
  const n = Math.abs(parseFloat(m[2]));
  const side = g.home?.abbr === m[1] ? g.home : g.away?.abbr === m[1] ? g.away : null;
  return side?.name === team ? `-${n}` : `+${n}`;
};
const hostName = (cfg) => String(cfg.hostName || DEFAULT_HOST_NAME).trim() || DEFAULT_HOST_NAME;
const HOST_REPLY_GAP_MS = 15000, HOST_REPLIES_PER_DAY = 40, HOST_UNPROMPTED_PER_DAY = 3, HOST_UNPROMPTED_GAP_MS = 3 * 3600e3;
/* Overheard pick talk is a much colder tap than a summons: he can pass, and a
   pass still costs an API call, so throttle by attempt, not by reply. */
const HOST_CHIME_GAP_MS = 6 * 60e3, HOST_CHIME_ATTEMPTS_PER_DAY = 60;

/* Everything the host may know: the anonymous public view, never a hidden pick. */
async function hostContext(store, cfg, now) {
  const S = cfg.seasonYear;
  let snap = await getJSON(store, KEYS.snapshot(S));
  if (!snap?.slots) snap = await rebuild(store, cfg, now, { force: true });
  const week = snap.week;
  const [sched, prevSched, revivals, roster] = await Promise.all([
    getSchedule(store, cfg, week, now).catch(() => ({ games: [] })),
    week > 1 ? getSchedule(store, cfg, week - 1, now).catch(() => ({ games: [] })) : Promise.resolve({ games: [] }),
    loadDoc(store, KEYS.revivals(S), { entries: [] }),
    loadDoc(store, KEYS.roster(S), { players: [] }),
  ]);
  const rows = (snap.slots || []).map((r) => publicSlotView(r, false, week));
  const games = sched.games || [];
  const results = [], chalk = {}, eliminated = [];
  let missing = 0;
  for (const r of rows) {
    const rec = r.weeks?.[week];
    if (r.status !== "dead" && !rec?.team && !rec?.hidden) missing++;
    if (!rec?.team || rec.locked !== true) continue;
    chalk[rec.team] = (chalk[rec.team] || 0) + 1;
    const g = gameForTeam(games, rec.team);
    const entry = { slot: r.label, team: rec.team, spread: g ? spreadText(g, rec.team) : null, result: rec.result };
    if (rec.result === "loss" || (rec.result === "win" && entry.spread && parseFloat(entry.spread) > 0)) results.push(entry);
    if (r.status === "dead" && r.eliminatedWeek === week) eliminated.push({ slot: r.label, team: rec.team });
  }
  /* Which football day this is, from the schedule rather than the calendar, so
     a December Saturday slate or a Friday international game counts and a dead
     Wednesday does not. The week can roll over on Tuesday, so last week's games
     are in the pile too. */
  const today = tzDay(now);
  const yesterday = tzDay(new Date(now.getTime() - 24 * 3600e3));
  const allGames = [...games, ...(prevSched.games || [])];
  const gameDay = {
    today: allGames.some((g) => g.date && tzDay(new Date(g.date)) === today),
    yesterday: allGames.some((g) => g.date && tzDay(new Date(g.date)) === yesterday),
  };
  const kick = (g) => g ? `${g.away?.name} at ${g.home?.name}, ${fmtTime(g.date)}` : null;
  const sorted = games.slice().sort((x, y) => new Date(x.date) - new Date(y.date));
  const lt = tzParts(now);
  const hooks = [];
  if (eliminated.length) hooks.push(`${eliminated.length} torch(es) snuffed this week: ${eliminated.slice(0, 8).map((e) => `${e.slot} on ${e.team}`).join(", ")}`);
  const upsets = results.filter((x) => x.result === "win" && parseFloat(x.spread) >= 3);
  if (upsets.length) hooks.push(`underdogs that survived: ${upsets.slice(0, 6).map((x) => `${x.team} (${x.spread})`).join(", ")}`);
  if (lt.weekday === "Thu" && lt.hour >= 9 && lt.hour < 13) hooks.push(`Thursday pick day, ${missing} slot(s) still without a pick`);
  if (lt.weekday === "Sun" && lt.hour >= 8 && lt.hour < 10) hooks.push(`Sunday kickoff morning, ${missing} slot(s) still without a pick`);
  if (snap.liveNow) hooks.push("games are live right now");
  return {
    gameDay,
    context: {
      now: `${lt.label}, ${fmtTime(now.toISOString())}`, week, liveNow: !!snap.liveNow, pot: `$${Number(snap.pot?.total || 0).toLocaleString()}`,
      entries: snap.totalSlots, alive: snap.aliveCount, dead: snap.deadCount, players: roster.players.length,
      picksStillMissingThisWeek: missing, firstKickoff: kick(sorted[0]), lastKickoff: kick(sorted[sorted.length - 1]),
      chalk: Object.entries(chalk).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([team, n]) => ({ team, n })),
      notableResults: results.slice(0, 20), eliminatedThisWeek: eliminated.slice(0, 12),
      buybacksPending: revivals.entries.filter((r) => r.status === "pending").length,
      hallOfFame: (cfg.hallOfFame || []).slice(-3), commissioners: (cfg.contacts || []).map((c) => c.name).filter(Boolean),
    },
    hooks,
  };
}
async function recentChat(store, S, n = 20) {
  const keys = (await listKeys(store, KEYS.chat(S))).slice(-n);
  const values = await getManyJSON(store, keys);
  return values.filter(Boolean).map((m) => ({ name: m.name, text: m.text, bot: !!m.bot }));
}
async function postHostLine(store, cfg, text, extra = {}) {
  const S = cfg.seasonYear;
  const key = chatKey(S);
  await setJSON(store, key, { ts: new Date().toISOString(), name: hostName(cfg), bot: true, text: cleanText(text, cfg.chatBlocklist), ...extra });
  return key;
}
const hostStateOf = (doc, now) => {
  const d = doc || {};
  const day = tzDay(now);
  return { on: d.on !== false, muteUntil: d.muteUntil || null, day: d.day === day ? day : day, replies: d.day === day ? d.replies || 0 : 0, attempts: d.day === day ? d.attempts || 0 : 0, unprompted: d.day === day ? d.unprompted || 0 : 0, lastReplyAt: d.lastReplyAt || null, lastAttemptAt: d.lastAttemptAt || null, lastUnpromptedAt: d.lastUnpromptedAt || null, lastError: d.lastError || null, lastLine: d.lastLine || null };
};

/* ---- the snuffing ----
   When a slot's status turns dead, the host names that person and says the
   words, once, ever. Two properties matter more here than wit: it lands close
   to the final whistle, and it never repeats.

   Dead is the only trigger. A week 1 to 3 loss is buy-back limbo, not a
   funeral, and eliminatedWeek is the week of the losing pick, not the week the
   death was recognised, so there is no week filter here at all: the ledger of
   announced slot ids is what makes it fire once. The ledger gets its own blob
   because the chat and desk paths rewrite the host doc wholesale, which would
   quietly eat a list stored there. */
const SNUFF_LEDGER_MAX = 400, SNUFF_NAMES_SHOWN = 6;

const snuffNames = (list) => list.map((x) => `${x.name}${x.team ? ` (${x.team})` : ""}`).join(". ");
/* The ritual cannot depend on the model being up, so there is always a line. */
const snuffFallbackLine = (shown, more) => `${snuffNames(shown)}.${more ? ` And ${more} more.` : ""} The tribe has spoken. 🔥`;

async function announceSnuffs(store, cfg, now) {
  const S = cfg.seasonYear;
  let snap = await getJSON(store, KEYS.snapshot(S));
  // A funeral does not wait for a spectator to open the app and warm this up.
  if (!snap?.slots || snapshotIsStale(snap, now)) snap = await rebuild(store, cfg, now, { force: true });
  const dead = (snap.slots || []).filter((r) => r.status === "dead");
  if (!dead.length) return null;

  // Claim before speaking. A crash can lose one funeral; two ticks running at
  // the same time can never bury the same person twice.
  let fresh = [];
  await mutateDoc(store, KEYS.snuffed(S), null, (doc) => {
    const seen = new Set(doc?.ids || []);
    fresh = dead.filter((r) => !seen.has(r.id));
    if (!fresh.length) return undefined;
    return { ids: [...(doc?.ids || []), ...fresh.map((r) => r.id)].slice(-SNUFF_LEDGER_MAX), at: now.toISOString() };
  });
  if (!fresh.length) return null;

  // The slot label is the person's name (plus "(2)" on extra entries), and the
  // team they died on is a locked pick, so it is already public.
  const named = fresh.map((r) => ({ name: r.label, team: r.weeks?.[r.eliminatedWeek]?.team || null }));
  const shown = named.slice(0, SNUFF_NAMES_SHOWN), more = named.length - shown.length;
  let line = null;
  try {
    const [{ context }, recent] = await Promise.all([hostContext(store, cfg, now), recentChat(store, S, 12)]);
    line = await askHost({ cfg: { ...cfg, hostName: hostName(cfg) }, context, recent, trigger: { kind: "snuff", snuffed: shown, more } });
  } catch { /* fall through to the fallback: a ritual must not silently vanish */ }
  const text = line || snuffFallbackLine(shown, more);
  await postHostLine(store, cfg, text, { snuff: true });
  return { count: named.length, line: text, wrote: Boolean(line) };
}

const RESERVED_NAMES = /^(the\s+)?(commissioner|commish|admin|administrator|system)$/i;
const PHONE_RE = /^[\d\s()+.-]{7,20}$/;

const publicCfg = (cfg) => ({
  leagueName: cfg.leagueName, seasonYear: cfg.seasonYear, buyIn: cfg.buyIn, buybackFee: cfg.buybackFee,
  suddenDeathWeek: cfg.suddenDeathWeek, totalWeeks: cfg.totalWeeks, maxSlotsPerPlayer: cfg.maxSlotsPerPlayer,
  venmo: cfg.venmo, joinOpen: cfg.joinOpen, rulesText: cfg.rulesText, hallOfFame: cfg.hallOfFame || [],
  contacts: cfg.contacts || [], leagueNote: cfg.leagueNote || "", joinNote: cfg.joinNote || "", hostName: hostName(cfg),
  established: cfg.established || "", timeZone: LEAGUE_TZ, tzLabel: tzLabel(),
});

/* ---------- request handler ---------- */

const hasEmail = (p) => /^\S+@\S+\.\S+$/.test(String(p?.email || "").trim());
const escHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* Reminder email, HTML. Inline styles and tables because mail clients. */
function reminderHTML(p) {
  const e = escHtml;
  const slotRow = (x) => {
    const line = x.dead
      ? `<span style="color:#8b93a1;">Out this season</span>`
      : x.missing
        ? `<span style="color:#d50a0a;font-weight:700;">No pick yet</span> &nbsp;<a href="${e(p.links.picks)}" style="color:#0074ee;font-weight:700;">Pick now</a>`
        : `<b>${e(x.team)}</b>${x.spread ? ` <span style="color:#67748a;">(${e(x.spread)})</span>` : ""} ${e(x.homeAway)} ${x.oppLogo ? `<img src="${e(x.oppLogo)}" width="16" height="16" alt="" style="vertical-align:-3px;">` : ""} ${e(x.opponent || "TBD")}<br><span style="color:#67748a;font-size:12px;">${e(x.kickoffText)}${x.locked ? " · locked" : ""}</span>`;
    const art = x.logo && !x.missing && !x.dead
      ? `<img src="${e(x.logo)}" width="36" height="36" alt="" style="display:block;">`
      : `<div style="width:36px;height:36px;border-radius:18px;border:2px ${x.dead ? "solid #c6cfdc" : "dashed #d50a0a"};box-sizing:border-box;text-align:center;line-height:32px;color:${x.dead ? "#8b93a1" : "#d50a0a"};font-family:Arial,sans-serif;font-weight:700;">${x.dead ? "&#215;" : "?"}</div>`;
    return `<tr><td style="padding:10px 0;border-bottom:1px solid #e5e9f0;"><table role="presentation" cellspacing="0" cellpadding="0"><tr><td width="46" valign="top" style="padding-top:2px;">${art}</td><td valign="top" style="font-family:Inter,Arial,sans-serif;font-size:14px;color:#0d1521;"><div style="font-weight:700;">${e(x.label)}</div><div style="margin-top:2px;">${line}</div></td></tr></table></td></tr>`;
  };
  const logoImg = (src) => src ? `<img src="${e(src)}" width="18" height="18" alt="" style="vertical-align:-4px;"> ` : "";
  const gameHTML = (gm, fallback) => gm
    ? `${logoImg(gm.awayLogo)}${e(gm.away)} at ${logoImg(gm.homeLogo)}${e(gm.home)} <span style="color:#67748a;">· ${e(gm.kickoffText)}</span>`
    : e(fallback || "TBD");
  const contacts = (p.contacts || []).filter((c) => c?.phone).map((c) =>
    `<a href="tel:${e(String(c.phone).replace(/[^\d+]/g, ""))}" style="color:#0074ee;font-weight:700;text-decoration:none;">${e(c.name)} ${e(c.phone)}</a>`).join(" &nbsp;or&nbsp; ");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${e(p.subject)}</title></head>
<body style="margin:0;background:#f2f4f7;padding:20px 0;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;">
  ${p.test ? `<tr><td style="background:#FFB612;color:#0A1929;font-family:Arial,sans-serif;font-size:12px;font-weight:700;padding:8px 24px;letter-spacing:.06em;">TEST SEND · ONLY YOU RECEIVED THIS</td></tr>` : ""}
  <tr><td style="background:#0A1929;padding:18px 24px;">
    <div style="font-family:'Arial Narrow',Arial,sans-serif;font-weight:800;font-size:20px;letter-spacing:.04em;color:#FFB612;text-transform:uppercase;">${e(p.leagueName)}</div>
    <div style="font-family:Arial,sans-serif;font-size:13px;color:#8FA3B8;margin-top:2px;">Week ${p.week} reminder</div>
  </td></tr>
  <tr><td style="padding:22px 24px 6px;font-family:Inter,Arial,sans-serif;font-size:15px;color:#0d1521;">Hey ${e(p.player.split(" ")[0])}, here is where your slots stand for Week ${p.week}.</td></tr>
  <tr><td style="padding:0 24px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${p.slots.map(slotRow).join("")}</table></td></tr>
  <tr><td style="padding:16px 24px 0;font-family:Inter,Arial,sans-serif;font-size:13px;color:#35404f;line-height:1.7;">
    <b>First kickoff:</b> ${gameHTML(p.firstGame, p.firstKickoffText)}<br>
    <b>Last kickoff:</b> ${gameHTML(p.lastGame, p.lastKickoffText)}<br>
    <span style="color:#67748a;">A slot with no pick by the last kickoff gets the <a href="${e(p.links.rules)}" style="color:#0074ee;font-weight:700;text-decoration:none;">default pick</a>.</span>
  </td></tr>
  <tr><td style="padding:14px 24px 0;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="background:#f2f4f7;border-left:3px solid #FFB612;border-radius:6px;padding:10px 12px;font-family:Inter,Arial,sans-serif;font-size:13px;color:#35404f;line-height:1.5;"><b>Rules reminder:</b> you can make, change, or remove a pick for any game right up until that game's scheduled kickoff. Once it kicks off, that game is off the board. <a href="${e(p.links.rules)}" style="color:#0074ee;font-weight:700;text-decoration:none;">Full rules</a></td></tr></table></td></tr>
  <tr><td style="padding:18px 24px 6px;">
    <a href="${e(p.links.picks)}" style="display:inline-block;background:#003369;color:#ffffff;text-decoration:none;font-family:Arial,sans-serif;font-weight:700;font-size:14px;padding:12px 18px;border-radius:9px;">Make or change a pick</a>
    &nbsp;&nbsp;<a href="${e(p.links.board)}" style="display:inline-block;color:#003369;text-decoration:none;font-family:Arial,sans-serif;font-weight:700;font-size:14px;padding:12px 18px;border:1px solid #c6cfdc;border-radius:9px;">Who's left</a>
  </td></tr>
  <tr><td style="padding:16px 24px 22px;font-family:Inter,Arial,sans-serif;font-size:13px;color:#35404f;">Questions? Text ${contacts || "the commissioner"}.</td></tr>
  <tr><td style="padding:12px 24px 18px;border-top:1px solid #e5e9f0;font-family:Arial,sans-serif;font-size:11px;color:#8b93a1;line-height:1.5;">You are getting this because you have a slot in the ${e(p.leagueName)}. Want fewer emails? Manage your reminders in <a href="${e(p.links.account)}" style="color:#8b93a1;font-weight:700;">Account settings</a>.</td></tr>
</table></td></tr></table></body></html>`;
}

function reminderText(p) {
  const lines = [];
  if (p.test) lines.push("TEST SEND. Only you received this.", "");
  lines.push(`${p.leagueName}: Week ${p.week} picks`, "", `Hey ${p.player.split(" ")[0]}, here is where your slots stand.`, "");
  for (const x of p.slots) {
    if (x.dead) lines.push(`${x.label}: out this season`);
    else if (x.missing) lines.push(`${x.label}: NO PICK YET. Pick now: ${p.links.picks}`);
    else lines.push(`${x.label}: ${x.team}${x.spread ? ` (${x.spread})` : ""} ${x.homeAway} ${x.opponent || "TBD"}, ${x.kickoffText}${x.locked ? ", locked" : ""}`);
  }
  const gameTxt = (gm, fb) => gm ? `${gm.away} at ${gm.home}, ${gm.kickoffText}` : fb;
  lines.push("", `First kickoff: ${gameTxt(p.firstGame, p.firstKickoffText)}`, `Last kickoff: ${gameTxt(p.lastGame, p.lastKickoffText)}`, `No pick by the last kickoff and the default-pick rule picks for you: ${p.links.rules}`, "",
    "Rules reminder: you can make, change, or remove a pick for any game right up until that game's scheduled kickoff. Once it kicks off, that game is off the board.", "",
    `Make or change a pick: ${p.links.picks}`, `Who's left: ${p.links.board}`, "",
    `Questions? Text ${(p.contacts || []).filter((c) => c?.phone).map((c) => `${c.name} ${c.phone}`).join(" or ") || "the commissioner"}.`, "",
    `You are getting this because you have a slot in the ${p.leagueName}. Want fewer emails? Manage your reminders in Account settings: ${p.links.account}`);
  return lines.join("\n");
}

export default async (req, context) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const method = req.method;
  const store = blobStore();
  const now = new Date();

  let cfg = await getJSON(store, KEYS.cfg);

  /* Bootstrap: one-time league creation. Refused once a config exists. */
  if (path === "/api/bootstrap" && method === "POST") {
    if (cfg) return bad("League already initialized.", 409);
    const b = await readBody(req);
    if (!b.adminPin || String(b.adminPin).length < 4) return bad("adminPin (4+ chars) required.");
    cfg = {
      leagueName: b.leagueName || "NFL Survivor League",
      seasonYear: b.seasonYear || (now.getUTCMonth() < 2 ? now.getUTCFullYear() - 1 : now.getUTCFullYear()), // Jan and Feb belong to last season
      totalWeeks: 18,
      buyIn: b.buyIn ?? 10,
      buybackFee: b.buybackFee ?? 10,
      suddenDeathWeek: b.suddenDeathWeek ?? 4,
      maxSlotsPerPlayer: b.maxSlotsPerPlayer ?? 3,
      venmo: b.venmo || "",
      joinOpen: true,
      rulesText: String(b.rulesText || ""),
      established: String(b.established || "").slice(0, 20),
      hallOfFame: b.hallOfFame || [],
      contacts: b.contacts || [],
      adminPin: String(b.adminPin),
      secret: randomBytes(24).toString("hex"),
      createdAt: now.toISOString(),
    };
    if (!cfg.rulesText) cfg.rulesText = defaultRulesText(cfg);
    await setJSON(store, KEYS.cfg, cfg);
    await appendLog(store, cfg.seasonYear, { action: "bootstrap", actor: "admin", note: `League created for ${cfg.seasonYear}` });
    return json({ ok: true, adminToken: makeToken("admin", cfg.secret) });
  }

  if (!cfg) return bad("League not initialized yet.", 503);
  const S = cfg.seasonYear;
  const secret = cfg.secret;

  const authSubject = (body) => verifyToken(body?.token || url.searchParams.get("token"), secret);
  const clientIp = context?.ip || req.headers.get("x-nf-client-connection-ip") || "";
  const isAdminSub = (sub) => sub === "admin";

  try {
    /* ----- public reads ----- */

    if (path === "/api/state" && method === "GET") {
      let snap = await getJSON(store, KEYS.snapshot(S));
      if (snapshotIsStale(snap, now) || snap?.pot?.total === undefined || snap?.pot?.buybacks === undefined) { // pot shape changed: rebuild once
        try {
          snap = await rebuild(store, cfg, now, { existing: snap });
        } catch (e) {
          if (!snap) throw e; // nothing to degrade to
          console.error("rebuild failed; serving stale snapshot", e); // e.g. ESPN outage with cold cache
        }
      }
      const roster = await loadDoc(store, KEYS.roster(S), { players: [] });
      // Players see the pot total only. Paid/unpaid detail is commissioner business.
      const publicSnap = { ...snap, pot: { total: snap.pot?.total ?? 0, entries: snap.pot?.entries ?? 0, buybackCash: snap.pot?.buybackCash ?? 0, buybacks: snap.pot?.buybacks ?? 0, buyIn: snap.pot?.buyIn ?? cfg.buyIn } };
      delete publicSnap.splitPreview;

      // Anti-sniping: picks are invisible league-wide until their game starts.
      // A valid token unlocks only your own and your household's slots; the
      // commissioner sees everything.
      const sub = authSubject(null);
      const privileged = sub && isAdminSub(sub);
      const mineIds = new Set();
      if (sub && !privileged) {
        const slotsDocV = await loadDoc(store, KEYS.slots(S), { slots: [] });
        const managedV = new Set(roster.players.filter((p) => p.managedBy === sub).map((p) => p.id));
        for (const s2 of slotsDocV.slots) if (s2.playerId === sub || managedV.has(s2.playerId)) mineIds.add(s2.id);
      }
      publicSnap.slots = (snap.slots || []).map((r) => (privileged ? r : publicSlotView(r, mineIds.has(r.id), snap.week)));
      publicSnap.slots = publicSnap.slots.map(slimRow);
      delete publicSnap.riders; // the client derives riders from revealed rows itself

      // Your own tab, nobody else's: an unpaid buy-in plus any buy-back you have
      // declared that the commissioner has not marked received yet. The buy-back
      // button stopped shoving people at Venmo, so the bill lives here instead.
      let owed = null;
      if (sub && !privileged && mineIds.size) {
        const [paymentsV, revivalsV] = await Promise.all([
          loadDoc(store, KEYS.payments(S), { entries: [] }),
          loadDoc(store, KEYS.revivals(S), { entries: [] }),
        ]);
        const live = paymentsV.entries.filter((p) => !p.voided);
        const paidBuyin = new Set(live.filter((p) => p.type === "buyin").map((p) => p.slotId));
        owed = [...mineIds].map((id) => {
          const weeks = revivalsV.entries.filter((r) => r.slotId === id && r.status === "pending").map((r) => r.lossWeek).sort((a, c) => a - c);
          const buyin = paidBuyin.has(id) ? 0 : Number(cfg.buyIn ?? 10);
          return { slotId: id, buyin, buybackWeeks: weeks, total: buyin + weeks.length * Number(cfg.buybackFee ?? 10) };
        }).filter((x) => x.total > 0);
      }

      return json({
        snapshot: publicSnap,
        owed,
        cfg: publicCfg(cfg),
        players: roster.players.map((p) => ({ id: p.id, name: p.name, managedBy: p.managedBy || null })),
        serverNow: now.toISOString(),
        appVersion: APP_BUILD,
        hostReady: hostConfigured(),
        mailReady: mailConfig().ready,
        // Counts only, never addresses: lets the commissioner see reminder reach.
        contactCoverage: {
          players: roster.players.length,
          withEmail: roster.players.filter((p) => hasEmail(p)).length,
          withPhone: roster.players.filter((p) => String(p.phone || "").replace(/\D/g, "").length >= 10).length,
          // heads of household we cannot email (members ride on their manager's address)
          missingEmailHeads: roster.players.filter((p) => !p.managedBy && !hasEmail(p)).map((p) => p.name).sort(),
        },
      });
    }

    if (path === "/api/scores" && method === "GET") {
      const wParam = url.searchParams.get("week");
      let week = wParam ? Number(wParam) : null;
      if (!week) {
        const snap = await getJSON(store, KEYS.snapshot(S));
        week = snap?.week || 1;
      }
      if (week < 1 || week > (cfg.totalWeeks ?? 18)) return bad("Bad week.");
      const sched = await getSchedule(store, cfg, week, now);
      const overrides = await loadDoc(store, KEYS.overrides(S), {});
      return json({ ...sched, overrides });
    }

    // Win probability per team for a week, from SurvivorGrid's W% column.
    // Cached an hour at a time; frozen once the site has moved on to a later week.
    if (path === "/api/winprob" && method === "GET") {
      let week = Number(url.searchParams.get("week")) || 0;
      if (!week) week = (await getJSON(store, KEYS.snapshot(S)))?.week || 1;
      if (week < 1 || week > (cfg.totalWeeks ?? 18)) return bad("Bad week.");
      const key = `winprob:${S}:w${week}`;
      let doc = await getJSON(store, key);
      // An answer with numbers is good for an hour; a miss is remembered for 10 minutes
      // so a bad week or an outage can't turn every page view into a scrape.
      const ttl = Object.keys(doc?.probs || {}).length ? 3600e3 : 600e3;
      const fresh = doc?.fetchedAt && now.getTime() - new Date(doc.fetchedAt).getTime() < ttl;
      if (!doc || (!fresh && !doc.final)) {
        try {
          const got = await fetchSurvivorGrid();
          if (got.siteWeek === week && Object.keys(got.probs).length) {
            // Keep anything captured earlier this week: the site drops a team's W%
            // once its game is final, and that number is exactly what we want to show.
            doc = { week, fetchedAt: now.toISOString(), source: "survivorgrid.com", probs: { ...(doc?.probs || {}), ...got.probs } };
            await setJSON(store, key, doc);
          } else if (doc && got.siteWeek && got.siteWeek > week) {
            doc.final = true; // the site has moved on; keep what we captured for this week
            await setJSON(store, key, doc);
          } else if (!doc) {
            doc = { week, fetchedAt: now.toISOString(), source: "survivorgrid.com", probs: {}, note: got.siteWeek ? `SurvivorGrid is showing week ${got.siteWeek}` : "SurvivorGrid unreadable" };
            await setJSON(store, key, doc);
          } else {
            doc.fetchedAt = now.toISOString(); // nothing new; wait before asking again
            await setJSON(store, key, doc);
          }
        } catch (e) {
          if (!doc) { doc = { week, fetchedAt: now.toISOString(), source: "survivorgrid.com", probs: {}, error: e.message }; await setJSON(store, key, doc); }
          else { doc.fetchedAt = now.toISOString(); await setJSON(store, key, doc); }
        }
      }
      return json(doc);
    }

    const isSend = path === "/api/reminders/send" && method === "POST";
    const sendBody = isSend ? await readBody(req) : null;
    if (((path === "/api/reminder" || path === "/api/reminders") && method === "GET") || isSend) {
      // Everything a reminder needs, built where the data lives so any
      // transport (Apps Script, Gmail, a provider) sends the same thing.
      // /api/reminder  = one household (own token, or admin + playerId)
      // /api/reminders = every head of household with an email (admin only)
      const sub = authSubject(sendBody);
      if (!sub) return bad("Log in first.", 401);
      const batch = path === "/api/reminders" || isSend;
      if (batch && !isAdminSub(sub)) return bad("Commissioner only.", 403);
      // Once Resend is configured the app mails the league itself. The old Apps
      // Script sender pulls this same list on its own Mon/Thu noon triggers, so it
      // gets refused: two senders on one schedule would double every email. Its
      // test-to-me run still builds.
      if (path === "/api/reminders" && url.searchParams.get("test") !== "1" && mailConfig().ready) return bad("The app sends reminders itself now. Delete this Apps Script's triggers (the clock icon in the script editor).", 410);
      const roster = await loadDoc(store, KEYS.roster(S), { players: [] });
      let snap = await getJSON(store, KEYS.snapshot(S));
      if (snapshotIsStale(snap, now) || snap?.pot?.total === undefined) snap = await rebuild(store, cfg, now);
      const week = snap.week;
      const games = (await getSchedule(store, cfg, week, now)).games || [];
      const origin = `${url.protocol}//${url.host}`;
      const test = isSend ? Boolean(sendBody.test) : url.searchParams.get("test") === "1";
      const fmtTime = (iso) => iso ? new Date(iso).toLocaleString("en-US", { timeZone: LEAGUE_TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " " + tzLabel() : "";
      const logoOf = (tm) => tm?.logo || (tm?.abbr ? `https://a.espncdn.com/i/teamlogos/nfl/500/${String(tm.abbr).toLowerCase()}.png` : null);
      const spreadFor = (g, team) => {
        const d = g?.odds?.details;
        if (!d) return null;
        if (/EVEN|PK/i.test(d)) return "PK";
        const m = d.match(/^([A-Z]{2,4})\s*(-?\d+(\.\d+)?)/);
        if (!m) return null;
        const n = Math.abs(parseFloat(m[2]));
        const tm = g.home?.name === team ? g.home : g.away;
        return String(tm?.abbr || "").toUpperCase() === m[1] ? `-${n}` : `+${n}`;
      };
      const kicks = games.map((g) => g.date).filter(Boolean).sort();
      const byKick = games.filter((g) => g.date).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
      const gameLine = (g) => g ? { away: g.away?.name || "", awayLogo: logoOf(g.away), home: g.home?.name || "", homeLogo: logoOf(g.home), kickoff: g.date, kickoffText: fmtTime(g.date) } : null;
      const shared = {
        week, test, leagueName: cfg.leagueName || "Survivor League",
        firstKickoff: kicks[0] || null, firstKickoffText: fmtTime(kicks[0]),
        lastKickoff: kicks[kicks.length - 1] || null, lastKickoffText: fmtTime(kicks[kicks.length - 1]),
        firstGame: gameLine(byKick[0]), lastGame: gameLine(byKick[byKick.length - 1]),
        links: { picks: `${origin}/#/picks`, board: `${origin}/`, rules: `${origin}/#/rules`, account: `${origin}/#/account` },
        contacts: cfg.contacts || [],
      };
      const payloadFor = (me) => {
        const ids = new Set([me.id, ...roster.players.filter((p) => p.managedBy === me.id).map((p) => p.id)]);
        const slots = snap.slots.filter((r) => ids.has(r.playerId)).map((r) => {
          const rec = r.weeks?.[week];
          const base = { label: r.label, status: r.status };
          if (r.status === "dead") return { ...base, dead: true };
          if (!rec?.team) return { ...base, missing: true };
          const g = gameForTeam(games, rec.team);
          const home = g?.home?.name === rec.team;
          const mineT = g ? (home ? g.home : g.away) : null;
          const oppT = g ? (home ? g.away : g.home) : null;
          return { ...base, team: rec.team, logo: logoOf(mineT), opponent: oppT?.name || null, oppLogo: logoOf(oppT), homeAway: home ? "vs" : "at",
            spread: spreadFor(g, rec.team), kickoff: g?.date || null, kickoffText: fmtTime(g?.date), locked: rec.locked === true };
        });
        const missingCount = slots.filter((x) => x.missing).length;
        return {
          ...shared, playerId: me.id, player: me.name, email: me.email || "", slots, missingCount,
          subject: `${test ? "[TEST] " : ""}${cfg.leagueName || "Survivor League"} Reminder: ${missingCount
            ? `${missingCount} slot${missingCount === 1 ? " still needs" : "s still need"} a Week ${week} pick`
            : `Your Week ${week} Picks`}`,
        };
      };
      const format = url.searchParams.get("format") || "json";
      const respond = (payload) => {
        if (format === "html") return new Response(reminderHTML(payload), { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
        if (format === "text") return new Response(reminderText(payload), { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
        return json(payload);
      };

      if (!batch) {
        let targetId = sub;
        if (isAdminSub(sub)) {
          targetId = url.searchParams.get("playerId") || "";
          if (!targetId) return bad("playerId required.", 400);
        }
        const me = roster.players.find((p) => p.id === targetId);
        if (!me) return bad("Unknown player.", 404);
        return respond(payloadFor(me));
      }

      // Batch: one email per head of household (members roll up into it).
      const missingOnly = isSend ? Boolean(sendBody.missingOnly) : url.searchParams.get("missingOnly") === "1";
      const headsAll = roster.players.filter((p) => !p.managedBy);
      const skippedNoEmail = headsAll.filter((p) => !hasEmail(p)).map((p) => p.name);
      const skippedOptedOut = headsAll.filter((p) => hasEmail(p) && p.emailOff).map((p) => p.name);
      const skippedInactive = [];
      const items = [];
      for (const me of headsAll) {
        if (!hasEmail(me) || me.emailOff) continue;
        const payload = payloadFor(me);
        const live = payload.slots.filter((x) => !x.dead);
        if (!live.length) { skippedInactive.push(me.name); continue; } // eliminated or no active slots: nothing to act on
        if (missingOnly && !payload.missingCount) continue;
        items.push({ playerId: me.id, name: me.name, email: String(me.email).trim(), subject: payload.subject, missingCount: payload.missingCount, slotCount: payload.slots.length, html: reminderHTML(payload), text: reminderText(payload) });
      }
      if (!isSend) return json({ week, builtAt: now.toISOString(), missingOnly, count: items.length, skippedNoEmail, skippedOptedOut, skippedInactive, items });

      // Send: the app mails the league itself through Resend. Once per label
      // per week unless forced; the run summary goes to the commissioner.
      const mail = mailConfig();
      if (!mail.ready) return bad(`Email sending isn't set up yet. Missing in Netlify: ${mail.missing.join(", ")}. Add ${mail.missing.length > 1 ? "them" : "it"}, then redeploy.`, 503);
      if (test) {
        // Test: one real reminder, delivered only to the commissioner's summary address.
        if (!mail.summaryTo) return bad("Set REMINDER_SUMMARY_TO in Netlify first; the test goes there.", 503);
        const sample = items.find((it) => it.email.toLowerCase() === mail.summaryTo.toLowerCase()) || items[0];
        if (!sample) return bad("Nobody to build a test from yet.", 404);
        const { sent, failed } = await sendReminderBatch({ items: [{ ...sample, email: mail.summaryTo }], from: mail.from, replyTo: mail.replyTo, apiKey: mail.apiKey });
        return json({ ok: true, test: true, week, from: mail.from, to: mail.summaryTo, basedOn: sample.name, sent, failed });
      }
      const label = missingOnly ? "missing" : "all";
      const sentKey = `remsent:${S}:${label}:w${week}`;
      const prior = await getJSON(store, sentKey);
      if (prior && !sendBody.force) return json({ ok: true, skipped: true, label, week, sentAt: prior.at, note: "Already sent this week. Send again with force to override." });
      const { sent, failed } = await sendReminderBatch({ items, from: mail.from, replyTo: mail.replyTo, apiKey: mail.apiKey });
      const summary = { ok: true, label, week, at: now.toISOString(), source: sendBody.source || "desk", sent, failed, skippedNoEmail, skippedOptedOut, skippedInactive };
      await setJSON(store, sentKey, { at: summary.at, sent: sent.length, failed: failed.length });
      if (mail.summaryTo) await sendPlain({ to: mail.summaryTo, from: mail.from, apiKey: mail.apiKey, subject: `Reminder run: ${label}, week ${week}: ${sent.length} sent, ${failed.length} failed`, text: summaryText({ ...summary, leagueName: cfg.leagueName }) }).catch(() => {});
      await appendLog(store, S, { action: "reminders-sent", actor: "commissioner", note: `${label === "missing" ? "Missing-pick" : "Weekly"} reminders for week ${week}: ${sent.length} sent, ${failed.length} failed (${summary.source})` });
      return json(summary);
    }

    if (path === "/api/news" && method === "GET") {
      const NEWS_V = 2; // bump when the item shape changes so a warm cache can't serve the old shape
      const cached = await getJSON(store, KEYS.news(S));
      if (cached && cached.v === NEWS_V && Date.now() - new Date(cached.builtAt).getTime() < 15 * 60e3) return json(cached);
      try {
        const safeLink = (raw, fallback) => (/^https:\/\//.test(String(raw || "")) ? String(raw) : fallback); // ticker hrefs render league-wide; https only
        const [espnRes, onionRes] = await Promise.allSettled([
          fetch("https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=12").then(async (r) => { if (!r.ok) throw new Error(`news feed ${r.status}`); return r.json(); }),
          fetch("https://theonion.com/sports/feed/", { headers: { "user-agent": "SurvivorLeagueApp/1.0 (ticker)" } }).then(async (r) => { if (!r.ok) throw new Error(`onion feed ${r.status}`); return r.text(); }),
        ]);
        if (espnRes.status !== "fulfilled") throw espnRes.reason;
        const espn = (espnRes.value.articles || []).slice(0, 12)
          .map((a) => ({ headline: a.headline || "", link: safeLink(a.links?.web?.href, "https://www.espn.com/nfl/"), ts: a.published || null, source: "espn" }))
          .filter((a) => a.headline);
        // The Onion's sports feed, NFL-ish items only. Satire is tagged so the
        // client can mark it; it must never read as real news.
        const NFLISH = /\b(NFL|Super Bowl|quarterback|QB|touchdown|football|Chiefs|Eagles|Cowboys|Packers|Bears|Lions|Vikings|49ers|Niners|Seahawks|Rams|Cardinals|Saints|Falcons|Buccaneers|Panthers|Patriots|Jets|Giants|Bills|Dolphins|Steelers|Ravens|Browns|Bengals|Texans|Colts|Jaguars|Titans|Broncos|Raiders|Chargers|Commanders|Mahomes|Belichick|Goodell)\b/i;
        const decode = (s) => String(s || "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&#8217;|&rsquo;/g, "\u2019").replace(/&#8216;|&lsquo;/g, "\u2018").replace(/&#8220;|&ldquo;/g, "\u201c").replace(/&#8221;|&rdquo;/g, "\u201d").replace(/&amp;/g, "&").replace(/&#8211;|&ndash;/g, "\u2013").replace(/&#8230;|&hellip;/g, "\u2026").trim();
        const onion = onionRes.status === "fulfilled"
          ? [...onionRes.value.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
              const title = decode((m[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
              const link = decode((m[1].match(/<link>([\s\S]*?)<\/link>/) || [])[1]);
              return { headline: title, link: safeLink(link, "https://theonion.com/sports/"), ts: null, source: "onion" };
            }).filter((a) => a.headline && NFLISH.test(a.headline)).slice(0, 4)
          : [];
        // Interleave: a laugh every third headline.
        const items = [];
        let oi = 0;
        espn.forEach((a, i) => { items.push(a); if ((i + 1) % 2 === 0 && oi < onion.length) items.push(onion[oi++]); });
        while (oi < onion.length) items.push(onion[oi++]);
        const doc = { v: NEWS_V, builtAt: now.toISOString(), items };
        await setJSON(store, KEYS.news(S), doc);
        return json(doc);
      } catch {
        // stale headlines beat none on game day; empty beats a 500
        return json(cached || { builtAt: now.toISOString(), items: [] });
      }
    }

    if (path === "/api/log" && method === "GET") {
      const sub = authSubject(null);
      if (!sub) return bad("Log in to see your activity.", 401);
      const limit = Math.min(Number(url.searchParams.get("limit")) || 120, 400);
      const admin = isAdminSub(sub);
      const cursor = url.searchParams.get("before") || null; // nextCursor from the page before
      const wantSlot = admin ? url.searchParams.get("slot") || null : null;
      const wantPlayer = admin ? url.searchParams.get("player") || null : null;

      // Who this page is about: everyone (commissioner, no filter), one slot or
      // one player (commissioner, filtered), or just you.
      let scope = "all";
      let slotIds = null; // null means "don't filter on slot"
      let actorId = null;
      let actorName = null;
      if (!admin || wantPlayer) {
        const who = admin ? wantPlayer : sub;
        const [roster, slotsDoc] = await Promise.all([
          loadDoc(store, KEYS.roster(S), { players: [] }),
          loadDoc(store, KEYS.slots(S), { slots: [] }),
        ]);
        const person = roster.players.find((p) => p.id === who);
        if (!person) return bad(admin ? "Unknown player." : "Unknown player.", admin ? 404 : 401);
        const managed = new Set(roster.players.filter((p) => p.managedBy === who).map((p) => p.id));
        slotIds = new Set(slotsDoc.slots.filter((x) => x.playerId === who || managed.has(x.playerId)).map((x) => x.id));
        actorId = who;
        actorName = person.name;
        scope = admin ? "player" : "mine";
      }
      if (wantSlot) { slotIds = new Set([wantSlot]); actorId = null; actorName = null; scope = "slot"; }

      // Own slots, plus actions this subject took. Older entries carry only a
      // display name; those still match by name, never the commissioner's.
      const keep = (e) => {
        if (!slotIds) return true;
        if (e.slotId && slotIds.has(e.slotId)) return true;
        if (!actorId) return false;
        return e.actorId ? e.actorId === actorId : (e.actor === actorName && e.actor !== "commissioner");
      };

      let keys = await listKeys(store, KEYS.log(S));
      if (cursor) {
        const at = keys.indexOf(cursor);
        keys = at >= 0 ? keys.slice(0, at) : keys; // a vanished cursor just reads from the top
      }
      // Walk back from the newest a chunk at a time. A filtered view can skip a
      // long way, so this pages instead of reading the season into memory, and
      // hands back a cursor whenever there is more behind it.
      const CHUNK = 250, MAX_SCAN = 3000;
      const entries = [];
      let nextCursor = null, scanned = 0;
      outer:
      for (let end = keys.length; end > 0 && scanned < MAX_SCAN; end -= CHUNK) {
        const slice = keys.slice(Math.max(0, end - CHUNK), end);
        const values = await getManyJSON(store, slice);
        scanned += slice.length;
        for (let i = slice.length - 1; i >= 0; i--) {
          const v = values[i];
          if (!v || !keep(v)) continue;
          if (entries.length >= limit) { nextCursor = entries.at(-1)._k; break outer; }
          entries.push({ ...v, _k: slice[i] });
        }
        // Stopped on the scan cap, not on the data: resume from where we stopped.
        if (scanned >= MAX_SCAN && end - CHUNK > 0) nextCursor = entries.at(-1)?._k ?? slice[0];
      }
      return json({ scope, player: actorName, slot: wantSlot, nextCursor, entries: entries.map(({ _k, ...e }) => e) });
    }

    /* CSV mirror for the legacy Google Sheet's "2026" tab (IMPORTDATA consumes it).
       Same data as the public standings; picks and buy-backs still happen in the app. */
    if (path === "/api/mirror.csv" && method === "GET") {
      let snap = await getJSON(store, KEYS.snapshot(S));
      if (snapshotIsStale(snap, now)) snap = await rebuild(store, cfg, now);
      const q = (v) => { const s2 = csvSafe(String(v ?? "")); return /[",\n]/.test(s2) ? '"' + s2.replaceAll('"', '""') + '"' : s2; };
      const ABBR = {
        "Arizona Cardinals": "ARI", "Atlanta Falcons": "ATL", "Baltimore Ravens": "BAL", "Buffalo Bills": "BUF",
        "Carolina Panthers": "CAR", "Chicago Bears": "CHI", "Cincinnati Bengals": "CIN", "Cleveland Browns": "CLE",
        "Dallas Cowboys": "DAL", "Denver Broncos": "DEN", "Detroit Lions": "DET", "Green Bay Packers": "GB",
        "Houston Texans": "HOU", "Indianapolis Colts": "IND", "Jacksonville Jaguars": "JAX", "Kansas City Chiefs": "KC",
        "Las Vegas Raiders": "LV", "Los Angeles Chargers": "LAC", "Los Angeles Rams": "LAR", "Miami Dolphins": "MIA",
        "Minnesota Vikings": "MIN", "New England Patriots": "NE", "New Orleans Saints": "NO", "New York Giants": "NYG",
        "New York Jets": "NYJ", "Philadelphia Eagles": "PHI", "Pittsburgh Steelers": "PIT", "San Francisco 49ers": "SF",
        "Seattle Seahawks": "SEA", "Tampa Bay Buccaneers": "TB", "Tennessee Titans": "TEN", "Washington Commanders": "WSH",
      };
      const total = cfg.totalWeeks ?? 18;
      const updated = now.toLocaleString("en-US", { timeZone: LEAGUE_TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " " + tzLabel();
      const lines = [];
      lines.push(`Updated,${q(updated)}`);
      lines.push(`Pot,${q("$" + Number(snap.pot?.total ?? 0).toLocaleString())}`);
      lines.push(`Still alive,${q(`${snap.aliveCount + snap.limboCount} of ${snap.totalSlots}`)}`);
      lines.push(`Week,${q(String(snap.week) + (snap.liveNow ? " · LIVE" : ""))}`);
      lines.push("");
      lines.push(["Slot", "Status", "Buy-backs", ...Array.from({ length: total }, (_, i) => `W${i + 1}`)].join(","));
      for (const r of snap.slots || []) {
        const st = standingOf(r, snap.week);
        const status = st === "safe" ? "SAFE"
          : st === "vulnerable" ? "VULNERABLE"
          : st === "limbo" ? "IN LIMBO"
          : `💀 OUT W${r.eliminatedWeek ?? "?"}`;
        const cells = [q(r.label), q(status), "💸".repeat(Math.min(r.buybacksUsed || 0, 4))];
        for (let w = 1; w <= total; w++) {
          const rec = r.weeks?.[w];
          if (!rec?.team || rec.locked !== true) { cells.push(""); continue; } // hidden until the game starts
          const ab = ABBR[rec.team] || rec.team.slice(0, 3).toUpperCase();
          const mark = rec.result === "win" ? " ✓"
            : rec.result === "loss" ? (rec.buyback === "confirmed" ? " ✗💸" : " ✗")
            : rec.result === "live-leading" ? " ▲"
            : rec.result === "live-trailing" ? " ▼"
            : rec.result === "live-tied" ? " –"
            : "";
          cells.push(q(ab + mark));
        }
        lines.push(cells.join(","));
      }
      lines.push("");
      lines.push(q("Legend: SAFE this week's pick won · VULNERABLE this week not won yet · IN LIMBO lost, buy-back window open · SEA ✓ won · SEA ✗ lost · SEA ✗💸 lost but bought back · ▲▼ live now · 💀 out. Ties count as wins. Picks appear only after their game kicks off; until then they're hidden league-wide."));
      lines.push(q(`This tab is a view-only mirror. Picks, buy-backs, and payments happen in the app: ${url.host}`));
      return new Response(lines.join("\n"), {
        headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "public, max-age=60" },
      });
    }

    /* League chat: everyone reads, logged-in players (and the commissioner) post. */
    if (path === "/api/chat" && method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit") || 150), 300);
      const prefix = KEYS.chat(S);
      const allKeys = await listKeys(store, prefix);
      const keys = allKeys.slice(-limit);
      const values = await getManyJSON(store, keys);
      const messages = keys.map((k, i) => (values[i] ? { id: k, ...values[i], text: cleanText(values[i].text, cfg.chatBlocklist) } : null)).filter(Boolean);
      // Keys carry the post time, so "how many since I last looked" costs no blob reads.
      const msOf = (k) => Number(k.slice(prefix.length, prefix.length + 14)) || 0;
      const since = Number(url.searchParams.get("since")) || 0;
      const newest = allKeys.length ? msOf(allKeys[allKeys.length - 1]) : 0;
      const newer = since ? allKeys.filter((k) => msOf(k) > since).length : 0;
      return json({ messages, newest, newer, total: allKeys.length });
    }

    if (path === "/api/chat" && method === "POST") {
      const b = await readBody(req);
      const sub = authSubject(b);
      if (!sub) return bad("Log in to talk your talk.", 401);
      const text = cleanText(String(b.text || "").trim().slice(0, 400), cfg.chatBlocklist);
      if (!text) return bad("Say something first.");
      let name = "Commissioner", commish = true;
      if (!isAdminSub(sub)) {
        const roster = await loadDoc(store, KEYS.roster(S), { players: [] });
        const player = roster.players.find((p) => p.id === sub);
        if (!player) return bad("Unknown player.", 401);
        name = player.name;
        commish = false;
      }
      const key = chatKey(S);
      await setJSON(store, key, { ts: now.toISOString(), name, commish, text });

      // Summoned? The host answers inline; the sender waits a few seconds and
      // sees the reply on the same reload. ponytail: inline, not a background
      // function; move it if sends ever feel slow.
      let hostReplied = false;
      const summons = hostConfigured() ? hostShouldReply(text, hostName(cfg)) : null;
      if (summons) {
        const mention = summons === "mention";
        const st = hostStateOf(await getJSON(store, KEYS.host(S)), now);
        const muted = st.muteUntil && now < new Date(st.muteUntil);
        const since = mention ? st.lastReplyAt : st.lastAttemptAt || st.lastReplyAt;
        const tooSoon = since && now - new Date(since) < (mention ? HOST_REPLY_GAP_MS : HOST_CHIME_GAP_MS);
        const inBudget = st.replies < HOST_REPLIES_PER_DAY && (mention || st.attempts < HOST_CHIME_ATTEMPTS_PER_DAY);
        if (st.on && !muted && !tooSoon && inBudget) {
          try {
            const [{ context }, recent] = await Promise.all([hostContext(store, cfg, now), recentChat(store, S, 20)]);
            const line = await askHost({ cfg: { ...cfg, hostName: hostName(cfg) }, context, recent, trigger: { kind: "reply", name, text, summoned: mention } });
            if (line) { await postHostLine(store, cfg, line, { replyTo: key }); hostReplied = true; }
            await setJSON(store, KEYS.host(S), { ...st, day: tzDay(now), replies: st.replies + (line ? 1 : 0), attempts: st.attempts + 1, lastAttemptAt: now.toISOString(), lastReplyAt: line ? now.toISOString() : st.lastReplyAt, lastLine: line || st.lastLine, lastError: null });
          } catch (e) {
            console.error("host reply failed", e);
            await setJSON(store, KEYS.host(S), { ...st, lastError: `${now.toISOString()} ${String(e.message || e).slice(0, 200)}` }).catch(() => {});
          }
        }
      }
      return json({ ok: true, hostReplied });
    }

    /* The host's own initiative: hourly cron or the desk's "say something now".
       Quiet hours, a daily budget, and a real hook are all required unless forced. */
    if (path === "/api/host/tick" && method === "POST") {
      const b = await readBody(req);
      if (!isAdminSub(authSubject(b))) return bad("Commissioner only.", 403);
      if (!hostConfigured()) return bad("The host isn't set up yet: add ANTHROPIC_API_KEY in Netlify.", 503);
      const force = Boolean(b.force);
      const st = hostStateOf(await getJSON(store, KEYS.host(S)), now);
      const lt = tzParts(now);
      const muted = st.muteUntil && now < new Date(st.muteUntil);
      /* The snuffing answers to the kill switch and nothing else. Quiet hours
         would swallow a Monday night knockout, and the 3-a-day budget and the
         3 hour cooldown throttle chatter, not funerals. It also returns early:
         the unprompted pass has its own "torches snuffed this week" hook, so
         letting both run posts twice about the same deaths. */
      if (st.on && !muted) {
        let snuffed = null;
        try { snuffed = await announceSnuffs(store, cfg, now); } catch { snuffed = null; }
        if (snuffed) return json({ ok: true, posted: true, snuffed: snuffed.count, line: snuffed.line });
      }
      if (b.snuffOnly) return json({ ok: true, skipped: st.on && !muted ? "no torches to snuff" : "off or muted" });
      if (!force) {
        if (!st.on || muted) return json({ ok: true, skipped: "off or muted" });
        if (lt.hour < 8 || lt.hour >= 22) return json({ ok: true, skipped: "quiet hours" });
        if (st.lastUnpromptedAt && now - new Date(st.lastUnpromptedAt) < HOST_UNPROMPTED_GAP_MS) return json({ ok: true, skipped: "spoke recently" });
      }
      const [{ context, hooks, gameDay }, recent] = await Promise.all([hostContext(store, cfg, now), recentChat(store, S, 20)]);
      /* He talks on football days: any day with a game, plus the morning after
         one for the aftermath. The rest of the week he has nothing to say, and
         a mid-week hook like "3 torches snuffed this week" stays true for days,
         which is exactly how he used to end up talking every day. Being
         summoned by name still works any day; so does a knockout. */
      const recapMorning = !gameDay.today && gameDay.yesterday && lt.hour < 12;
      if (!force) {
        if (!gameDay.today && !recapMorning) return json({ ok: true, skipped: "no football today" });
        const budget = gameDay.today ? HOST_UNPROMPTED_PER_DAY : 1;
        if (st.unprompted >= budget) return json({ ok: true, skipped: "daily budget spent" });
      }
      if (recapMorning) hooks.unshift("the morning after: yesterday's games are final, so recap the carnage rather than previewing anything");
      if (!force && !hooks.length) return json({ ok: true, skipped: "nothing happening" });
      try {
        const line = await askHost({ cfg: { ...cfg, hostName: hostName(cfg) }, context, recent, trigger: { kind: "unprompted", hooks, forced: force } });
        if (line) await postHostLine(store, cfg, line, { unprompted: true });
        await setJSON(store, KEYS.host(S), { ...st, day: tzDay(now), unprompted: st.unprompted + (line ? 1 : 0), lastUnpromptedAt: line ? now.toISOString() : st.lastUnpromptedAt, lastLine: line || st.lastLine, lastError: null });
        return json({ ok: true, posted: Boolean(line), line: line || null, hooks });
      } catch (e) {
        await setJSON(store, KEYS.host(S), { ...st, lastError: `${now.toISOString()} ${String(e.message || e).slice(0, 200)}` }).catch(() => {});
        return bad(`The host choked: ${e.message}`, 502);
      }
    }

    /* ----- player auth + join ----- */

    if (path === "/api/join" && method === "POST") {
      const b = await readBody(req);
      const closed = await joinClosedReason(store, cfg, now);
      if (closed) return bad(closed, 403);
      const name = String(b.name || "").trim().replace(/\s+/g, " ");
      if (name.length < 2) return bad("Name required.");
      if (name.length > 40) return bad("Name must be 40 characters or fewer.");
      if (RESERVED_NAMES.test(name)) return bad("That name is reserved.");
      if (/^[=+\-@]/.test(name)) return bad("Names can't start with a symbol.");
      if (!isClean(name, cfg.chatBlocklist)) return bad("Pick a cleaner name.");
      const email = String(b.email || "").trim().toLowerCase();
      if (!email) return bad("Email required. It's how reminders reach you.");
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return bad("That email doesn't look right. Check it and try again.");
      const phone = String(b.phone || "").trim();
      if (phone && !PHONE_RE.test(phone)) return bad("That phone number doesn't look right.");
      const numSlots = Math.min(Math.max(Number(b.slots) || 1, 1), cfg.maxSlotsPerPlayer ?? 3);

      const chosenPin = String(b.pin || "").trim();
      if (chosenPin && !/^\d{4,8}$/.test(chosenPin)) return bad("PIN must be 4 to 8 digits.");
      const player = { id: newId("p"), name, email, phone, pin: chosenPin || newPin(), createdAt: now.toISOString() };
      let dup = false;
      await mutateDoc(store, KEYS.roster(S), { players: [] }, (r) => {
        if (r.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) { dup = true; return undefined; }
        r.players.push(player);
        return r;
      });
      if (dup) return bad("That name is already registered. Log in instead, or use a distinct name.", 409);
      const mySlots = [];
      for (let i = 1; i <= numSlots; i++) {
        const label = numSlots === 1 ? name : `${name} (${i})`;
        mySlots.push({ id: newId("s"), playerId: player.id, label, createdAt: now.toISOString(), withdrawn: false });
      }
      await mutateDoc(store, KEYS.slots(S), { slots: [] }, (d) => { d.slots.push(...mySlots); return d; });
      await appendLog(store, S, { action: "join", actor: name, actorId: player.id, note: `${name} joined with ${numSlots} slot${numSlots > 1 ? "s" : ""}` });
      await rebuild(store, cfg, now, { force: true });
      const token = makeToken(player.id, secret);
      return json({
        playerId: player.id, name: player.name, pin: player.pin, token,
        slots: mySlots.map((s) => ({ id: s.id, label: s.label })),
      });
    }

    if (path === "/api/auth" && method === "POST") {
      const b = await readBody(req);
      const who = String(b.playerId || "?").slice(0, 64);
      if (await authLocked(store, S, who, clientIp, now)) return bad("Too many wrong PINs. Try again in 15 minutes, or text the commissioner for a reset.", 429);
      const roster = await loadDoc(store, KEYS.roster(S), { players: [] });
      const player = roster.players.find((p) => p.id === b.playerId);
      if (!player || String(b.pin) !== String(player.pin)) {
        await authMiss(store, S, who, clientIp, now);
        return bad("Wrong PIN. Ask the commissioner for a reset.", 401);
      }
      await authHit(store, S, who);
      return json({ token: makeToken(player.id, secret), playerId: player.id, name: player.name });
    }

    if (path === "/api/setpin" && method === "POST") {
      const b = await readBody(req);
      const sub = authSubject(b);
      if (!sub || isAdminSub(sub)) return bad("Log in first.", 401);
      const pin = String(b.pin || "").trim();
      if (!/^\d{4,8}$/.test(pin)) return bad("PIN must be 4 to 8 digits.");
      let pinErr = null, synced = 0, actorNm = "player";
      await mutateDoc(store, KEYS.roster(S), { players: [] }, (r) => {
        const player = r.players.find((p) => p.id === sub);
        if (!player) { pinErr = { msg: "Unknown player.", code: 401 }; return undefined; }
        if (player.managedBy) {
          const mgr = r.players.find((p) => p.id === player.managedBy);
          pinErr = { msg: `Your household shares one PIN. Ask ${mgr?.name || "your household manager"} to change it.`, code: 403 };
          return undefined;
        }
        player.pin = pin;
        synced = 0;
        for (const p of r.players) if (p.managedBy === player.id) { p.pin = pin; synced++; } // one PIN per family
        actorNm = player.name;
        return r;
      });
      if (pinErr) return bad(pinErr.msg, pinErr.code);
      await appendLog(store, S, { action: "pin-changed", actor: actorNm, actorId: sub, note: `${actorNm} changed their PIN${synced ? ` (synced to ${synced} household member${synced > 1 ? "s" : ""})` : ""}` });
      return json({ ok: true, synced });
    }

    /* Household: a logged-in player adds family members and can pick for them.
       Members are full players (own PIN, own slots, max 3) — just managed. */
    if (path === "/api/household" && method === "POST") {
      const b = await readBody(req);
      const sub = authSubject(b);
      if (!sub || isAdminSub(sub)) return bad("Log in first.", 401);
      const closed = await joinClosedReason(store, cfg, now);
      if (closed) return bad(closed, 403);
      const roster = await loadDoc(store, KEYS.roster(S), { players: [] });
      const manager = roster.players.find((p) => p.id === sub);
      if (!manager) return bad("Unknown player.", 401);
      if (manager.managedBy) return bad("Household members can't add more members. Ask whoever manages your household.", 403);
      if (roster.players.filter((p) => p.managedBy === sub).length >= MAX_HOUSEHOLD) return bad(`A household tops out at ${MAX_HOUSEHOLD} members. Text the commissioner.`, 403);
      const name = String(b.name || "").trim().replace(/\s+/g, " ");
      if (name.length < 2) return bad("Name required.");
      if (name.length > 40) return bad("Name must be 40 characters or fewer.");
      if (RESERVED_NAMES.test(name)) return bad("That name is reserved.");
      if (/^[=+\-@]/.test(name)) return bad("Names can't start with a symbol.");
      if (!isClean(name, cfg.chatBlocklist)) return bad("Pick a cleaner name.");
      if (roster.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
        return bad("That name is already registered.", 409);
      }
      const numSlots = Math.min(Math.max(Number(b.slots) || 1, 1), cfg.maxSlotsPerPlayer ?? 3);
      // Household members share the manager's PIN: one login secret per family.
      const player = { id: newId("p"), name, email: String(b.email || "").trim(), phone: String(b.phone || "").trim(), pin: manager.pin, createdAt: now.toISOString(), managedBy: sub };
      let dupMember = false;
      await mutateDoc(store, KEYS.roster(S), { players: [] }, (r) => {
        if (r.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) { dupMember = true; return undefined; }
        r.players.push(player);
        return r;
      });
      if (dupMember) return bad("That name is already registered.", 409);
      const mySlots = [];
      for (let i = 1; i <= numSlots; i++) {
        const label = numSlots === 1 ? name : `${name} (${i})`;
        mySlots.push({ id: newId("s"), playerId: player.id, label, createdAt: now.toISOString(), withdrawn: false });
      }
      await mutateDoc(store, KEYS.slots(S), { slots: [] }, (d) => { d.slots.push(...mySlots); return d; });
      await appendLog(store, S, { action: "join", actor: manager.name, actorId: manager.id, note: `${name} joined with ${numSlots} slot${numSlots > 1 ? "s" : ""} (household of ${manager.name})` });
      await rebuild(store, cfg, now, { force: true });
      return json({ playerId: player.id, name: player.name, pin: player.pin, slots: mySlots.map((s) => ({ id: s.id, label: s.label })) });
    }

    /* Rename yourself, or a household member you manage. Slot labels that
       follow the standard "Name" / "Name (n)" pattern are relabeled too. */
    if (path === "/api/setname" && method === "POST") {
      const b = await readBody(req);
      const sub = authSubject(b);
      if (!sub || isAdminSub(sub)) return bad("Log in first.", 401);
      const name = String(b.name || "").trim().replace(/\s+/g, " ");
      if (name.length < 2 || name.length > 40) return bad("Name must be 2 to 40 characters.");
      if (RESERVED_NAMES.test(name)) return bad("That name is reserved.");
      if (/^[=+\-@]/.test(name)) return bad("Names can't start with a symbol.");
      let nmErr = null, oldName = null, actorName = null, targetId = null, unchanged = false;
      await mutateDoc(store, KEYS.roster(S), { players: [] }, (r) => {
        const me = r.players.find((p) => p.id === sub);
        if (!me) { nmErr = { msg: "Unknown player.", code: 401 }; return undefined; }
        let target = me;
        if (b.memberId && b.memberId !== sub) {
          target = r.players.find((p) => p.id === b.memberId);
          if (!target || target.managedBy !== sub) { nmErr = { msg: "That member isn't in your household.", code: 403 }; return undefined; }
        }
        if (r.players.some((p) => p.id !== target.id && p.name.toLowerCase() === name.toLowerCase())) {
          nmErr = { msg: "That name is already taken.", code: 409 };
          return undefined;
        }
        if (target.name === name) { unchanged = true; return undefined; }
        oldName = target.name;
        targetId = target.id;
        actorName = me.id === target.id ? name : me.name;
        target.name = name;
        return r;
      });
      if (nmErr) return bad(nmErr.msg, nmErr.code);
      if (unchanged) return json({ ok: true, name });
      await mutateDoc(store, KEYS.slots(S), { slots: [] }, (d) => {
        for (const s2 of d.slots) {
          if (s2.playerId !== targetId) continue;
          if (s2.label === oldName) s2.label = name;
          else if (s2.label.startsWith(oldName + " (")) s2.label = name + s2.label.slice(oldName.length);
        }
        return d;
      });
      await appendLog(store, S, { action: "name-changed", actor: actorName, actorId: sub, note: `${oldName} is now ${name}` });
      await rebuild(store, cfg, now, { force: true });
      return json({ ok: true, name });
    }

    if (path === "/api/setcontact" && method === "POST") {
      // Players own their email and phone: read with just a token, write by
      // sending either field. Managers can do both for household members.
      const b = await readBody(req);
      const sub = authSubject(b);
      if (!sub || isAdminSub(sub)) return bad("Log in first.", 401);
      let email, phone;
      if (b.email !== undefined) {
        email = String(b.email).trim();
        if (email && (email.length > 80 || !/^\S+@\S+\.\S+$/.test(email))) return bad("That email doesn't look right.");
      }
      if (b.phone !== undefined) {
        phone = String(b.phone).trim();
        if (phone && !/^[\d\s()+.-]{7,20}$/.test(phone)) return bad("That phone number doesn't look right.");
      }
      const emailReminders = b.emailReminders === undefined ? undefined : Boolean(b.emailReminders);
      const smsReminders = b.smsReminders === undefined ? undefined : Boolean(b.smsReminders);
      let scErr = null, out = null, changed = [], actorName = null, targetName = null;
      await mutateDoc(store, KEYS.roster(S), { players: [] }, (r) => {
        scErr = null; out = null; changed = []; // reset per attempt: CAS may retry this fn
        const me = r.players.find((p) => p.id === sub);
        if (!me) { scErr = { msg: "Unknown player.", code: 401 }; return undefined; }
        let target = me;
        if (b.memberId && b.memberId !== sub) {
          target = r.players.find((p) => p.id === b.memberId);
          if (!target || target.managedBy !== sub) { scErr = { msg: "That member isn't in your household.", code: 403 }; return undefined; }
        }
        if (email !== undefined && email !== (target.email || "")) { target.email = email; changed.push("email"); }
        if (phone !== undefined && phone !== (target.phone || "")) { target.phone = phone; changed.push("phone"); }
        if (emailReminders !== undefined && emailReminders === Boolean(target.emailOff)) { target.emailOff = !emailReminders; changed.push(emailReminders ? "email reminders on" : "email reminders off"); }
        if (smsReminders !== undefined && smsReminders !== Boolean(target.smsOn)) { target.smsOn = smsReminders; changed.push(smsReminders ? "text reminders on" : "text reminders off"); }
        out = { email: target.email || "", phone: target.phone || "", emailReminders: !target.emailOff, smsReminders: Boolean(target.smsOn) };
        actorName = me.name; targetName = target.name;
        return changed.length ? r : undefined; // nothing to save = plain read, skip the write
      });
      if (scErr) return bad(scErr.msg, scErr.code);
      if (changed.length) await appendLog(store, S, { action: "contact-updated", actor: actorName, actorId: sub, note: `${targetName} updated their ${changed.join(" and ")}` });
      return json({ ok: true, ...out });
    }

    if (path === "/api/admin/auth" && method === "POST") {
      const b = await readBody(req);
      if (await authLocked(store, S, "admin", clientIp, now)) return bad("Too many wrong PINs. Try again in 15 minutes.", 429);
      if (String(b.pin) !== String(cfg.adminPin)) {
        await authMiss(store, S, "admin", clientIp, now);
        return bad("Wrong admin PIN.", 401);
      }
      await authHit(store, S, "admin");
      return json({ token: makeToken("admin", secret) });
    }

    /* ----- player writes ----- */

    if (path === "/api/pick" && method === "POST") {
      const b = await readBody(req);
      const sub = authSubject(b);
      if (!sub) return bad("Log in first.", 401);
      const week = Number(b.week);
      const team = String(b.team || "").trim();
      if (!team) return bad("Pick a team.");
      const [slotsDoc, roster, revivals, overrides] = await Promise.all([
        loadDoc(store, KEYS.slots(S), { slots: [] }),
        loadDoc(store, KEYS.roster(S), { players: [] }),
        loadDoc(store, KEYS.revivals(S), { entries: [] }),
        loadDoc(store, KEYS.overrides(S), {}),
      ]);
      const slot = slotsDoc.slots.find((s) => s.id === b.slotId && !s.withdrawn);
      if (!slot) return bad("Unknown slot.", 404);
      const admin = isAdminSub(sub);
      const owner = roster.players.find((p) => p.id === slot.playerId);
      if (!admin && slot.playerId !== sub && owner?.managedBy !== sub) return bad("That slot isn't yours.", 403);
      if (!week || week < 1 || week > (cfg.totalWeeks ?? 18)) return bad("Bad week.");

      const pickBlobs = await listJSON(store, KEYS.pickPrefix(S, slot.id));
      const picks = {};
      for (const { key, value } of pickBlobs) picks[Number(key.split(":")[3])] = value;
      const schedules = await getSchedules(store, cfg, new Set([...Object.keys(picks).map(Number), week]), now, overrides);
      const evaluation = evaluateSlot({ slot, picks, revivals: revivals.entries, schedules, overrides, cfg, now });
      const check = validatePick({ evaluation, week, team, weekSchedule: schedules[week], now, isAdmin: admin });
      if (!check.ok) return bad(check.error, 422);

      const before = picks[week]?.team || null;
      const actorName = admin ? "commissioner" : roster.players.find((p) => p.id === sub)?.name || "player";
      await setJSON(store, KEYS.pick(S, slot.id, week), {
        team, ts: now.toISOString(), actor: actorName, source: admin ? "admin" : "player",
      });
      await appendLog(store, S, {
        action: before ? "pick-change" : "pick", actor: actorName, actorId: admin ? "admin" : sub, slotId: slot.id, slotLabel: slot.label,
        week, before, after: team,
      });
      picks[week] = { team, ts: now.toISOString(), actor: actorName, source: admin ? "admin" : "player" };
      await refreshSlotSnapshot(store, cfg, slot.id, now, { roster, slotsDoc, revivals, overrides, picks, schedules });
      return json({ ok: true });
    }

    /* Remove an unstarted pick. The week goes back to empty; the default pick still
       applies if it stays that way. Locked picks are commissioner-only. */
    if (path === "/api/unpick" && method === "POST") {
      const b = await readBody(req);
      const sub = authSubject(b);
      if (!sub) return bad("Log in first.", 401);
      const week = Number(b.week);
      if (!week || week < 1 || week > (cfg.totalWeeks ?? 18)) return bad("Bad week.");
      const slotsDoc = await loadDoc(store, KEYS.slots(S), { slots: [] });
      const slot = slotsDoc.slots.find((s) => s.id === b.slotId && !s.withdrawn);
      if (!slot) return bad("Unknown slot.", 404);
      const admin = isAdminSub(sub);
      const roster = await loadDoc(store, KEYS.roster(S), { players: [] });
      const owner = roster.players.find((p) => p.id === slot.playerId);
      if (!admin && slot.playerId !== sub && owner?.managedBy !== sub) return bad("That slot isn't yours.", 403);
      const pickKey = KEYS.pick(S, slot.id, week);
      const existing = await getJSON(store, pickKey);
      if (!existing) return bad("No pick on file for that week.", 404);
      if (!admin) {
        const sched = await getSchedule(store, cfg, week, now);
        const game = gameForTeam(sched.games || [], existing.team);
        if (game && gameStarted(game, now)) return bad("That pick already locked at kickoff. Only the commissioner can change it now.", 422);
      }
      await store.delete(pickKey);
      const actorName = admin ? "commissioner" : roster.players.find((p) => p.id === sub)?.name || "player";
      await appendLog(store, S, {
        action: "pick-removed", actor: actorName, actorId: admin ? "admin" : sub, slotId: slot.id, slotLabel: slot.label,
        week, before: existing.team,
      });
      await refreshSlotSnapshot(store, cfg, slot.id, now, { roster, slotsDoc });
      return json({ ok: true });
    }

    if (path === "/api/buyback" && method === "POST") {
      const b = await readBody(req);
      const sub = authSubject(b);
      if (!sub) return bad("Log in first.", 401);
      const slotsDoc = await loadDoc(store, KEYS.slots(S), { slots: [] });
      const slot = slotsDoc.slots.find((s) => s.id === b.slotId && !s.withdrawn);
      if (!slot) return bad("Unknown slot.", 404);
      const rosterBB = await loadDoc(store, KEYS.roster(S), { players: [] });
      const ownerBB = rosterBB.players.find((p) => p.id === slot.playerId);
      if (!isAdminSub(sub) && slot.playerId !== sub && ownerBB?.managedBy !== sub) return bad("That slot isn't yours.", 403);
      const lossWeek = Number(b.lossWeek);

      const revivals = await loadDoc(store, KEYS.revivals(S), { entries: [] });
      if (revivals.entries.some((r) => r.slotId === slot.id && r.lossWeek === lossWeek && r.status !== "denied")) {
        return bad("A buy-back for that loss is already on file.", 409);
      }
      const overrides = await loadDoc(store, KEYS.overrides(S), {});
      const pickBlobs = await listJSON(store, KEYS.pickPrefix(S, slot.id));
      const picks = {};
      for (const { key, value } of pickBlobs) picks[Number(key.split(":")[3])] = value;
      const schedules = await getSchedules(store, cfg, new Set(Object.keys(picks).map(Number)), now);
      const evaluation = evaluateSlot({ slot, picks, revivals: revivals.entries, schedules, overrides, cfg, now });
      const check = validateBuyback({ evaluation, lossWeek, cfg, now });
      if (!check.ok) return bad(check.error, 422);
      await clearStalePick(store, S, slot, evaluation, picks);

      let dupRevival = false;
      await mutateDoc(store, KEYS.revivals(S), { entries: [] }, (d) => {
        if (d.entries.some((r) => r.slotId === slot.id && r.lossWeek === lossWeek && r.status !== "denied")) { dupRevival = true; return undefined; }
        d.entries.push({ id: newId("r"), slotId: slot.id, lossWeek, status: "pending", requestedTs: now.toISOString() });
        return d;
      });
      if (dupRevival) return bad("A buy-back for that loss is already on file.", 409);
      await appendLog(store, S, {
        action: "buyback-request", actorId: sub, slotId: slot.id, slotLabel: slot.label, week: lossWeek,
        note: `Buy-back requested for the week ${lossWeek} loss ($${cfg.buybackFee}). Waiting on payment confirmation.`,
      });
      await refreshSlotSnapshot(store, cfg, slot.id, now);
      return json({ ok: true });
    }

    /* ----- admin ----- */

    if (path === "/api/admin/full" && method === "GET") {
      const sub = authSubject(null);
      if (!isAdminSub(sub)) return bad("Admin only.", 403);
      const [roster, slotsDoc, payments, revivals, overrides, snap] = await Promise.all([
        loadDoc(store, KEYS.roster(S), { players: [] }),
        loadDoc(store, KEYS.slots(S), { slots: [] }),
        loadDoc(store, KEYS.payments(S), { entries: [] }),
        loadDoc(store, KEYS.revivals(S), { entries: [] }),
        loadDoc(store, KEYS.overrides(S), {}),
        getJSON(store, KEYS.snapshot(S)),
      ]);
      const { secret: _s, adminPin: _a, ...cfgSafe } = cfg;
      const hs = hostStateOf(await getJSON(store, KEYS.host(S)), now);
      const mail = mailConfig(); // never the key itself
      return json({ cfg: cfgSafe, roster, slots: slotsDoc, payments, revivals, overrides, snapshot: snap, adminPinWeak: String(cfg.adminPin ?? "").length < 8,
        hostPersonas: HOST_PERSONA_PRESETS,
        host: { configured: hostConfigured(), name: hostName(cfg), on: hs.on, muteUntil: hs.muteUntil, repliesToday: hs.replies, attemptsToday: hs.attempts, unpromptedToday: hs.unprompted, lastUnpromptedAt: hs.lastUnpromptedAt, lastLine: hs.lastLine, lastError: hs.lastError },
        mail: { ready: mail.ready, missing: mail.missing, from: mail.from, summaryTo: mail.summaryTo } });
    }

    if (path === "/api/admin/export" && method === "GET") {
      const sub = authSubject(null);
      if (!isAdminSub(sub)) return bad("Admin only.", 403);
      let snap = await getJSON(store, KEYS.snapshot(S));
      if (!snap) snap = await rebuild(store, cfg, now);
      const total = cfg.totalWeeks ?? 18;
      const head = ["Slot", "Player", "Status", "Eliminated", "Buybacks", ...Array.from({ length: total }, (_, i) => `W${i + 1}`)];
      const lines = [head.join(",")];
      for (const r of snap.slots) {
        const cells = [r.label, r.playerName, r.status, r.eliminatedWeek ?? "", r.buybacksUsed];
        for (let w = 1; w <= total; w++) {
          const rec = r.weeks[w];
          cells.push(rec?.team ? `${rec.team} (${rec.result})` : "");
        }
        lines.push(cells.map((c) => `"${csvSafe(String(c)).replaceAll('"', '""')}"`).join(","));
      }
      return new Response(lines.join("\n"), {
        headers: { "content-type": "text/csv", "content-disposition": `attachment; filename=survivor-${S}.csv` },
      });
    }

    if (path === "/api/admin/op" && method === "POST") {
      const b = await readBody(req);
      const sub = authSubject(b);
      if (!isAdminSub(sub)) return bad("Admin only.", 403);
      const op = b.op;
      const log = (entry) => appendLog(store, S, { actor: "commissioner", ...entry });
      let mode = "full"; // full | slot | pot | none: how much of the snapshot this op invalidates
      let touched = null;

      if (op === "confirmRevival" || op === "denyRevival") {
        let target = null, already = null;
        await mutateDoc(store, KEYS.revivals(S), { entries: [] }, (d) => {
          const r = d.entries.find((x) => x.id === b.revivalId);
          if (!r) return undefined;
          if (r.status !== "pending") { already = r.status; return undefined; } // a retry must not pay twice
          r.status = op === "confirmRevival" ? "confirmed" : "denied";
          r.resolvedTs = now.toISOString();
          target = { slotId: r.slotId, lossWeek: r.lossWeek };
          return d;
        });
        if (already) return bad(`That buy-back was already ${already}.`, 409);
        if (!target) return bad("Unknown revival.", 404);
        mode = "slot"; touched = target.slotId;
        if (op === "confirmRevival") {
          await mutateDoc(store, KEYS.payments(S), { entries: [] }, (d) => {
            d.entries.push({
              id: newId("pay"), slotId: target.slotId, type: "buyback", week: target.lossWeek,
              amount: cfg.buybackFee, method: b.method || "venmo", ts: now.toISOString(),
            });
            return d;
          });
        }
        const slotsDoc = await loadDoc(store, KEYS.slots(S), { slots: [] });
        const slot = slotsDoc.slots.find((s) => s.id === target.slotId);
        await log({
          action: op === "confirmRevival" ? "buyback-confirmed" : "buyback-denied",
          slotId: target.slotId, slotLabel: slot?.label, week: target.lossWeek,
          note: op === "confirmRevival" ? `$${cfg.buybackFee} received; back in the pool` : "Buy-back denied",
        });
      } else if (op === "grantRevival") {
        // Nobody tapped the button. The commissioner marks the buy-back on the
        // slot's behalf: a request and a confirm in one move, and the closed
        // window doesn't stop it. Everything downstream treats it as normal.
        const lossWeek = Number(b.lossWeek);
        const slotsDoc = await loadDoc(store, KEYS.slots(S), { slots: [] });
        const slot = slotsDoc.slots.find((s) => s.id === b.slotId && !s.withdrawn);
        if (!slot) return bad("Unknown slot.", 404);
        const [revivalsG, overridesG] = await Promise.all([
          loadDoc(store, KEYS.revivals(S), { entries: [] }),
          loadDoc(store, KEYS.overrides(S), {}),
        ]);
        if (revivalsG.entries.some((r) => r.slotId === slot.id && r.lossWeek === lossWeek && r.status !== "denied")) {
          return bad("A buy-back for that loss is already on file.", 409);
        }
        const picksG = {};
        for (const { key, value } of await listJSON(store, KEYS.pickPrefix(S, slot.id))) picksG[Number(key.split(":")[3])] = value;
        const schedulesG = await getSchedules(store, cfg, new Set(Object.keys(picksG).map(Number)), now, overridesG);
        const evalG = evaluateSlot({ slot, picks: picksG, revivals: revivalsG.entries, schedules: schedulesG, overrides: overridesG, cfg, now });
        const checkG = validateBuyback({ evaluation: evalG, lossWeek, cfg, now, ignoreWindow: true });
        if (!checkG.ok) return bad(checkG.error, 422);
        await clearStalePick(store, S, slot, evalG, picksG);
        const revivalId = newId("r");
        let dupG = false;
        await mutateDoc(store, KEYS.revivals(S), { entries: [] }, (d) => {
          if (d.entries.some((r) => r.slotId === slot.id && r.lossWeek === lossWeek && r.status !== "denied")) { dupG = true; return undefined; }
          d.entries.push({
            id: revivalId, slotId: slot.id, lossWeek, status: "confirmed",
            requestedTs: now.toISOString(), resolvedTs: now.toISOString(), grantedBy: "commissioner",
          });
          return d;
        });
        if (dupG) return bad("A buy-back for that loss is already on file.", 409);
        await mutateDoc(store, KEYS.payments(S), { entries: [] }, (d) => {
          d.entries.push({
            id: newId("pay"), slotId: slot.id, type: "buyback", week: lossWeek, revivalId,
            amount: cfg.buybackFee, method: b.method || "venmo",
            note: String(b.note || "").slice(0, 200), ts: now.toISOString(),
          });
          return d;
        });
        await log({
          action: "buyback-granted", slotId: slot.id, slotLabel: slot.label, week: lossWeek,
          note: `Commissioner marked the week ${lossWeek} buy-back ($${cfg.buybackFee} received)`,
        });
      } else if (op === "undoRevival") {
        // Marked the wrong slot, or the money never landed. The buy-back comes
        // off and its payment goes with it.
        let targetU = null;
        await mutateDoc(store, KEYS.revivals(S), { entries: [] }, (d) => {
          const r = d.entries.find((x) => x.id === b.revivalId);
          if (!r || r.status === "denied") return undefined;
          r.status = "denied";
          r.resolvedTs = now.toISOString();
          targetU = { slotId: r.slotId, lossWeek: r.lossWeek };
          return d;
        });
        if (!targetU) return bad("Unknown buy-back.", 404);
        await mutateDoc(store, KEYS.payments(S), { entries: [] }, (d) => {
          for (const p of d.entries) {
            if (p.type === "buyback" && !p.voided && p.slotId === targetU.slotId
              && (p.revivalId ? p.revivalId === b.revivalId : p.week === targetU.lossWeek)) p.voided = true;
          }
          return d;
        });
        const slotsDocU = await loadDoc(store, KEYS.slots(S), { slots: [] });
        const slotU = slotsDocU.slots.find((s) => s.id === targetU.slotId);
        await log({
          action: "buyback-undone", slotId: targetU.slotId, slotLabel: slotU?.label, week: targetU.lossWeek,
          note: `Week ${targetU.lossWeek} buy-back removed and its $${cfg.buybackFee} voided`,
        });
      } else if (op === "addPayment") {
        mode = "pot";
        const type = b.type || "buyin";
        const amount = Number(b.amount ?? cfg.buyIn);
        if (!["buyin", "buyback"].includes(type)) return bad("Payment type must be buyin or buyback.");
        if (!Number.isFinite(amount) || amount <= 0 || amount > 10000) return bad("Payment amount must be a positive number.");
        const slotsDoc = await loadDoc(store, KEYS.slots(S), { slots: [] });
        const slot = slotsDoc.slots.find((s) => s.id === b.slotId);
        if (!slot) return bad("Unknown slot.", 404);
        let dup = false;
        await mutateDoc(store, KEYS.payments(S), { entries: [] }, (d) => {
          if (type === "buyin" && d.entries.some((p) => p.slotId === b.slotId && p.type === "buyin" && !p.voided)) { dup = true; return undefined; }
          d.entries.push({
            id: newId("pay"), slotId: b.slotId, type, week: b.week ?? null,
            amount, method: b.method || "venmo", note: String(b.note || "").slice(0, 200), ts: now.toISOString(),
          });
          return d;
        });
        if (dup) return bad("Buy-in already recorded for that slot.", 409);
        await log({ action: "payment", slotId: b.slotId, slotLabel: slot?.label, note: `$${b.amount ?? cfg.buyIn} ${b.type || "buyin"} recorded (${b.method || "venmo"})` });
      } else if (op === "voidPayment") {
        mode = "pot";
        let voided = null;
        await mutateDoc(store, KEYS.payments(S), { entries: [] }, (d) => {
          const p = d.entries.find((x) => x.id === b.paymentId);
          if (!p) return undefined;
          p.voided = true;
          voided = { slotId: p.slotId, amount: p.amount, type: p.type };
          return d;
        });
        if (!voided) return bad("Unknown payment.", 404);
        await log({ action: "payment-voided", slotId: voided.slotId, note: `Voided $${voided.amount} ${voided.type}` });
      } else if (op === "addPlayer") {
        const name = String(b.name || "").trim();
        if (!name) return bad("Name required.");
        const player = { id: newId("p"), name, email: b.email || "", phone: b.phone || "", pin: newPin(), createdAt: now.toISOString() };
        await mutateDoc(store, KEYS.roster(S), { players: [] }, (r) => { r.players.push(player); return r; });
        const n = Math.min(Math.max(Number(b.slots) || 1, 1), cfg.maxSlotsPerPlayer ?? 3);
        const newSlots = [];
        for (let i = 1; i <= n; i++) {
          newSlots.push({ id: newId("s"), playerId: player.id, label: n === 1 ? name : `${name} (${i})`, createdAt: now.toISOString(), withdrawn: false });
        }
        await mutateDoc(store, KEYS.slots(S), { slots: [] }, (d) => { d.slots.push(...newSlots); return d; });
        await log({ action: "join", note: `${name} added by commissioner (${n} slot${n > 1 ? "s" : ""})` });
      } else if (op === "addSlot") {
        const roster = await loadDoc(store, KEYS.roster(S), { players: [] });
        const player = roster.players.find((p) => p.id === b.playerId);
        if (!player) return bad("Unknown player.", 404);
        let slotErr = null;
        await mutateDoc(store, KEYS.slots(S), { slots: [] }, (d) => {
          const count = d.slots.filter((s) => s.playerId === player.id && !s.withdrawn).length;
          if (count >= (cfg.maxSlotsPerPlayer ?? 3)) { slotErr = "Max slots reached."; return undefined; }
          let n = count + 1; // removals can leave gaps, so skip past any label already in use
          while (d.slots.some((s) => s.playerId === player.id && s.label === `${player.name} (${n})`)) n++;
          d.slots.push({ id: newId("s"), playerId: player.id, label: `${player.name} (${n})`, createdAt: now.toISOString(), withdrawn: false });
          return d;
        });
        if (slotErr) return bad(slotErr);
        await log({ action: "slot-added", note: `Extra slot for ${player.name}` });
      } else if (op === "renameSlot" || op === "withdrawSlot" || op === "restoreSlot") {
        let touched = null;
        await mutateDoc(store, KEYS.slots(S), { slots: [] }, (d) => {
          const slot = d.slots.find((s) => s.id === b.slotId);
          if (!slot) return undefined;
          if (op === "renameSlot") slot.label = String(b.label || slot.label).trim();
          if (op === "withdrawSlot") slot.withdrawn = true;
          if (op === "restoreSlot") slot.withdrawn = false;
          touched = { id: slot.id, label: slot.label };
          return d;
        });
        if (!touched) return bad("Unknown slot.", 404);
        await log({ action: op, slotId: touched.id, slotLabel: touched.label });
      } else if (op === "removeSlot") {
        const slotsPeek = await loadDoc(store, KEYS.slots(S), { slots: [] });
        const slot = slotsPeek.slots.find((s) => s.id === b.slotId);
        if (!slot) return bad("Unknown slot.", 404);
        if (slotsPeek.slots.filter((s) => s.playerId === slot.playerId).length < 2) {
          return bad("That's their only slot. Use Remove player instead.");
        }
        const keys = await listKeys(store, KEYS.pickPrefix(S, slot.id));
        await Promise.all(keys.map((k) => store.delete(k)));
        let removed = null;
        await mutateDoc(store, KEYS.slots(S), { slots: [] }, (d) => {
          const cur = d.slots.find((s) => s.id === slot.id);
          if (!cur) return undefined;
          d.slots = d.slots.filter((s) => s.id !== slot.id);
          removed = { id: cur.id, label: cur.label };
          return d;
        });
        if (!removed) return bad("Unknown slot.", 404);
        await mutateDoc(store, KEYS.revivals(S), { entries: [] }, (d) => {
          d.entries = d.entries.filter((r) => r.slotId !== slot.id);
          return d;
        });
        await mutateDoc(store, KEYS.payments(S), { entries: [] }, (d) => {
          d.entries = d.entries.filter((p) => p.slotId !== slot.id);
          return d;
        });
        await log({ action: "slot-removed", slotId: removed.id, slotLabel: removed.label, note: `${removed.label} removed by commissioner` });
      } else if (op === "resetPin") {
        const custom = String(b.pin || "").trim();
        if (custom && !/^\d{4,8}$/.test(custom)) return bad("PIN must be 4 to 8 digits.");
        const newPinVal = custom || newPin();
        let resetName = null;
        await mutateDoc(store, KEYS.roster(S), { players: [] }, (r) => {
          const player = r.players.find((p) => p.id === b.playerId);
          if (!player) return undefined;
          player.pin = newPinVal;
          for (const p of r.players) if (p.managedBy === player.id) p.pin = newPinVal; // keep the household on one PIN
          resetName = player.name;
          return r;
        });
        if (!resetName) return bad("Unknown player.", 404);
        await log({ action: "pin-reset", note: `PIN reset for ${resetName}` });
        return json({ ok: true, pin: newPinVal });
      } else if (op === "setContact") {
        mode = "none";
        const newName = b.name !== undefined ? String(b.name).trim().replace(/\s+/g, " ") : "";
        let scErr = null, renamed = null, finalName = null;
        await mutateDoc(store, KEYS.roster(S), { players: [] }, (r) => {
          const player = r.players.find((p) => p.id === b.playerId);
          if (!player) { scErr = { msg: "Unknown player.", code: 404 }; return undefined; }
          if (b.email !== undefined) player.email = b.email;
          if (b.phone !== undefined) player.phone = b.phone;
          if (b.emailReminders !== undefined) player.emailOff = !b.emailReminders;
          if (b.smsReminders !== undefined) player.smsOn = Boolean(b.smsReminders);
          if (newName && newName !== player.name) {
            if (r.players.some((p) => p.id !== player.id && p.name.toLowerCase() === newName.toLowerCase())) {
              scErr = { msg: "That name is already taken.", code: 409 };
              return undefined;
            }
            renamed = { oldName: player.name, playerId: player.id };
            player.name = newName;
          }
          finalName = player.name;
          return r;
        });
        if (scErr) return bad(scErr.msg, scErr.code);
        if (renamed) {
          await mutateDoc(store, KEYS.slots(S), { slots: [] }, (d) => {
            for (const s2 of d.slots) {
              if (s2.playerId !== renamed.playerId) continue;
              if (s2.label === renamed.oldName) s2.label = newName;
              else if (s2.label.startsWith(renamed.oldName + " (")) s2.label = newName + s2.label.slice(renamed.oldName.length);
            }
            return d;
          });
          await log({ action: "name-changed", note: `${renamed.oldName} is now ${newName}` });
        }
        await log({ action: "contact-updated", note: `Contact updated for ${finalName}` });
      } else if (op === "removePlayer") {
        const rosterPeek = await loadDoc(store, KEYS.roster(S), { players: [] });
        const player = rosterPeek.players.find((p) => p.id === b.playerId);
        if (!player) return bad("Unknown player.", 404);
        const slotsPeek = await loadDoc(store, KEYS.slots(S), { slots: [] });
        const slotIds = new Set(slotsPeek.slots.filter((s) => s.playerId === player.id).map((s) => s.id));
        for (const sid of slotIds) {
          const keys = await listKeys(store, KEYS.pickPrefix(S, sid));
          await Promise.all(keys.map((k) => store.delete(k)));
        }
        await mutateDoc(store, KEYS.slots(S), { slots: [] }, (d) => {
          d.slots = d.slots.filter((s) => s.playerId !== player.id);
          return d;
        });
        await mutateDoc(store, KEYS.roster(S), { players: [] }, (r) => {
          r.players = r.players.filter((p) => p.id !== player.id);
          for (const p of r.players) if (p.managedBy === player.id) delete p.managedBy; // orphaned members become standalone
          return r;
        });
        await mutateDoc(store, KEYS.revivals(S), { entries: [] }, (d) => {
          d.entries = d.entries.filter((r) => !slotIds.has(r.slotId));
          return d;
        });
        await mutateDoc(store, KEYS.payments(S), { entries: [] }, (d) => {
          d.entries = d.entries.filter((p) => !slotIds.has(p.slotId));
          return d;
        });
        await log({ action: "player-removed", note: `${player.name} removed from the league` });
      } else if (op === "clearPick") {
        const slotsDoc = await loadDoc(store, KEYS.slots(S), { slots: [] });
        const slot = slotsDoc.slots.find((s) => s.id === b.slotId);
        if (!slot) return bad("Unknown slot.", 404);
        await store.delete(KEYS.pick(S, slot.id, Number(b.week)));
        mode = "slot"; touched = slot.id;
        await log({ action: "pick-cleared", slotId: slot.id, slotLabel: slot.label, week: Number(b.week), note: "Cleared by commissioner" });
      } else if (op === "setOverride") {
        await mutateDoc(store, KEYS.overrides(S), {}, (o) => {
          if (b.value) o[b.gameId] = b.value; // team name | "TIE" | "VOID"
          else delete o[b.gameId];
          return o;
        });
        await log({ action: "result-override", note: `Game ${b.gameId} set to ${b.value || "(cleared)"}` });
      } else if (op === "hostSet") {
        mode = "none";
        const st = hostStateOf(await getJSON(store, KEYS.host(S)), now);
        if (b.on !== undefined) st.on = Boolean(b.on);
        if (b.muteHours !== undefined) st.muteUntil = Number(b.muteHours) > 0 ? new Date(now.getTime() + Number(b.muteHours) * 3600e3).toISOString() : null;
        await setJSON(store, KEYS.host(S), st);
        await log({ action: "config", note: `Host ${st.on ? "on" : "off"}${st.muteUntil ? `, muted until ${fmtTime(st.muteUntil)}` : ""}` });
      } else if (op === "deleteChat") {
        mode = "none";
        const id = String(b.id || "");
        if (!id.startsWith(`chat:${S}:`)) return bad("Bad chat id.");
        await store.delete(id);
      } else if (op === "setConfig") {
        const allowed = ["leagueName", "established", "buyIn", "buybackFee", "suddenDeathWeek", "maxSlotsPerPlayer", "venmo", "joinOpen", "rulesText", "hallOfFame", "contacts", "adminPin", "leagueNote", "joinNote", "hostName", "hostPersona", "chatBlocklist"];
        if (b.patch?.adminPin !== undefined && String(b.patch.adminPin).length < 8) return bad("Admin PIN must be at least 8 characters. A short phrase works.");
        for (const k of allowed) if (b.patch?.[k] !== undefined) cfg[k] = b.patch[k];
        // The API is the boundary: coerce types so "false" can't leave sign-ups open.
        if (b.patch?.joinOpen !== undefined) cfg.joinOpen = b.patch.joinOpen === true || b.patch.joinOpen === "true";
        for (const k of ["buyIn", "buybackFee", "suddenDeathWeek", "maxSlotsPerPlayer"]) {
          if (b.patch?.[k] === undefined) continue;
          const n = Number(b.patch[k]);
          if (!Number.isFinite(n) || n < 0) return bad(`${k} must be a number.`);
          cfg[k] = n;
        }
        // Contacts render into sms: and mailto: links, so the desk's edits get
        // cleaned here rather than trusted.
        if (b.patch?.contacts !== undefined) {
          if (!Array.isArray(b.patch.contacts)) return bad("Commissioners must be a list.");
          cfg.contacts = b.patch.contacts.slice(0, 6).map((c) => ({
            name: String(c?.name || "").trim().slice(0, 80),
            phone: String(c?.phone || "").trim().slice(0, 40),
            email: String(c?.email || "").trim().slice(0, 120),
          })).filter((c) => c.name && (c.phone || c.email));
        }
        const CAP = { rulesText: 20000, hostPersona: PERSONA_MAX };
        for (const k of ["leagueName", "established", "rulesText", "leagueNote", "joinNote", "venmo", "hostName", "hostPersona", "chatBlocklist"]) if (b.patch?.[k] !== undefined) cfg[k] = String(b.patch[k]).slice(0, CAP[k] ?? 2000);
        mode = ["buyIn", "buybackFee", "suddenDeathWeek", "maxSlotsPerPlayer"].some((k) => b.patch?.[k] !== undefined) ? "full" : "none";
        await setJSON(store, KEYS.cfg, cfg);
        await log({ action: "config", note: `Updated: ${Object.keys(b.patch || {}).join(", ")}` });
      } else if (op === "purgeLog") {
        mode = "none";
        const slotsDoc = await loadDoc(store, KEYS.slots(S), { slots: [] });
        if (slotsDoc.slots.length) return bad("The log can only be purged while the roster is empty (pre-season reset). Once the season has members, history is permanent.", 409);
        const { blobs } = await store.list({ prefix: KEYS.log(S) });
        for (const bl of blobs) await store.delete(bl.key);
      } else if (op === "rebuild") {
        // fall through to the shared rebuild below
      } else {
        return bad(`Unknown op: ${op}`);
      }

      // Refresh only what the op could have changed. A payment touches the pot;
      // a buy-back decision touches one slot; settings and PINs touch nothing.
      if (mode === "none") return json({ ok: true });
      if (mode === "slot" && touched) { await refreshSlotSnapshot(store, cfg, touched, now); return json({ ok: true }); }
      if (mode === "pot") {
        const [slotsDoc2, payments2] = await Promise.all([loadDoc(store, KEYS.slots(S), { slots: [] }), loadDoc(store, KEYS.payments(S), { entries: [] })]);
        let updated = false;
        await mutateDoc(store, KEYS.snapshot(S), null, (snap) => {
          if (!snap?.slots) return undefined;
          snap.pot = computePot(payments2, slotsDoc2.slots, cfg);
          updated = true;
          return snap;
        }, 2).catch(() => {});
        if (!updated) await rebuild(store, cfg, now, { force: true });
        return json({ ok: true });
      }
      await rebuild(store, cfg, now, { force: true });
      return json({ ok: true });
    }

    return bad("Not found.", 404);
  } catch (e) {
    console.error(e);
    return bad(`Server error: ${e.message}`, 500);
  }
};
