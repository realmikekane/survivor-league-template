/* NFL Survivor League SPA. Vanilla JS, hash routing, polls the API on game days. */
"use strict";

/* ---------- team identity ---------- */
const TEAM_ABBR = {
  "Arizona Cardinals": "ari", "Atlanta Falcons": "atl", "Baltimore Ravens": "bal", "Buffalo Bills": "buf",
  "Carolina Panthers": "car", "Chicago Bears": "chi", "Cincinnati Bengals": "cin", "Cleveland Browns": "cle",
  "Dallas Cowboys": "dal", "Denver Broncos": "den", "Detroit Lions": "det", "Green Bay Packers": "gb",
  "Houston Texans": "hou", "Indianapolis Colts": "ind", "Jacksonville Jaguars": "jax", "Kansas City Chiefs": "kc",
  "Las Vegas Raiders": "lv", "Los Angeles Chargers": "lac", "Los Angeles Rams": "lar", "Miami Dolphins": "mia",
  "Minnesota Vikings": "min", "New England Patriots": "ne", "New Orleans Saints": "no", "New York Giants": "nyg",
  "New York Jets": "nyj", "Philadelphia Eagles": "phi", "Pittsburgh Steelers": "pit", "San Francisco 49ers": "sf",
  "Seattle Seahawks": "sea", "Tampa Bay Buccaneers": "tb", "Tennessee Titans": "ten", "Washington Commanders": "wsh",
};
const abbrOf = (name) => (TEAM_ABBR[name] || name.slice(0, 3).toLowerCase());
const logoOf = (name) => `https://a.espncdn.com/i/teamlogos/nfl/500/${abbrOf(name)}.png`;

/* ---------- utilities ---------- */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.hidden = true), ms);
}

async function api(path, body) {
  const opts = body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {};
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    // A player token the server no longer recognizes (removed, reset): drop the stale session.
    if (res.status === 401 && body?.token && session?.token && body.token === session.token && !path.startsWith("/api/auth")) {
      session.logout?.(); renderSession?.();
      toast("Your login is no longer valid. Log in again.");
      location.hash = "#/login";
    }
    throw err;
  }
  return data;
}

const fmtMoney = (n) => "$" + Number(n || 0).toLocaleString();
const fmtKick = (iso) => iso ? new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
/* The league's clock (LEAGUE_TIMEZONE on the server), labeled: "Sun, Sep 14, 1:00 PM ET". */
const leagueTZ = () => DB.state?.cfg?.timeZone || "America/New_York";
const tzAbbr = () => DB.state?.cfg?.tzLabel || "ET";
const fmtKickTZ = (iso) => iso ? new Date(iso).toLocaleString("en-US", { timeZone: leagueTZ(), weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " " + tzAbbr() : "";
const fmtDeadline = (iso) => iso ? new Date(iso).toLocaleString([], { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
function timeAgo(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}
/* Exact wall-clock stamp in league time, to the second: "Sep 8, 4:12:37 PM ET". */
function fmtStamp(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", { timeZone: leagueTZ(), month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }) + " " + tzAbbr();
}
/* Info banners: first-visit guidance, dismissible per page and remembered on this device. */
const hint = (t, key = "") => {
  if (key) { try { if (localStorage.getItem("sl_hint_" + key)) return ""; } catch {} }
  return `<div class="banner info">${t}${key ? `<button class="bx" data-hintdismiss="${key}" aria-label="Hide this tip" title="Got it, hide this tip">✕</button>` : ""}</div>`;
};
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-hintdismiss]");
  if (!b) return;
  try { localStorage.setItem("sl_hint_" + b.dataset.hintdismiss, "1"); } catch {}
  b.closest(".banner")?.remove();
});

/* Betting line for one team, parsed from ESPN's details string ("KC -3.5"). */
function teamSpread(g, teamAbbr) {
  const d = g.odds?.details;
  if (!d) return null;
  if (/EVEN|PK/i.test(d)) return { text: "PK", fav: false };
  const m = d.match(/^([A-Z]{2,4})\s*(-?\d+(\.\d+)?)/);
  if (!m) return null;
  const n = Math.abs(parseFloat(m[2]));
  const isFav = String(teamAbbr).toUpperCase() === m[1];
  return { text: isFav ? `-${n}` : `+${n}`, fav: isFav };
}

/* ---------- session ---------- */
const session = {
  get token() { return localStorage.getItem("sl_token") || ""; },
  get name() { return localStorage.getItem("sl_name") || ""; },
  get playerId() { return localStorage.getItem("sl_playerId") || ""; },
  login(t, id, name) { localStorage.setItem("sl_token", t); localStorage.setItem("sl_playerId", id); localStorage.setItem("sl_name", name); localStorage.setItem("sl_lastName", name); DB.state = null; },
  logout() { ["sl_token", "sl_playerId", "sl_name"].forEach((k) => localStorage.removeItem(k)); DB.state = null; }, // sl_lastName survives so the login form prefills
  get adminToken() { return localStorage.getItem("sl_admin") || ""; },
  set adminToken(t) { t ? localStorage.setItem("sl_admin", t) : localStorage.removeItem("sl_admin"); DB.state = null; },
};

function renderSession() {
  const el = $("#sessionArea");
  if (!el) return;
  if (session.token) {
    el.innerHTML = `
      <span class="sess-wide">
        <span class="who">Logged in as <b>${esc(session.name)}</b></span>
        <a class="btn sm" href="#/account">Account settings</a>
        <button class="btn sm hdrOut">Log out</button>
        <span class="ver" title="App build">v${APP_BUILD}</span>
      </span>
      <span class="sess-narrow">
        <a class="userchip" href="#/account" title="Account settings">${esc(session.name.split(" ")[0] || "Account")}</a>
        <button class="btn sm hdrOut">Log out</button>
      </span>`;
    $$(".hdrOut", el).forEach((b) => b.addEventListener("click", () => {
      if (!admConfirmDiscard("Log out")) return;
      session.logout();
      renderSession();
      toast("Logged out");
      render();
    }));
  } else {
    el.innerHTML = `<a class="btn sm primary" href="#/login">Log in</a>`;
  }
  const bar = $("#commishBar");
  if (bar) {
    if (session.adminToken) {
      bar.hidden = false;
      const peek = commishPeek();
      bar.innerHTML = `<span>🧑‍⚖️ Logged in as <b>Commissioner</b></span><a href="#/admin">Open the desk</a>
        <button class="btn sm" id="cbPeek" title="Toggle whether you see everyone's hidden picks">${peek ? "👁 Revealing hidden picks" : "🙈 Picks hidden (like everyone else)"}</button>
        <span style="flex:1"></span><button class="btn sm" id="cbEnd">End session</button>`;
      $("#cbPeek").addEventListener("click", () => {
        if (!admConfirmDiscard("Switch views")) return;
        try { localStorage.setItem("sl_peek", peek ? "0" : "1"); } catch {}
        DB.state = null;
        renderSession();
        toast(peek ? "Back to the blind view" : "All-seeing mode on. The desk always sees everything regardless.");
        render();
      });
      $("#cbEnd").addEventListener("click", () => {
        if (!admConfirmDiscard("End the session")) return;
        session.adminToken = ""; admCtx = null; renderSession(); toast("Commissioner session ended"); render();
      });
    } else {
      bar.hidden = true;
      bar.innerHTML = "";
    }
  }
}

/* ---------- per-viewer favorites (this device only) ---------- */
let starSet = (() => { try { return new Set(JSON.parse(localStorage.getItem("sl_stars") || "[]")); } catch { return new Set(); } })();
const saveStars = () => { try { localStorage.setItem("sl_stars", JSON.stringify([...starSet])); } catch {} };

/* ---------- data cache ---------- */
const APP_BUILD = "2026-09-27b"; // must match api.mjs (a test enforces it)

/* A phone tab can sleep for weeks and wake up running ancient code (which is
   how a user saw "Missing Pick!" on picks the server had happily saved).
   When the server reports a newer build, swap ourselves out. */
function maybeSelfUpdate(serverBuild) {
  if (!serverBuild || serverBuild === APP_BUILD) return;
  let last = 0;
  try { last = Number(sessionStorage.getItem("sl_verreload") || 0); } catch {}
  if (Date.now() - last < 10 * 60e3) return; // CDN can lag a beat; never reload-loop
  const go = () => {
    try { sessionStorage.setItem("sl_verreload", String(Date.now())); } catch {}
    location.reload();
  };
  const busy = currentRoute() === "admin" && admUnsavedCount() > 0; // never reload over unsaved desk edits
  if (document.hidden && !busy) return go(); // nobody is looking; swap silently
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
  if (!typing && !busy) { toast("New league app version. Refreshing…", 1500); return setTimeout(go, 1400); }
  if (document.querySelector("#verBanner")) return;
  const b = document.createElement("div");
  b.id = "verBanner";
  b.className = busy ? "verbar stacked" : "verbar";
  b.innerHTML = `<span>League app updated.${busy ? " Save or discard your desk edits, then refresh." : ""}</span><button class="btn sm primary" id="verGo">Refresh</button>`;
  document.body.appendChild(b);
  b.querySelector("#verGo").addEventListener("click", go);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && document.querySelector("#verBanner") && !(currentRoute() === "admin" && admUnsavedCount())) go();
  }, { once: true });
}

const DB = { state: null, stateAt: 0, scores: {}, scoresAt: {}, news: null, newsAt: 0, admin: null, winprob: {}, winprobAt: {} };
const desktopMQ = window.matchMedia("(min-width: 900px)");
const isDesktop = () => desktopMQ.matches;
desktopMQ.addEventListener?.("change", () => { if (currentRoute() === "standings") window.__boardRefresh?.(); });
let renderSeq = 0; // a slow page finishing after the user moved on must not paint over the new page

const commishPeek = () => { try { return localStorage.getItem("sl_peek") === "1"; } catch { return false; } };

async function loadState(force = false) {
  if (!force && DB.state && Date.now() - DB.stateAt < 20000) return DB.state;
  // Commissioners browse blind by default; the peek toggle sends the admin
  // token and unlocks the all-seeing view.
  const tok = (commishPeek() && session.adminToken) ? session.adminToken : (session.token || "");
  DB.state = await api(`/api/state${tok ? `?token=${encodeURIComponent(tok)}` : ""}`);
  DB.stateAt = Date.now();
  try { DB.stateSig = JSON.stringify(DB.state.snapshot); } catch { DB.stateSig = String(Date.now()); }
  maybeSelfUpdate(DB.state.appVersion);
  const cfg = DB.state.cfg;
  $("#brandName").textContent = cfg.leagueName || "Survivor League";
  $("#brandSub").textContent = `${cfg.seasonYear} season${cfg.established ? ` · est. ${cfg.established}` : ""}`;
  document.title = cfg.leagueName || "Survivor League";
  return DB.state;
}
async function loadWinProb(week) {
  const k = week || "cur";
  if (DB.winprob[k] && Date.now() - (DB.winprobAt[k] || 0) < 15 * 60e3) return DB.winprob[k];
  try { DB.winprob[k] = await api(`/api/winprob${week ? `?week=${week}` : ""}`); } catch { DB.winprob[k] = { probs: {} }; }
  DB.winprobAt[k] = Date.now();
  return DB.winprob[k];
}
async function loadScores(week, force = false) {
  const k = week || "cur";
  if (!force && DB.scores[k] && (DB.scoresDone?.[k] || Date.now() - (DB.scoresAt[k] || 0) < 60000)) return DB.scores[k];
  DB.scores[k] = await api(`/api/scores${week ? `?week=${week}` : ""}`);
  DB.scoresAt[k] = Date.now();
  DB.scoresDone = DB.scoresDone || {};
  DB.scoresDone[k] = !!(DB.scores[k].games?.length && DB.scores[k].games.every((g) => g.completed)); // finals don't move; stop refetching them
  return DB.scores[k];
}
/* Unread trash talk: the newest post time this device has seen, kept locally. */
const chatSeen = () => { try { return Number(localStorage.getItem("sl_chatseen")) || 0; } catch { return 0; } };
const chatMsOf = (id) => Number(String(id || "").split(":")[2]?.slice(0, 14)) || 0;
function markChatSeen(ms) {
  if (!ms || ms <= chatSeen()) return;
  try { localStorage.setItem("sl_chatseen", String(ms)); } catch {}
  if (DB.chatTease) DB.chatTease.newer = 0;
  updateChatBadges(0);
}
function updateChatBadges(n) {
  const cell = $("#chatNew");
  if (cell) { cell.textContent = `${n} new`; cell.hidden = !n; }
  const nav = $("#topnav a[data-route='chat']");
  if (nav) {
    let dot = nav.querySelector(".navdot");
    if (!dot) { dot = document.createElement("span"); dot.className = "navdot"; nav.appendChild(dot); }
    dot.textContent = n > 99 ? "99+" : String(n);
    dot.hidden = !n;
  }
  const more = $("#tabbar a[data-route='more'] .tab-ico");
  if (more) {
    let dot = more.querySelector(".tabdot");
    if (!dot) { dot = document.createElement("span"); dot.className = "tabdot"; more.appendChild(dot); }
    dot.hidden = !n;
  }
}
async function loadChatTease(force = false) {
  if (!force && DB.chatTease !== undefined && Date.now() - (DB.chatTeaseAt || 0) < 90000) return DB.chatTease;
  const seen = chatSeen();
  DB.chatTease = await api(`/api/chat?limit=1&since=${seen}`).then((r) => {
    const latest = r.messages?.[r.messages.length - 1] || null;
    if (!seen && r.newest) { try { localStorage.setItem("sl_chatseen", String(r.newest)); } catch {} } // first visit: nothing counts as unread
    return { latest, newer: seen ? r.newer || 0 : 0, newest: r.newest || 0 };
  }).catch(() => ({ latest: null, newer: 0, newest: 0 }));
  DB.chatTeaseAt = Date.now();
  updateChatBadges(DB.chatTease.newer);
  return DB.chatTease;
}
async function loadNews() {
  if (DB.news && Date.now() - DB.newsAt < 10 * 60e3) return DB.news;
  try { DB.news = (await api("/api/news")).items || []; } catch { DB.news = DB.news || []; }
  DB.newsAt = Date.now();
  return DB.news;
}

/* ---------- shared renderers ---------- */
function chip(team, extra = "") {
  if (!team) return `<span class="muted">—</span>`;
  return `<span class="chip ${extra}"><img src="${logoOf(team)}" alt="" loading="lazy"><span>${esc(team)}</span></span>`;
}

/* Generic scrambled "mystery pick" chip. Deliberately the same image for
   everyone — hidden picks never reach the client, so there is nothing real
   to blur. */
const MYSTERY_LOGO = "data:image/svg+xml," + encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>" +
  "<defs><filter id='b' x='-40%' y='-40%' width='180%' height='180%'><feGaussianBlur stdDeviation='2.8'/></filter></defs>" +
  "<g filter='url(#b)'>" +
  "<circle cx='15' cy='16' r='12' fill='#1f3a66'/>" +
  "<path d='M8 21 L16 6 L25 21 Z' fill='#c8332b'/>" +
  "<circle cx='20.5' cy='18' r='6' fill='#e8c34a'/>" +
  "<circle cx='11' cy='13' r='4.5' fill='#f2f2f2'/>" +
  "</g></svg>");
const mysteryChip = () => `<span class="chip mystery" title="Hidden until kickoff"><img src="${MYSTERY_LOGO}" alt="Hidden pick"><span class="mtxt">▮▮▮▮▮▮</span></span>`;
const mysteryCell = () => `<span class="cellteam mystery" title="Hidden until kickoff"><img src="${MYSTERY_LOGO}" alt="Hidden pick"> <span class="mtxt">▮▮▮</span></span>`;
/* Primary team colors for the distribution donut (ESPN abbreviations). */
const TEAM_COLORS = { ARI: "#97233F", ATL: "#A71930", BAL: "#241773", BUF: "#00338D", CAR: "#0085CA", CHI: "#0B162A", CIN: "#FB4F14", CLE: "#311D00", DAL: "#041E42", DEN: "#FB4F14", DET: "#0076B6", GB: "#203731", HOU: "#03202F", IND: "#002C5F", JAX: "#006778", KC: "#E31837", LV: "#A5ACAF", LAC: "#0080C6", LAR: "#003594", MIA: "#008E97", MIN: "#4F2683", NE: "#002244", NO: "#D3BC8D", NYG: "#0B2265", NYJ: "#125740", PHI: "#004C54", PIT: "#FFB612", SF: "#AA0000", SEA: "#69BE28", TB: "#D50A0A", TEN: "#4B92DB", WAS: "#5A1414", WSH: "#5A1414" };
function teamColor(name) {
  const ab = String(abbrOf(name) || "").toUpperCase();
  if (TEAM_COLORS[ab]) return TEAM_COLORS[ab];
  let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 45%)`;
}
/* Has the server revealed this game's picks in the snapshot we hold? Picks lock on
   the clock at the scheduled kickoff, but ESPN keeps a game "pre" until the real
   kickoff a few minutes later, so ESPN's state alone hides names that are already
   public. A snapshot built at or after kickoff carries the reveal. Server time on
   both sides, so a wrong phone clock can't reveal anything early. */
const picksRevealed = (g, snap) => g.state !== "pre" || Date.parse(snap?.builtAt) >= Date.parse(g.date);
/* What a slot is doing on a team: riding until the whistle, then still kicking or toast. */
const rideWord = (done, result) => (!done ? "riding" : result === "loss" ? "toast" : "still kicking");
const rideLabel = (n, done, result) => `${n} ${rideWord(done, result)}`;
function markFor(result) {
  if (result === "win") return `<span class="mark win">✓</span>`;
  if (result === "loss") return `<span class="mark loss">✗</span>`;
  if (result === "live-leading") return `<span class="mark up">▲ up</span>`;
  if (result === "live-trailing") return `<span class="mark down">▼ down</span>`;
  if (result === "live-tied") return `<span class="mark tie">— tied</span>`;
  return `<span class="mark pending"></span>`;
}
/* Copy of standingOf in lib/rules.mjs (the browser can't import it); keep them identical. */
function standingOf(r, week) {
  if (r.status === "dead") return "out";
  if (r.status === "buyback-available" || r.status === "buyback-pending") return "limbo";
  return r.weeks?.[week]?.result === "win" ? "safe" : "vulnerable";
}
const STANDING_WORD = { safe: "Safe", vulnerable: "Vulnerable", limbo: "In limbo" };
function statusBadge(row, week) {
  const st = standingOf(row, week);
  if (st === "safe") return `<span class="badge alive" title="This week's pick won. Nothing can take you out this week.">Safe</span>`;
  if (st === "vulnerable") return `<span class="badge vuln" title="Still in it, but this week isn't won yet.">Vulnerable</span>`;
  if (st === "limbo") return `<span class="badge limbo" title="Lost in weeks 1–3 and not settled: not bought back yet with the window still open, or bought back and waiting on the commissioner to confirm the $.">In limbo</span>`;
  return `<span class="badge dead">💀 Out · W${row.eliminatedWeek ?? "?"}</span>`;
}
const moneyBags = (n) => (n > 0 ? `<span title="${n} buy-back${n > 1 ? "s" : ""}">${"💸".repeat(Math.min(n, 4))}</span>` : "");

/* Week-level buy-back state, shown next to a losing pick. */
function buybackTag(rec) {
  if (!rec || rec.result !== "loss") return "";
  if (rec.buyback === "confirmed") return `<span class="bbtag ok">💸 bought back</span>`;
  if (rec.buyback === "pending") return `<span class="bbtag warn">⏳ buy-back pending</span>`;
  if (rec.buyback === "available") return `<span class="bbtag warn">💸 can buy back</span>`;
  if (rec.buyback === "expired") return `<span class="bbtag off">window closed</span>`;
  if (rec.buyback === "sudden-death") return `<span class="bbtag off">sudden death</span>`;
  return "";
}

function buildTimeline(r) {
  const rows = Object.entries(r.weeks || {}).filter(([, rec]) => rec?.team || rec?.note).sort((a, b) => b[0] - a[0]);
  if (!rows.length) return `<div class="muted small">No picks yet.</div>`;
  return rows.map(([w, rec]) => `
    <div class="trow"><span class="twk">W${w}</span>${rec.team ? chip(rec.team) : `<span class="muted">no pick</span>`}${markFor(rec.result)}${buybackTag(rec)}${rec.source === "auto-default" ? `<span class="muted small">auto</span>` : ""}${rec.note ? `<span class="muted small">${esc(rec.note)}</span>` : ""}</div>`).join("");
}

/* Week-state coloring shared by leaderboard cards and picks tiles:
   green border = pick in, red border = missing, full tint once graded. */
function weekState(r, cur, isMine) {
  if (r.status === "dead") return { cls: "", tag: "" };
  if (cur?.result === "win") return { cls: "t-won", tag: "" };
  if (cur?.result === "loss") return { cls: "t-lost", tag: "" };
  if (!isMine) return { cls: "", tag: "" }; // others' unstarted weeks reveal nothing, not even pick-existence
  if (!cur?.team) return { cls: "t-missing", tag: `<span class="bbtag bad">Missing Pick!</span>` };
  return { cls: "t-in", tag: `<span class="bbtag ok">Pick in!</span>` };
}

/* One slot as a standings card. Used by the standings page and the demo gallery. */
function slotCardHTML(r, curWeek, { open = false, mine = false, reveal = false, star = true, expandBtn = true } = {}) {
  const cur = r.weeks[curWeek];
  const ws = weekState(r, cur, mine || reveal); // reveal = commissioner peek: true state is visible, so flag it
  const showEmpty = mine || reveal || r.status === "dead";
  // Who still has to act this week. Pick existence for the current week is
  // public (hidden markers), so this shows for everyone, never which team.
  const noPick = r.status !== "dead" && !cur?.team && !cur?.hidden;
  const todo = !noPick ? "" : r.status === "buyback-available"
    ? `<span class="bbtag warn" title="Lost last week: buy back, then pick">💸 Buy back + pick</span>`
    : `<span class="bbtag bad" title="No pick yet this week">✍️ Needs a pick</span>`;
  return `<div class="card tight slotcard ${r.status === "dead" ? "dead" : ""} ${mine ? "mine" : ""} ${ws.cls}">
    <div class="row1">
      ${star ? `<button class="starbtn ${starSet.has(r.id) ? "on" : ""}" data-star="${r.id}" title="Favorite">${starSet.has(r.id) ? "★" : "☆"}</button>` : ""}
      <span class="name">${esc(r.label)}</span>
      ${moneyBags(r.buybacksUsed)}
      ${statusBadge(r, curWeek)}
      ${expandBtn ? `<button class="expand" data-expand="${r.id}">${open ? "▴" : "▾"}</button>` : ""}
    </div>
    <div class="row2">
      <span class="muted small">W${curWeek}:</span>
      ${cur?.team ? chip(cur.team) : cur?.hidden ? `${mysteryChip()}<span class="muted small">pick is hidden until kickoff</span>` : (showEmpty && !noPick ? `<span class="muted small">no pick yet</span>` : "")}
      ${cur ? markFor(cur.result) : ""}
      ${cur ? buybackTag(cur) : ""}
      ${noPick ? todo : ws.tag}
      ${cur?.source === "auto-default" ? `<span class="muted small">(auto)</span>` : ""}
    </div>
    ${open ? `<div class="timeline">${buildTimeline(r)}</div>` : ""}
  </div>`;
}

/* One slot as a My Picks tile. Used by the picks page and the demo gallery. */
function tileHTML(r, curWeek, cfg, { selected = false, open = false, demo = false, sched = null } = {}) {
  const cur = r.weeks[curWeek];
  let pickSelect = "";
  if (sched && !demo && r.status !== "dead" && !cur?.locked) {
    const usedWeek = {};
    for (const [w, rec] of Object.entries(r.weeks || {})) {
      if (rec?.team && Number(w) !== Number(curWeek)) usedWeek[rec.team] = w;
    }
    const nowMs = Date.now();
    const entries = (sched.games || []).flatMap((g) => [g.away, g.home].filter(Boolean).map((t) => ({
      name: t.name,
      kicked: g.state !== "pre" || new Date(g.date).getTime() <= nowMs,
    }))).sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length) {
      const opts = entries.map((t) => {
        const uw = usedWeek[t.name];
        const dis = t.kicked || uw;
        const label = `${t.name}${uw ? ` · picked W${uw}!` : t.kicked ? " · kicked off" : ""}`;
        return `<option value="${esc(t.name)}" ${dis ? "disabled" : ""} ${cur?.team === t.name ? "selected" : ""}>${esc(label)}</option>`;
      }).join("");
      pickSelect = `<div class="t-cta"><select class="tilepick" data-tpslot="${r.id}"><option value="">${cur?.team ? `Change W${curWeek} pick…` : `Pick for W${curWeek}…`}</option>${opts}</select></div>`;
    }
  }
  const avail = Object.entries(r.weeks || {}).filter(([, rec]) => rec?.buyback === "available");
  const pend = Object.entries(r.weeks || {}).filter(([, rec]) => rec?.buyback === "pending");
  const bbAttr = (w) => demo ? `data-demo="1"` : `data-buyback="${r.id}" data-loss="${w}"`;
  const cta =
    avail.map(([w]) => `<div class="t-cta"><button class="btn sm primary" ${bbAttr(w)}>Buy back W${w} · ${fmtMoney(cfg.buybackFee)}</button></div>`).join("") +
    (avail.length && r.buybackDeadline ? `<div class="t-cta muted small">buy back by ${fmtDeadline(r.buybackDeadline)} (your next week's last kickoff) or you're out</div>` : "") +
    pend.map(([w]) => `<div class="t-cta muted small">⏳ W${w} buy-back waiting on the commissioner · keep picking meanwhile</div>`).join("");
  const ws = weekState(r, cur, true);
  return `<div class="slottile ${selected ? "selected" : ""} ${r.status === "dead" ? "dead-tile" : ""} ${ws.cls}" data-tile="${r.id}" role="button" tabindex="0" aria-pressed="${selected}">
    <span class="t-name">${esc(r.label)}<span class="spacer"></span>${moneyBags(r.buybacksUsed)}${statusBadge(r, curWeek)}
      <button class="expand" data-texpand="${r.id}" title="Pick history">${open ? "▴" : "▾"}</button></span>
    <span class="t-pick"><span class="t-wk">W${curWeek}</span>${cur?.team ? `${chip(cur.team)}${markFor(cur.result)}${buybackTag(cur)}${cur.locked && cur.result === "pending" ? `<span class="badge brand">locked</span>` : ""}${!cur.locked && !demo ? `<button class="unpick" data-unpick="${r.id}" title="Remove this pick">✕</button>` : ""}` : `<span class="muted">no pick yet</span>`}${ws.tag}</span>
    ${pickSelect}
    ${cta}
    ${open ? `<div class="timeline">${buildTimeline(r)}</div>` : ""}
  </div>`;
}

/* ---------- login (shared form) ---------- */
/* "Text <name>" link from the first commissioner contact with a phone number. */
/* Contact buttons for a commissioner. The row already says who they are, and
   the digits stay in the href: the dialer and the mail app show them soon
   enough, the page doesn't have to. */
function contactBtns(c) {
  const tel = String(c?.phone || "").replace(/[^\d+]/g, "");
  const mail = String(c?.email || "").trim();
  return [
    tel ? `<a class="btn sm" href="sms:${esc(tel)}">💬 Text</a>` : "",
    /^[^\s@]+@[^\s@]+$/.test(mail) ? `<a class="btn sm" href="mailto:${esc(mail)}">✉️ Email</a>` : "",
  ].join("") || `<span class="muted small">no contact on file</span>`;
}

function commishTextLink(cfg, verb = "Text") {
  const c = (cfg?.contacts || []).find((x) => x?.phone);
  if (!c) return "text the commissioner";
  return `<a href="sms:${encodeURIComponent(String(c.phone).replace(/[^\d+]/g, ""))}">${esc(verb)} ${esc(c.name || "the commissioner")}</a>`;
}
/* Your tab: the buy-back button no longer hands you to Venmo, so the bill shows
   up here instead. Server sends this for your own slots only. */
function owedNoteHTML(owed, cfg, slotName = () => "") {
  const rows = (owed || []).filter((o) => o.total > 0);
  if (!rows.length) return "";
  const total = rows.reduce((n, o) => n + o.total, 0);
  const lines = rows.map((o) => {
    const bits = [];
    if (o.buyin) bits.push(`${fmtMoney(o.buyin)} buy-in`);
    for (const w of o.buybackWeeks) bits.push(`${fmtMoney(cfg.buybackFee)} week ${w} buy-back`);
    const who = slotName(o.slotId);
    return `<div class="trow"><span>${who ? `${esc(who)}: ` : ""}${bits.join(" + ")}</span></div>`;
  }).join("");
  return `<div class="banner">💸 You owe <b>${fmtMoney(total)}</b>${cfg.venmo ? ` · <a target="_blank" rel="noopener" href="https://venmo.com/u/${encodeURIComponent(cfg.venmo)}">pay @${esc(cfg.venmo)}</a>` : ""}${lines}</div>`;
}

const payArrangementsNote = (cfg) => `<p class="muted small" style="margin:10px 0 0;">Set up other payment arrangements, or don't have Venmo? ${commishTextLink(cfg)}.</p>`;
function loginFormHTML(players, cfg, heading = "Log in") {
  const options = players.slice().sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => `<option value="${esc(p.name)}"></option>`).join("");
  let lastName = "";
  try { lastName = localStorage.getItem("sl_lastName") || ""; } catch {}
  return `
    <div class="card" style="max-width:420px;margin:24px auto;">
      ${cfg.joinOpen ? `
      <h2>First time here?</h2>
      <p class="muted small" style="margin-bottom:10px;">Most of the league is signing up fresh this season. It takes 30 seconds: pick a PIN, grab your slots, done.</p>
      <a class="btn cta block" href="#/join">Join the league</a>
      <div class="ordiv"><div class="line"></div><span>already signed up?</span><div class="line"></div></div>` : ""}
      <h2>${esc(heading)}</h2>
      <p class="muted small">Use the name + PIN you chose when you joined. Forgot the PIN? Text the commissioner.</p>
      <label class="field"><span>Who are you?</span><input id="loginWho" list="loginNames" placeholder="Start typing your name…" autocomplete="off" value="${esc(lastName)}"><datalist id="loginNames">${options}</datalist></label>
      <label class="field"><span>PIN</span><input id="loginPin" inputmode="numeric" autocomplete="one-time-code" placeholder="Your PIN"></label>
      <button class="btn primary block" id="loginBtn">Log in</button>
      <p class="muted small" style="margin-top:12px;">🔒 You'll stay logged in on this device until you log out.</p>
      <p class="muted small" style="margin-top:4px;">Commissioner? <a href="#/admin">Log in to the desk</a></p>
    </div>`;
}
function bindLoginForm(players, onSuccess) {
  $("#loginBtn")?.addEventListener("click", async () => {
    const typed = $("#loginWho").value.trim().toLowerCase();
    const pin = $("#loginPin").value.trim();
    if (!typed || !pin) return toast("Type your name and enter your PIN");
    const exact = players.find((p) => p.name.toLowerCase() === typed);
    const prefix = players.filter((p) => p.name.toLowerCase().startsWith(typed));
    const match = exact || (prefix.length === 1 ? prefix[0] : null);
    if (!match) return toast(prefix.length > 1 ? "A few names match that. Keep typing." : "Couldn't find that name. Pick it from the list.");
    try {
      const r = await api("/api/auth", { playerId: match.id, pin });
      session.login(r.token, r.playerId, r.name);
      renderSession();
      toast(`Welcome back, ${r.name}`);
      onSuccess();
    } catch (e) { toast(e.message); }
  });
  $("#loginPin")?.addEventListener("keydown", (e) => { if (e.key === "Enter") $("#loginBtn").click(); });
}

/* ---------- views ---------- */
const view = $("#view");
const expanded = new Set();
const tileExpanded = new Set();
let standingsFilter = "";
let standingsSort = "status"; // status | first | last
let recapWeek = null; // which finished week the recaps cell is showing
let standingsStatus = "all"; // all | safe | vulnerable | limbo | out | needpick | needbuy | live
let standingsStars = false; // ★ toggle: favorites only, on top of the filter
const managedIdsOf = (players) => new Set((players || []).filter((p) => p.managedBy && p.managedBy === session.playerId).map((p) => p.id));
const lastNameKey = (label) => {
  const base = label.replace(/\s*\(\d+\)\s*$/, "").trim();
  const parts = base.split(/\s+/);
  return ((parts[parts.length - 1] || base) + " " + base).toLowerCase();
};
let returnAfterLogin = "picks";
let lastRoute = null;

async function renderStandings() {
  const mySeq = ++renderSeq;
  const [{ snapshot: s, cfg }, news, chatInfo] = await Promise.all([loadState(), loadNews(), loadChatTease()]);
  const latestChat = chatInfo?.latest || null;
  // This week's slate powers the "Playing now" filter and the group-by-team headers.
  // Names are only ever attached to picks the server has already revealed (locked at kickoff).
  let sched = { games: [] };
  try { sched = await loadScores(s.week); } catch {}
  const weekGames = (sched.games || []).slice().sort((a, b) => new Date(a.date) - new Date(b.date));
  const liveTeams = new Set();
  for (const g of weekGames) if (g.state === "in") for (const t of [g.away, g.home]) liveTeams.add(t.name);
  if (standingsStatus === "live" && !s.liveNow) standingsStatus = "all";
  const limboNote = s.limboCount > 0 && s.buybackDeadline
    ? `<div class="banner">⏳ ${s.limboCount} slot${s.limboCount > 1 ? "s" : ""} in buy-back limbo. A loss must be bought back before your next week's LAST kickoff (buy back Monday and ride MNF if you must). First deadline: <b>${fmtDeadline(s.buybackDeadline)}</b>.</div>` : "";
  const managed = managedIdsOf(DB.state.players);
  const mine = (r) => r.playerId && (r.playerId === session.playerId || managed.has(r.playerId));
  const revealAll = commishPeek() && !!session.adminToken; // peek mode sees true pick state, so it flags missing picks too
  // Aggregate pick progress is public: hidden markers prove a pick exists without saying which team.
  const aliveish = s.aliveCount + s.limboCount;
  const picksIn = s.slots.filter((r) => r.status !== "dead" && (r.weeks?.[s.week]?.team || r.weeks?.[s.week]?.hidden)).length;
  // "No pick" is two different jobs: pick (still alive, or already bought
  // back), or buy back last week's loss first and then pick.
  const toDo = (r) => (r.status === "dead" || r.weeks?.[s.week]?.team || r.weeks?.[s.week]?.hidden) ? null
    : r.status === "buyback-available" ? "buyback" : "pick";
  const needPickN = s.slots.filter((r) => toDo(r) === "pick").length;
  const needBuyN = s.slots.filter((r) => toDo(r) === "buyback").length;
  const missingNow = needPickN + needBuyN;
  if ((standingsStatus === "needpick" && !needPickN) || (standingsStatus === "needbuy" && !needBuyN)) standingsStatus = "all";
  const standingCounts = { safe: 0, vulnerable: 0, limbo: 0, out: 0 };
  for (const r of s.slots) standingCounts[standingOf(r, s.week)]++;
  // Two ledgers that add up, because "299 / 337 · 163 vulnerable · 136 in limbo"
  // made nobody's arithmetic work on the first read.
  const ledgerRow = (icon, label, val, cls = "") => `<div class="ledrow ${cls}"><span class="ledi">${icon}</span><span class="ledl">${label}</span><span class="ledv">${val}</span></div>`;
  const statusLedger = [
    ledgerRow("✓", STANDING_WORD.safe, standingCounts.safe, "st-safe"),
    ledgerRow("◷", STANDING_WORD.vulnerable, standingCounts.vulnerable, "st-vuln"),
    ledgerRow("💸", STANDING_WORD.limbo, standingCounts.limbo, "st-limbo"),
    ledgerRow("=", "Still alive", aliveish, "sum"),
    ledgerRow("💀", "Out", standingCounts.out, "st-out"),
    ledgerRow("", "Slots", s.totalSlots, "total"),
  ].join("");
  const potBuyIn = s.pot.buyIn ?? cfg.buyIn;
  const potBuybacks = s.pot.buybacks || (cfg.buybackFee ? Math.round((s.pot.buybackCash || 0) / cfg.buybackFee) : 0);
  const potLedger = [
    ledgerRow("🎟️", `${s.pot.entries} entr${s.pot.entries === 1 ? "y" : "ies"} × ${fmtMoney(potBuyIn)}`, fmtMoney(s.pot.entries * potBuyIn)),
    ledgerRow("💸", `${potBuybacks} buy-back${potBuybacks === 1 ? "" : "s"}`, fmtMoney(s.pot.buybackCash || 0)),
    ledgerRow("=", "Pot total", fmtMoney(s.pot.total), "sum"),
  ].join("");
  const isLive = (r) => { const rec = r.weeks?.[s.week]; return !!(rec?.team && rec.locked === true && liveTeams.has(rec.team)); };
  const passes = {
    all: () => true,
    safe: (r) => standingOf(r, s.week) === "safe",
    vulnerable: (r) => standingOf(r, s.week) === "vulnerable",
    limbo: (r) => standingOf(r, s.week) === "limbo",
    out: (r) => r.status === "dead",
    needpick: (r) => toDo(r) === "pick",
    needbuy: (r) => toDo(r) === "buyback",
    live: isLive,
  };
  if (!passes[standingsStatus]) standingsStatus = "all";
  const liveCount = s.liveNow ? s.slots.filter(isLive).length : 0;
  const filterOpts = [
    ["all", `All (${s.totalSlots})`],
    ["safe", `Safe (${standingCounts.safe})`],
    ["vulnerable", `Vulnerable (${standingCounts.vulnerable})`],
    ["limbo", `In limbo (${standingCounts.limbo})`],
    ["out", `💀 Out (${standingCounts.out})`],
    ...(needPickN ? [["needpick", `✍️ Needs a pick (${needPickN})`]] : []),
    ...(needBuyN ? [["needbuy", `💸 Buy back, then pick (${needBuyN})`]] : []),
    ...(s.liveNow ? [["live", `🔴 Playing now (${liveCount})`]] : []),
  ];
  const computeRows = () => {
    let rows = s.slots.filter((r) => !standingsFilter || r.label.toLowerCase().includes(standingsFilter) || r.playerName.toLowerCase().includes(standingsFilter));
    rows = rows.filter(passes[standingsStatus]);
    if (standingsStars) rows = rows.filter((r) => starSet.has(r.id));
    if (standingsSort === "first") rows = rows.slice().sort((a, b) => a.label.localeCompare(b.label));
    if (standingsSort === "last") rows = rows.slice().sort((a, b) => lastNameKey(a.label).localeCompare(lastNameKey(b.label)));
    return [...rows.filter(mine), ...rows.filter((r) => !mine(r))]; // yours lead; the rest keep the chosen order
  };
  /* Rows -> [{ head?, rows }]. The plain list is one headerless group; a
     signed-in player gets "Your slots" over "Everyone else". Grouping by team
     used to live here and moved to the scoreboard, which shows the same thing
     with logos, the live score, and every rider's name. */
  const groupRows = (rows) => {
    const yours = rows.filter(mine);
    if (!yours.length || yours.length === rows.length) return [{ rows }];
    return [{ head: `Your slots · ${yours.length}`, rows: yours }, { head: `Everyone else · ${rows.length - yours.length}`, rows: rows.filter((r) => !mine(r)) }];
  };

  /* Three cells, one job each: the season behind the league, the weeks that
     are done, and the week in front of everyone. The same number stops
     appearing in three places, and nothing about an unrevealed pick leaks. */
  const statRow = (ico, label, value) => `<div class="trow"><span style="width:22px;text-align:center;">${ico}</span><span class="muted" style="flex:1;min-width:140px;">${label}</span><span style="font-weight:700;color:var(--ink);display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end;text-align:right;">${value}</span></div>`;
  const cellOpen = (k, dflt) => { try { const v = localStorage.getItem(`sl_cell_${k}`); return v === null ? dflt : v === "1"; } catch { return dflt; } };

  // Season totals, from revealed picks only, so every viewer sees one number.
  let losses = 0, buybacks = 0;
  const teamCounts = {}, curCounts = {};
  for (const r of s.slots) {
    buybacks += r.buybacksUsed || 0;
    for (const [w, rec] of Object.entries(r.weeks || {})) {
      if (!rec?.team || rec.locked !== true) continue;
      teamCounts[rec.team] = (teamCounts[rec.team] || 0) + 1;
      if (rec.result === "loss") losses++;
      if (Number(w) === s.week) curCounts[rec.team] = (curCounts[rec.team] || 0) + 1;
    }
  }
  const burned = Object.entries(teamCounts).sort((a, b) => b[1] - a[1])[0];
  const chalk = Object.entries(curCounts).sort((a, b) => b[1] - a[1])[0];
  const revealedNow = Object.values(curCounts).reduce((a, b) => a + b, 0);
  const untouched = 32 - Object.keys(teamCounts).length;
  const perfect = s.slots.filter((r) => r.status !== "dead" && !r.buybacksUsed).length;

  /* One finished week, graded. The counts come straight off the rows already in
     memory; only the underdog line needs that week's schedule, so the fetch is
     deferred until someone actually opens the cell. The board's first paint
     stopped waiting on it. */
  const recapCounts = (week) => {
    const recs = [];
    for (const r of s.slots) {
      const rec = r.weeks?.[week];
      if (rec?.team && rec.locked === true && (rec.result === "win" || rec.result === "loss")) recs.push(rec);
    }
    if (!recs.length) return null;
    const counts = {}, deaths = {}, wins = {};
    let survived = 0;
    for (const x of recs) {
      counts[x.team] = (counts[x.team] || 0) + 1;
      if (x.result === "win") { survived++; wins[x.team] = true; }
      else deaths[x.team] = (deaths[x.team] || 0) + 1;
    }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    const dead = Object.entries(deaths).sort((a, b) => b[1] - a[1])[0];
    return { week, survived, total: recs.length, counts, wins, top, topLost: top ? !!deaths[top[0]] : false, dead, bold: null };
  };
  const withSpread = async (rc) => {
    if (!rc) return rc;
    let wsched = null;
    try { wsched = await loadScores(rc.week); } catch { return rc; } // the spread row is a bonus, never a blocker
    let bold = null; // the winning underdog with the fattest spread
    for (const [team, n] of Object.entries(rc.counts)) {
      if (!rc.wins[team]) continue;
      const g = (wsched?.games || []).find((gm) => gm.away?.name === team || gm.home?.name === team);
      const sp = g ? teamSpread(g, abbrOf(team)) : null;
      const line = sp && !sp.fav ? parseFloat(sp.text) : NaN;
      if (Number.isFinite(line) && line > 0 && (!bold || line > bold.line)) bold = { team, line, n };
    }
    return { ...rc, bold };
  };
  const recapHTML = (rc) => !rc ? `<p class="muted small" style="margin:10px 0 0;">Nothing graded for that week yet.</p>` : `
    <div class="timeline" style="border:0;padding:0;">
      ${statRow("🧮", "Survived the week", `${rc.survived} of ${rc.total} picks`)}
      ${rc.top ? statRow("🐑", "Chalkiest ride", `${chip(rc.top[0])} ${rc.top[1]}× ${rc.topLost ? "· and it LOST. Carnage." : "· and it held"}`) : ""}
      ${rc.bold ? statRow("🎢", "Riskiest pick that lived", `${chip(rc.bold.team)} won as a +${rc.bold.line} dog (${rc.bold.n} rode it)`) : ""}
      ${rc.dead ? statRow("🪦", "Widowmaker", `${chip(rc.dead[0])} sent ${rc.dead[1]} slot${rc.dead[1] > 1 ? "s" : ""} packing`) : ""}
    </div>`;

  // Weeks with something graded in them. Newest first: that is the one people want.
  const gradedWeeks = [];
  for (let w = 1; w < s.week; w++) {
    if (s.slots.some((r) => { const rec = r.weeks?.[w]; return rec?.locked === true && (rec.result === "win" || rec.result === "loss"); })) gradedWeeks.push(w);
  }
  gradedWeeks.reverse();
  if (recapWeek === null || !gradedWeeks.includes(recapWeek)) recapWeek = gradedWeeks[0] ?? null;
  const shownRecap = recapWeek ? recapCounts(recapWeek) : null;

  let statsCard = "";
  if (s.totalSlots > 0) {
    const seasonCell = `<details class="adm recapcell" data-cell-key="season" ${cellOpen("season", false) ? "open" : ""}>
      <summary>📊 Season <span class="tease">${fmtMoney(s.pot.total)} pot · ${aliveish} of ${s.totalSlots} alive</span></summary>
      <div class="inner">
        <div class="statgrid">
          <div class="stat hero"><div class="k">Pot</div><div class="v">${fmtMoney(s.pot.total)}</div><div class="ledger">${potLedger}</div></div>
          <div class="stat"><div class="k">Still alive</div><div class="v">${aliveish}<span class="unit"> / ${s.totalSlots}</span></div><div class="ledger">${statusLedger}</div></div>
          <div class="stat"><div class="k">Projected payout</div><div class="v">${fmtMoney(Math.floor((s.pot.total || 0) / Math.max(1, aliveish)))}</div><div class="sub quiet">${aliveish <= 10 || s.week >= (cfg.totalWeeks || 18) - 3 ? "per survivor if players agree to split" : "per survivor if things ended today for some reason"}</div></div>
        </div>
        <div class="timeline" style="border:0;padding:0;">
          ${statRow("💸", "Buy-backs bought", `${buybacks}${buybacks ? ` · ${fmtMoney(buybacks * (cfg.buybackFee ?? 10))} back in the pot` : ""}`)}
          ${statRow("✗", "Picks that lost (season total)", String(losses))}
          ${burned ? statRow("🔥", "Most ridden team overall", `${chip(burned[0])} ${burned[1]}×`) : ""}
          ${statRow("🧼", "NFL teams nobody has picked yet", `${untouched} of 32`)}
          ${statRow("💎", "Spotless slots (alive, zero losses)", `${perfect} of ${s.totalSlots}`)}
        </div>
      </div>
    </details>`;

    const recapsCell = `<details class="adm recapcell" data-cell-key="recaps" ${cellOpen("recaps", false) ? "open" : ""}>
      <summary>🗓️ Weekly recaps ${shownRecap
        ? `<span class="tease">W${shownRecap.week}: ${shownRecap.survived} of ${shownRecap.total} survived</span>`
        : `<span class="tease muted">come back after week ${s.week}</span>`}</summary>
      <div class="inner">
        ${gradedWeeks.length > 1 ? `<div class="weekpills">${gradedWeeks.map((w) => `<button class="btn sm ${w === recapWeek ? "primary" : ""}" data-recapweek="${w}">Week ${w}</button>`).join("")}</div>` : ""}
        <div id="recapBody">${gradedWeeks.length ? recapHTML(shownRecap) : `<p class="muted small" style="margin:10px 0 0;">Come back after week ${s.week}. Once a week wraps it lands here with the survival rate, the chalkiest ride, the riskiest pick that lived, and the Widowmaker.</p>`}</div>
      </div>
    </details>`;

    // This week, in public only: how many picks are in, and whatever kickoff
    // has already made everyone's business.
    const weekCell = `<details class="adm recapcell" data-cell-key="thisweek" ${cellOpen("thisweek", true) ? "open" : ""}>
      <summary>🏈 Current week · Week ${s.week} <span class="tease">${picksIn} of ${aliveish} picks in${s.liveNow ? " · LIVE" : ""}</span></summary>
      <div class="inner">
        <div class="timeline" style="border:0;padding:0;">
          ${statRow("✍️", "Picks in", `${picksIn} of ${aliveish}`)}
          ${missingNow
            ? (needPickN ? statRow("⏳", "No pick yet · still alive", `<span style="color:var(--loss)">${needPickN}</span>`) : "")
              + (needBuyN ? statRow("💸", "No pick yet · lost last week, buy back first", `<span style="color:var(--limbo)">${needBuyN}</span>`) : "")
            : statRow("✅", "Still no pick", "nobody, all in ✓")}
          ${revealedNow ? statRow("👀", "Revealed so far", `${revealedNow} pick${revealedNow === 1 ? "" : "s"} · the rest unlock at kickoff`) : ""}
          ${chalk ? statRow("🐑", "Chalk so far", `${chip(chalk[0])} ${chalk[1]} riding`) : ""}
        </div>
        <p class="muted small" style="margin:10px 0 0;">Picks stay hidden until their game starts, so this only counts the ones already locked. Who is riding what: <a href="#/scores">the scoreboard</a>.</p>
      </div>
    </details>`;

    statsCard = seasonCell + recapsCell + weekCell;
  }

  const weekCols = [];
  for (let w = 1; w <= (cfg.totalWeeks || 18); w++) weekCols.push(w);
  // The list redraws itself (search, stars, expand) without touching the rest
  // of the page, so the search box keeps focus and every keystroke.
  const buildBoard = () => {
    const rows = computeRows();
    const groups = groupRows(rows);
    const heads = groups.length > 1;
    const rowHTML = (r) => `<tr class="${r.status === "dead" ? "dead" : ""} ${mine(r) ? "mine" : ""}">
        <td class="sticky"><button class="starbtn ${starSet.has(r.id) ? "on" : ""}" data-star="${r.id}">${starSet.has(r.id) ? "★" : "☆"}</button> ${esc(r.label)} ${moneyBags(r.buybacksUsed)}</td>
        <td>${statusBadge(r, s.week)}</td>
        ${weekCols.map((w) => {
          const rec = r.weeks[w];
          if (rec?.hidden) return `<td>${mysteryCell()}</td>`;
          if (!rec?.team) {
            const todo = w === s.week ? toDo(r) : null;
            return todo === "buyback" ? `<td class="misscell bbcell"><span class="badge limbo" title="Lost last week: buy back, then pick">Buy back + pick</span></td>`
              : todo === "pick" ? `<td class="misscell"><span class="badge miss" title="No pick yet for week ${s.week}">Needs a pick</span></td>` : `<td></td>`;
          }
          return `<td><span class="cellteam" title="${esc(rec.team)}${rec.buyback === "confirmed" ? " (bought back)" : ""}"><img src="${logoOf(rec.team)}" alt="" loading="lazy">${abbrOf(rec.team).toUpperCase()} ${markFor(rec.result)}${rec.buyback === "confirmed" ? "💸" : ""}</span></td>`;
        }).join("")}
      </tr>`;
    const idAttr = (g) => g.id ? `id="${g.id}"` : "";
    const cards = isDesktop() ? "" : groups.map((g) => (heads ? `<div class="grouphdr" ${idAttr(g)}>${g.head}</div>` : "") +
      g.rows.map((r) => slotCardHTML(r, s.week, { open: expanded.has(r.id), mine: mine(r), reveal: revealAll })).join("")).join("");
    const table = !isDesktop() ? "" : `<div class="gridwrap desktop-only"><table class="grid">
      <thead><tr><th class="sticky">Slot</th><th>Status</th>${weekCols.map((w) => `<th>W${w}</th>`).join("")}</tr></thead>
      <tbody>${groups.map((g) => (heads ? `<tr class="ghr" ${idAttr(g)}><td colspan="${2 + weekCols.length}"><div class="ghd">${g.head}</div></td></tr>` : "") + g.rows.map(rowHTML).join("")).join("")}</tbody>
    </table></div>`;
    const emptyMsg = standingsFilter
      ? `<div class="card muted">No one matches “${esc(standingsFilter)}”. Check the spelling or clear the search.</div>`
      : standingsStars
      ? `<div class="card muted">${starSet.size ? "None of your favorites match this filter." : "No favorites yet. Tap the ☆ next to any name to build your list."}</div>`
      : standingsStatus === "live"
      ? `<div class="card muted">No game is on right now. <a href="#/scores">Scoreboard</a></div>`
      : standingsStatus === "needpick"
      ? `<div class="card muted">Everyone still alive has a week ${s.week} pick in. ✓</div>`
      : standingsStatus === "needbuy"
      ? `<div class="card muted">Nobody's stuck behind a buy-back this week.</div>`
      : standingsStatus === "out"
      ? `<div class="card muted">Nobody's out yet. Give it a Sunday.</div>`
      : standingsStatus === "safe"
      ? `<div class="card muted">Nobody has banked a win yet this week. Give it a Sunday.</div>`
      : standingsStatus === "vulnerable"
      ? `<div class="card muted">Nobody is vulnerable right now. Every pick this week is settled.</div>`
      : standingsStatus === "limbo"
      ? `<div class="card muted">Nobody's in limbo. No open buy-backs.</div>`
      : `<div class="card muted">Nobody has joined yet. Be the first: <a href="#/join">sign up</a>.</div>`;
    return isDesktop() ? (rows.length ? table : `<div class="desktop-only">${emptyMsg}</div>`) : `<div class="mobile-only">${cards || emptyMsg}</div>`;
  };


  let chatOpen = false;
  try { chatOpen = localStorage.getItem("sl_chatopen") === "1"; } catch {}
  const tease = latestChat
    ? `<span class="tease"><b>${esc(latestChat.name.split(" ")[0])}:</b> ${esc(latestChat.text.length > 64 ? latestChat.text.slice(0, 62) + "…" : latestChat.text)} <span class="muted">· ${timeAgo(latestChat.ts)}</span></span>`
    : `<span class="tease muted">nobody's talking yet. Be first.</span>`;
  const chatCell = `<details class="adm chatcell" id="chatCell" ${chatOpen ? "open" : ""}>
    <summary>🗣 Trash Talk <span class="badge new" id="chatNew" ${chatInfo?.newer ? "" : "hidden"}>${chatInfo?.newer || 0} new</span> ${tease}</summary>
    <div class="inner" id="chatMount"></div>
  </details>`;

  const tkFacts = [
    `<span>💰 Pot ${fmtMoney(s.pot.total)}</span>`,
    `<span>🟢 ${aliveish} of ${s.totalSlots} alive</span>`,
    `<span>✍️ ${picksIn} pick${picksIn === 1 ? "" : "s"} in for W${s.week}${needPickN ? ` · ${needPickN} need a pick` : ""}${needBuyN ? ` · ${needBuyN} must buy back first` : ""}</span>`,
    ...(s.liveNow ? [`<span>🔴 Games are LIVE on <a href="#/scores">the scoreboard</a></span>`] : []),
  ];
  const tkHeads = news.slice(0, 14).map((n) => n.source === "onion"
    ? `<a href="${esc(n.link)}" target="_blank" rel="noopener" class="tk-onion" title="The Onion. Satire, obviously.">🧅 ${esc(n.headline)}</a>`
    : `<a href="${esc(n.link)}" target="_blank" rel="noopener">📰 ${esc(n.headline)}</a>`);
  const tkItems = [...tkFacts, ...tkHeads].join("");
  const ticker = `<div class="ticker"><div class="tk-label">Around the league</div><div class="tk-track"><div class="tk-move" style="animation-duration:${Math.max(36, (tkFacts.length + tkHeads.length) * 7)}s"><div class="tk-items">${tkItems}</div><div class="tk-items" aria-hidden="true">${tkItems}</div></div></div></div>`;

  if (mySeq !== renderSeq) return; // superseded while loading
  view.innerHTML = `
    ${ticker}
    ${installNudgeHTML()}
    ${cfg.leagueNote ? `<div class="banner">📣 <b>From the commish:</b> ${esc(cfg.leagueNote).replace(/\n/g, "<br>")}</div>` : ""}
    ${statsCard}
    ${chatCell}
    ${hint(`🏈 The whole league at a glance. <span class="desktop-only">The grid shows every revealed pick, week by week.</span><span class="mobile-only">Tap ▾ on a card for its full pick history.</span> Sort or filter the board with the controls below, and head to the scoreboard to see who is riding which team. ☆ marks a favorite and ★ shows only those. ${session.token ? "Your own slots stay pinned on top." : "Log in and your own slots stay pinned on top."}`, "board")}
    ${limboNote}
    <div class="searchrow">
      <input id="findme" placeholder="Find a player…" value="${esc(standingsFilter)}" autocomplete="off">
      <button class="btn sm favtoggle ${standingsStars ? "on" : ""}" id="favToggle" aria-pressed="${standingsStars}" title="Show only your favorites">★ Favorites${starSet.size ? ` (${starSet.size})` : ""}</button>
    </div>
    <div class="ctlrow">
      <label class="ctl"><span>Sort</span><select id="sortSel">
        <option value="status" ${standingsSort === "status" ? "selected" : ""}>Status</option>
        <option value="first" ${standingsSort === "first" ? "selected" : ""}>First name</option>
        <option value="last" ${standingsSort === "last" ? "selected" : ""}>Last name</option>
      </select></label>
      <label class="ctl"><span>Filter</span><select id="filterSel">${filterOpts.map(([v, t]) => `<option value="${v}" ${standingsStatus === v ? "selected" : ""}>${t}</option>`).join("")}</select></label>
      <a class="ctl ctllink" href="#/scores"><span>Who's on which team</span><b>Week ${s.week} scoreboard ›</b></a>
    </div>
    <div class="legendrow" aria-label="What the statuses mean">
      <span><span class="badge alive">Safe</span>this week's pick won</span>
      <span><span class="badge vuln">Vulnerable</span>not won yet</span>
      <span><span class="badge limbo">In limbo</span>buy-back open</span>
      <span><span class="badge dead">💀 Out</span>eliminated</span>
      <span><span class="bbtag bad">✍️ Needs a pick</span>no pick yet this week</span>
      <span><span class="bbtag warn">💸 Buy back + pick</span>lost last week, buy back first</span>
      <span>💸 buy-back used</span>
    </div>
    <div id="boardWrap">${buildBoard()}</div>
  `;
  $$("[data-cell-key]").forEach((el) => el.addEventListener("toggle", () => {
    try { localStorage.setItem(`sl_cell_${el.dataset.cellKey}`, el.open ? "1" : "0"); } catch {}
  }));
  let recapToken = 0;
  const showRecap = async (week) => {
    const mine = ++recapToken;
    const body = $("#recapBody");
    if (!body || !week) return;
    const base = recapCounts(week);
    body.innerHTML = recapHTML(base); // counts are already in memory: paint them now
    const full = await withSpread(base);
    const el = $("#recapBody");
    if (mine === recapToken && el) el.innerHTML = recapHTML(full); // a second click wins, whatever the network does
  };
  const recapsCellEl = view.querySelector('[data-cell-key="recaps"]');
  if (recapsCellEl?.open) showRecap(recapWeek);
  recapsCellEl?.addEventListener("toggle", () => { if (recapsCellEl.open) showRecap(recapWeek); });
  $$("[data-recapweek]").forEach((b) => b.addEventListener("click", () => {
    recapWeek = Number(b.dataset.recapweek);
    $$("[data-recapweek]").forEach((x) => x.classList.toggle("primary", Number(x.dataset.recapweek) === recapWeek));
    showRecap(recapWeek);
  }));
  const chatCellEl = $("#chatCell");
  if (chatCellEl) {
    if (chatCellEl.open) mountChat($("#chatMount"), { compact: true });
    chatCellEl.addEventListener("toggle", () => {
      try { localStorage.setItem("sl_chatopen", chatCellEl.open ? "1" : "0"); } catch {}
      if (chatCellEl.open) markChatSeen(DB.chatTease?.newest || 0);
      if (chatCellEl.open && !$("#chatList")) mountChat($("#chatMount"), { compact: true });
    });
  }
  const bindBoard = () => {
    $$("#boardWrap [data-star]").forEach((b) => b.addEventListener("click", () => {
      const id = b.dataset.star;
      starSet.has(id) ? starSet.delete(id) : starSet.add(id);
      saveStars();
      refreshBoard();
    }));
    $$("#boardWrap [data-expand]").forEach((b) => b.addEventListener("click", () => {
      const id = b.dataset.expand;
      expanded.has(id) ? expanded.delete(id) : expanded.add(id);
      refreshBoard();
    }));
  };
  const refreshBoard = () => {
    const wrap = $("#boardWrap");
    if (!wrap) return;
    wrap.innerHTML = buildBoard();
    bindBoard();
    const fav = $("#favToggle");
    if (fav) { fav.textContent = `★ Favorites${starSet.size ? ` (${starSet.size})` : ""}`; fav.classList.toggle("on", standingsStars); fav.setAttribute("aria-pressed", String(standingsStars)); }
  };
  bindBoard();
  window.__boardRefresh = refreshBoard; // the layout watcher below redraws when the viewport crosses the breakpoint
  $("#sortSel").addEventListener("change", (e) => { standingsSort = e.target.value; refreshBoard(); });
  $("#filterSel").addEventListener("change", (e) => { standingsStatus = e.target.value; refreshBoard(); });
  $("#favToggle").addEventListener("click", () => { standingsStars = !standingsStars; refreshBoard(); });
  $("#findme").addEventListener("input", (e) => {
    standingsFilter = e.target.value.trim().toLowerCase();
    clearTimeout(window.__findTimer); // brief debounce so 200 rows don't rebuild on every keystroke
    window.__findTimer = setTimeout(refreshBoard, 80);
  });
}

let scoresWeek = null;
async function renderScores() {
  const mySeq = ++renderSeq;
  const { snapshot: s } = await loadState();
  if (!scoresWeek) scoresWeek = s.week;
  const [data, wpDoc] = await Promise.all([loadScores(scoresWeek), loadWinProb(scoresWeek)]);
  const winProbs = wpDoc?.probs || {};
  const isCurrent = scoresWeek === s.week;
  const games = data.games || [];
  // Who is riding each team this week: only picks the server has revealed (locked at kickoff), dead slots included.
  const ridersByTeam = {};
  for (const r of s.slots) {
    const rec = r.weeks?.[scoresWeek];
    if (rec?.team && rec.locked === true) (ridersByTeam[rec.team] = ridersByTeam[rec.team] || []).push({ label: r.label, result: rec.result });
  }

  // Weekly pick distribution as a donut: revealed teams in team colors, picks that
  // exist but haven't kicked off in gray, slots with no pick at all in light red.
  const distroCounts = {};
  let hiddenN = 0, missingN = 0;
  for (const r of s.slots) {
    const rec = r.weeks?.[scoresWeek];
    if (rec?.team && rec.locked === true) { // reveals game by game as kickoffs happen
      const d = (distroCounts[rec.team] = distroCounts[rec.team] || { n: 0, result: rec.result });
      d.n += 1;
    } else if (isCurrent && r.status !== "dead") {
      if (rec?.team || rec?.hidden) hiddenN += 1; else missingN += 1; // own unlocked picks count as hidden too
    }
  }
  const distroRows = Object.entries(distroCounts).sort((a, b) => b[1].n - a[1].n);
  const distroTotal = distroRows.reduce((sum, [, d]) => sum + d.n, 0);
  const dMark = (res) => res === "win" ? " ✓" : res === "loss" ? " ✗" : "";
  const segs = distroRows.map(([team, d]) => ({ label: team, n: d.n, color: teamColor(team), result: d.result }));
  if (hiddenN) segs.push({ label: "Hidden until kickoff", n: hiddenN, color: "#c3cbd6", hidden: true });
  if (missingN) segs.push({ label: "No pick yet", n: missingN, color: "#f3c4c4", missing: true });
  const segTotal = segs.reduce((a, x) => a + x.n, 0) || 1;
  let acc = 0;
  const stops = segs.map((x) => { const from = (acc / segTotal) * 360; acc += x.n; return `${x.color} ${from.toFixed(2)}deg ${((acc / segTotal) * 360).toFixed(2)}deg`; }).join(", ");
  const pct = (n) => `${Math.round((n / segTotal) * 100)}%`;
  const distroCard = segs.length ? `
    <div class="card">
      <h2>Week ${scoresWeek} pick distribution</h2>
      <p class="muted small" style="margin:2px 0 10px;">${isCurrent ? `${distroTotal} of ${segTotal} picks revealed so far. A pick lands here the moment its game kicks off; gray is picked but not started, red is no pick yet.` : `${distroTotal} picks.`}</p>
      <div class="pie">
        <div class="donut" style="background:conic-gradient(${stops});" role="img" aria-label="Week ${scoresWeek} pick distribution"><div class="hole"><b>${distroTotal}</b><span>${isCurrent ? "revealed" : "picks"}</span></div></div>
        <div class="legend">
          ${segs.map((x) => `<div class="lrow ${x.hidden ? "hidden" : x.missing ? "missing" : ""}" title="${esc(x.label)}: ${x.n}">
            <span class="sw" style="background:${x.color}"></span>
            ${x.hidden || x.missing ? `<span class="lname">${esc(x.label)}</span>` : `<img src="${logoOf(x.label)}" alt="" loading="lazy"><span class="lname">${abbrOf(x.label).toUpperCase()}${dMark(x.result)}</span>`}
            <span class="lcount">${x.n} <span class="muted">· ${pct(x.n)}</span></span>
          </div>`).join("")}
        </div>
      </div>
    </div>` : "";

  // Riskiest revealed pick: the lowest consensus win probability (SurvivorGrid W%)
  // among teams whose game has kicked off with at least one revealed rider.
  // Hidden picks don't count yet. Spread only breaks ties or fills a missing W%.
  const risk = [];
  for (const [team, list] of Object.entries(ridersByTeam)) {
    const g = games.find((gm) => gm.away.name === team || gm.home.name === team);
    if (!g || !picksRevealed(g, s) || !list.length) continue;
    const tm = g.home.name === team ? g.home : g.away;
    const opp = g.home.name === team ? g.away : g.home;
    const sp = teamSpread(g, tm.abbr);
    const pk = sp?.text === "PK";
    const line = pk ? 0 : sp ? parseFloat(sp.text) : NaN; // "+3.5" getting points, "-3.5" laying them, PK = pick'em
    const score = Number.isFinite(line) ? line : 0;
    const riskText = pk ? "pick'em" : !Number.isFinite(line) ? "no line posted" : line > 0 ? `${line}-point underdog` : line < 0 ? `${Math.abs(line)}-point favorite` : "pick'em";
    const status = g.state === "in" ? `<span class="livepulse"></span>${esc(g.detail || "LIVE")} · ${tm.score ?? 0}-${opp.score ?? 0}` : g.completed ? `Final ${tm.score ?? ""}-${opp.score ?? ""}${list[0].result === "win" ? " · survived ✓" : list[0].result === "loss" ? " · went down ✗" : ""}` : esc(fmtKick(g.date));
    let wp = winProbs[String(tm.abbr || "").toUpperCase()];
    let wpEst = false;
    if (!Number.isFinite(wp) && Number.isFinite(line)) { // no consensus number on record: estimate from the spread
      const z = -line / 13.5; // NFL margins run roughly normal with a 13.5-point spread
      wp = 0.5 * (1 + Math.tanh(z * 0.7978845608 * (1 + 0.044715 * z * z))); // normal CDF approximation
      wpEst = true;
    }
    risk.push({ wpEst, team, tm, opp, homeAway: g.home.name === team ? "vs" : "at", sp, score, riskText, status, done: !!g.completed, wp: Number.isFinite(wp) ? wp : null, list: list.slice().sort((x, y) => x.label.localeCompare(y.label)) });
  }
  // lowest W% first; no W% on record sorts by spread after everything with one
  risk.sort((a, b) => (a.wp ?? 2) - (b.wp ?? 2) || b.score - a.score || b.list.length - a.list.length);
  const top = risk[0];
  const wpText = (x) => x.wp == null ? "—" : `${x.wpEst ? "≈" : ""}${Math.round(x.wp * 100)}%`;
  const WIN_PROB_DEF = "Probability of the team winning this week based on consensus moneyline from the betting market.";
  const riskRow = (x, i) => `<div class="riskrow"><span class="rk">${i + 2}</span><img src="${x.tm.logo || logoOf(x.team)}" alt=""><span class="grow">${esc(x.team)} <span class="muted">${x.homeAway} ${esc(x.opp.name)}</span></span><span class="wpct">${wpText(x)}</span><span class="muted small">${rideLabel(x.list.length, x.done, x.list[0]?.result)}</span></div>`;
  const riskCard = `
    <div class="card">
      <h2>Week ${scoresWeek} riskiest pick</h2>
      ${top ? `
        <div class="riskhero">
          <img src="${top.tm.logo || logoOf(top.team)}" alt="">
          <div class="grow">
            <div class="riskname">${esc(top.team)}</div>
            <div class="muted small">${top.homeAway} ${esc(top.opp.name)} · ${top.status}</div>
          </div>
          <div class="riskcount"><b>${wpText(top)}</b><span>chance to win <span class="infotip" tabindex="0" role="note" aria-label="${WIN_PROB_DEF}" data-tip="${WIN_PROB_DEF}">i</span></span></div>
          <div class="riskcount"><b>${top.list.length}</b><span>${rideWord(top.done, top.list[0]?.result)}</span></div>
        </div>
        <div class="ridenames">${top.list.map((p) => `<span class="ridename ${p.result === "loss" ? "lost" : p.result === "win" ? "won" : ""}">${esc(p.label)}${p.result === "loss" ? " ✗" : p.result === "win" ? " ✓" : ""}</span>`).join("")}</div>
        ${risk.length > 1 ? `<div class="risklist">${risk.slice(1, 4).map(riskRow).join("")}</div>` : ""}`
      : `<p class="muted small">Nothing revealed yet. The first game to kick off lands here.</p>`}
    </div>`;

  if (mySeq !== renderSeq) return; // superseded while loading
  view.innerHTML = `
    <h1 style="text-align:center;margin-bottom:2px;">Scores</h1>
    <p class="muted small" style="text-align:center;margin:0 0 10px;">Live scores, revealed picks, and who got knocked out.</p>
    <div class="weeknav">
      <button class="btn sm" id="wkPrev" ${scoresWeek <= 1 ? "disabled" : ""}>‹</button>
      <span class="wk">Week ${scoresWeek}</span>
      <button class="btn sm" id="wkNext" ${scoresWeek >= 18 ? "disabled" : ""}>›</button>
    </div>
    ${hint("🔥 Picks stay hidden until kickoff. Live scores show the point spread next to each team, and \"riding\" is how many slots picked that team while the game is still open. When it goes final they either survive the week or they are out. Tap 👀 under a game for the names. Tap the line under a game to see it on ESPN.", "scores")}
    ${distroCard}
    ${riskCard}
    ${games.length ? "" : `<div class="card muted">Schedule not posted yet.</div>`}
    ${games.map((g) => {
      const live = g.state === "in";
      const done = g.completed;
      const ovr = (data.overrides || {})[g.id];
      const winName = ovr && ovr !== "TIE" && ovr !== "VOID" ? ovr : (done ? (g.home.winner ? g.home.name : g.away.winner ? g.away.name : null) : null);
      const rowCls = (t) => done ? (winName === t.name ? "winner" : winName ? "loser" : "") : "";
      const rid = (t) => { const l = ridersByTeam[t.name] || []; return l.length ? `<b>${rideLabel(l.length, done, l[0].result)}</b>` : ""; };
      const sp = (t) => {
        const x = teamSpread(g, t.abbr);
        return x && !done ? `<span class="spread ${x.fav ? "fav" : ""}">${x.text}</span>` : "";
      };
      const lineLabel = g.odds?.details ? `${esc(g.odds.details)} · ESPN` : "ESPN";
      return `<div class="card gamecard">
        <div class="teams">
          <div class="trow ${rowCls(g.away)}"><img src="${g.away.logo || logoOf(g.away.name)}" alt=""><span class="tname">${esc(g.away.name)}<span class="ha">away</span></span>${sp(g.away)}${rid(g.away)}<span class="score">${g.state === "pre" ? "" : g.away.score ?? ""}</span></div>
          <div class="trow ${rowCls(g.home)}"><img src="${g.home.logo || logoOf(g.home.name)}" alt=""><span class="tname">${esc(g.home.name)}<span class="ha">home</span></span>${sp(g.home)}${rid(g.home)}<span class="score">${g.state === "pre" ? "" : g.home.score ?? ""}</span></div>
        </div>
        <div class="meta">
          <span>${live ? `<span class="livepulse"></span>${esc(g.detail)}` : done ? "Final" : esc(fmtKick(g.date))}${ovr ? ` · <b>override: ${esc(ovr)}</b>` : ""}</span>
          <a class="linkout" href="${esc(g.link)}" target="_blank" rel="noopener">${lineLabel}</a>
        </div>
        ${(() => {
          if (!picksRevealed(g, s)) return `<div class="riders pre">👀 Who's riding · hidden until kickoff, so nobody can copy a pick.</div>`;
          const groups = [g.away, g.home].map((t) => ({ t, list: (ridersByTeam[t.name] || []).slice().sort((x, y) => x.label.localeCompare(y.label)) }));
          if (!groups.some((x) => x.list.length)) return `<div class="riders">Nobody's riding this one.</div>`;
          return `<details class="ridecell"><summary><span class="rsum">👀 ${done ? "Who rode this game" : "Who's riding this game"} · ${groups.map((x) => `${abbrOf(x.t.name).toUpperCase()} ${x.list.length}${done && x.list.length ? ` ${rideWord(true, x.list[0].result)}` : ""}`).join(" · ")}</span><span class="chev closed-only">View names ▾</span><span class="chev open-only">Hide ▴</span></summary><div class="ridelists">${groups.map((x) => x.list.length ? `<div class="ridegroup"><div class="ridehead"><img src="${x.t.logo || logoOf(x.t.name)}" alt=""><b>${esc(x.t.name)}</b><span class="muted">${x.list.length}</span></div><div class="ridenames">${x.list.map((p) => `<span class="ridename ${p.result === "loss" ? "lost" : p.result === "win" ? "won" : ""}">${esc(p.label)}${p.result === "loss" ? " ✗" : p.result === "win" ? " ✓" : ""}</span>`).join("")}</div></div>` : "").join("")}</div></details>`;
        })()}
      </div>`;
    }).join("")}
    <p class="muted small">${games.some((g) => g.odds) ? `Lines via ${esc(games.find((g) => g.odds).odds.provider)}, as shown on each game's ESPN page. Tap the line to see where the number comes from.` : "Lines appear here once the books post them, straight from each game's ESPN page."}</p>
  `;
  $("#wkPrev")?.addEventListener("click", () => { scoresWeek--; renderScores(); });
  $("#wkNext")?.addEventListener("click", () => { scoresWeek++; renderScores(); });
}

/* ----- picks: one picker card + live slot tiles ----- */
let pickWeek = null;

/* Homework links atop My Picks: pick popularity, spreads, and market odds — all open, no login. */
const RESOURCES = [
  { href: "https://www.survivorgrid.com/", ico: "🧮", label: "SurvivorGrid", tip: "Pick popularity + future value grid, updated all week" },
  { href: "https://sportsbook.draftkings.com/leagues/football/nfl", ico: "👑", label: "DraftKings", tip: "Live spreads, totals, and moneylines" },
  { href: "https://kalshi.com/sports/football/nfl", ico: "📈", label: "Kalshi", tip: "Regulated prediction market: trade yes or no on every game" },
  { href: "https://polymarket.com/sports/nfl", ico: "🪙", label: "Polymarket", tip: "Crypto prediction market: crowd odds on every game" },
  { href: "https://www.reddit.com/r/NFLSurvivor/?screen_view_count=1&ext-referrer=EXTERNAL", ico: "🗣️", label: "r/NFLSurvivor", tip: "Weekly survivor advice threads" },
];
const resourcesHTML = () => `<div class="resrow"><span class="reslabel">Do your homework:</span>${RESOURCES.map((x) =>
  `<a class="reschip" href="${x.href}" target="_blank" rel="noopener" title="${esc(x.tip)}">${x.ico} ${esc(x.label)}</a>`).join("")}</div>`;

/* One slot's season as a horizontal journey line: W1 through now, then the road ahead. */
function journeyLine(r, pickWeek, seasonWeek) {
  let maxW = Math.max(seasonWeek, pickWeek);
  if (r.status === "dead") { // a dead slot's story ends where it ended
    const played = Object.entries(r.weeks || {}).filter(([, rec]) => rec?.team || rec?.note).map(([w]) => Number(w));
    maxW = played.length ? Math.max(...played) : 1;
  }
  const parts = [];
  let w = 1;
  while (w <= maxW) {
    const rec = r.weeks?.[w];
    const isNow = w === pickWeek && r.status !== "dead";
    // Collapse a run of 3+ untouched weeks into one gap node, so planning W16
    // doesn't draw fourteen dashes and shove the current week off-screen.
    if (!rec?.team && !isNow) {
      let j = w;
      while (j + 1 <= maxW && !r.weeks?.[j + 1]?.team && !(j + 1 === pickWeek && r.status !== "dead")) j++;
      if (j - w >= 2) {
        parts.push(`<div class="jn gap" title="Weeks ${w}-${j}: no picks"><span class="jw">W${w}–${j}</span><span class="jb">⋯</span></div>`);
        w = j + 1;
        continue;
      }
    }
    let cls = "jn", body;
    if (rec?.team) {
      cls += rec.result === "win" ? " won" : rec.result === "loss" ? " lost" : " pend";
      body = `<img src="${logoOf(rec.team)}" alt="">`;
    } else {
      cls += " empty";
      body = `<span class="jb">–</span>`;
    }
    if (isNow) cls += " now";
    const title = `Week ${w}${rec?.team ? `: ${rec.team}${rec.result && rec.result !== "pending" ? ` (${rec.result})` : ""}` : ": no pick"}`;
    parts.push(`<div class="${cls}" title="${esc(title)}"><span class="jw">W${w}</span>${body}${rec?.buyback === "confirmed" ? `<span class="jbb">💸</span>` : ""}</div>`);
    w++;
  }
  if (r.status === "dead") parts.push(`<div class="jn deadend" title="Season over"><span class="jw">&nbsp;</span><span class="jb">💀</span></div>`);
  else if (maxW < 18) parts.push(`<div class="jn ghost" title="The road ahead"><span class="jw">W${maxW + 1}</span><span class="jb">…</span></div>`);
  return `<div class="journey">${parts.join(`<span class="jlink"></span>`)}</div>`;
}

/* One slot as a card on My Picks. It folds from its header bar like the
   board's cells: open when the slot needs you (no pick yet, or a loss to buy
   back), folded once the pick is in, and whatever you choose sticks for that
   week. The week's slate still opens INSIDE the card you're picking for. */
const pkKey = (id, w) => `sl_pk_${id}_w${w}`;
function pkOpen(id, w, dflt) {
  try { const v = localStorage.getItem(pkKey(id, w)); return v === null ? dflt : v === "1"; } catch { return dflt; }
}
const LOCK_SVG = `<svg class="pk-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>`;
function pickCardHTML(r, pickWeek, seasonWeek, cfg, { open = false, sched = null, wp = {} } = {}) {
  const cur = r.weeks?.[pickWeek];
  const ws = weekState(r, cur, true);
  const dead = r.status === "dead";
  const avail = Object.entries(r.weeks || {}).filter(([, rec]) => rec?.buyback === "available");
  const pend = Object.entries(r.weeks || {}).filter(([, rec]) => rec?.buyback === "pending");
  // A loss nobody has bought back locks the slot: no slate, no Change, just
  // the Buy back button. The server refuses the pick too; this is the door.
  const blocked = avail.length > 0;
  const canPick = !dead && !cur?.locked && !blocked;
  const canRemove = !dead && !!cur?.team && !cur.locked; // taking a pick back is never gated on a buy-back
  if (!canPick) open = false; // auto-advance can land on a locked slot; nothing to open there
  const expanded = open || pkOpen(r.id, pickWeek, blocked || (canPick && !cur?.team));
  const fee = fmtMoney(cfg.buybackFee);

  // The game this week's pick rides on: the line, the opponent, the kickoff.
  const g = cur?.team ? (sched?.games || []).find((x) => x.home?.name === cur.team || x.away?.name === cur.team) : null;
  const side = g ? (g.home.name === cur.team ? g.home : g.away) : null;
  const opp = g ? (g.home.name === cur.team ? g.away : g.home) : null;
  const sp = g && !cur.locked ? teamSpread(g, side.abbr) : null;
  const pct = side ? wp[String(side.abbr || "").toUpperCase()] : undefined;

  // What the bar shows folded: this week at a glance.
  let barRight = "";
  if (blocked) barRight = `<span class="pk-lock">${LOCK_SVG}Buy back</span>`;
  else if (cur?.team) barRight = `<span class="pk-mini"><img src="${logoOf(cur.team)}" alt="">${esc(abbrOf(cur.team).toUpperCase())}${sp ? `<span class="pk-mini-line">${sp.text}</span>` : ""}${cur.locked ? markFor(cur.result) : ""}</span>`;
  else if (!dead) barRight = `<span class="pk-miss">No pick</span>`;

  const alertHTML = blocked ? (() => {
    const [lw, lrec] = avail[0];
    return `<div class="pk-alert">${LOCK_SVG}<div><b>Lost week ${lw}${lrec?.team ? ` on ${esc(lrec.team)}` : ""}. Picks are locked until you buy back.</b>${r.buybackDeadline ? `<span>Buy back by ${esc(fmtKickTZ(r.buybackDeadline))} or this slot is out.</span>` : ""}</div></div>`;
  })() : "";

  let sel;
  if (cur?.team) {
    const sub = cur.locked
      ? (g?.completed ? `Final ${side?.score ?? ""}-${opp?.score ?? ""}` : g?.state === "in" ? `Live ${side?.score ?? 0}-${opp?.score ?? 0}` : "Locked in")
      : `To win${opp ? ` · ${g.home.name === cur.team ? "vs" : "at"} ${esc(opp.name)}` : ""}`;
    sel = `<div class="pk-sel"><img src="${logoOf(cur.team)}" alt=""><div class="pk-who"><span class="pk-team">${esc(cur.team)}</span><span class="pk-sub">${sub}${cur.source === "auto-default" ? " · auto" : ""}</span></div>${sp || Number.isFinite(pct) ? `<div class="pk-odds">${sp ? `<span class="pk-line">${sp.text}</span>` : ""}${Number.isFinite(pct) ? `<span class="pk-pct">${Math.round(pct * 100)}% to win</span>` : ""}</div>` : ""}</div>`;
  } else if (dead) {
    sel = `<div class="pk-empty">Season over. There's always next year.</div>`;
  } else if (blocked) {
    sel = `<div class="pk-empty">No week ${pickWeek} pick. Buy back, then pick.</div>`;
  } else {
    sel = `<div class="pk-empty">No week ${pickWeek} pick yet.</div>`;
  }
  const meta = g && !cur.locked ? `<div class="pk-meta">${esc(fmtKickTZ(g.date))} · locks at kickoff</div>` : cur?.buyback ? `<div class="pk-meta">${buybackTag(cur)}</div>` : "";

  let acts = "";
  if (blocked) acts = avail.map(([w]) => `<button class="btn sm bbuy" data-buyback="${r.id}" data-loss="${w}">Buy back W${w} · ${fee}</button>`).join("");
  else if (canPick && !open) acts = cur?.team ? `<button class="btn sm" data-openslate="${r.id}">Change</button>` : `<button class="btn sm primary" data-openslate="${r.id}">Pick a team</button>`;
  if (canRemove && !open) acts += `<button class="unpick" data-unpick="${r.id}" title="Remove this pick" aria-label="Remove this pick">✕</button>`;
  const pendNote = pend.map(([w, rec]) => `<div class="pk-note">⏳ Week ${w} buy-back is in. ${cfg.venmo ? `Venmo ${fee} to @${esc(cfg.venmo)}` : `Pay the ${fee}`}${rec.buybackBy ? ` by ${esc(fmtKickTZ(rec.buybackBy))}` : ""}.</div>`).join("");

  return `<details class="jcard pk ${ws.cls} ${dead ? "dead-tile" : ""} ${blocked ? "pk-blocked" : ""} ${open ? "active" : ""}" data-card="${r.id}" data-pk="${r.id}" data-pkw="${pickWeek}" ${expanded ? "open" : ""}>
    <summary class="pk-bar"><span class="pk-name">${esc(r.label)}</span>${r.buybacksUsed ? `<span class="pk-bags">${moneyBags(r.buybacksUsed)}</span>` : ""}${statusBadge(r, pickWeek)}<span class="spacer"></span>${barRight}</summary>
    <div class="pk-body">
      ${open ? `<div class="nowbar">🏈 Picking for ${esc(r.label)} · Week ${pickWeek}</div>` : ""}
      ${alertHTML}
      <div class="pk-eyebrow">Week ${pickWeek} pick</div>
      ${sel}
      ${meta}
      <div class="pk-div"></div>
      <div class="pk-stub">${journeyLine(r, pickWeek, seasonWeek)}${acts ? `<div class="pk-acts">${acts}</div>` : ""}</div>
      ${pendNote}
      ${open && canPick ? slateHTML(r, pickWeek, sched) : ""}
    </div>
  </details>`;
}

/* The buy-back slip: the second yes, as a sheet from the bottom instead of the
   browser's alert box. Shows what they're signing up for (the loss, the fee,
   the pay-by, who to Venmo) before anything is recorded. Resolves true once
   the buy-back is on file, false if they back out. */
function buybackSlip({ label, lossWeek, lossTeam, deadline, cfg, pickWeek, onConfirm }) {
  return new Promise((resolve) => {
    const fee = fmtMoney(cfg.buybackFee);
    const venmo = cfg.venmo ? `Venmo @${esc(cfg.venmo)}` : "";
    const wrap = document.createElement("div");
    wrap.className = "bbslip-wrap";
    wrap.innerHTML = `
      <div class="bbslip-back" data-slipclose></div>
      <div class="bbslip" role="dialog" aria-modal="true" aria-labelledby="bbslipT">
        <span class="bbslip-grab" aria-hidden="true"></span>
        <div class="bbslip-step" data-step="ask">
          <div class="bbslip-eyebrow">Buy-back slip</div>
          <h2 class="bbslip-title" id="bbslipT">${esc(label)}</h2>
          <div class="bbslip-rows">
            <div><span>Loss</span><b>${lossTeam ? `<img src="${logoOf(lossTeam)}" alt="">` : ""}Week ${lossWeek}${lossTeam ? ` · ${esc(lossTeam)}` : ""}</b></div>
            <div><span>Buy-back fee</span><b>${fee}</b></div>
            ${deadline ? `<div><span>Pay by</span><b>${esc(fmtKickTZ(deadline))}</b></div>` : ""}
            ${venmo ? `<div><span>Pay to</span><b>${venmo}</b></div>` : ""}
          </div>
          <p class="bbslip-note">Your week ${lossWeek} loss stays on the record. Your picks unlock the moment you confirm.</p>
          <button class="btn bbslip-go" data-slipgo>Confirm buy-back · ${fee}</button>
          <button class="btn bbslip-no" data-slipclose>Not now</button>
        </div>
        <div class="bbslip-step" data-step="done" hidden>
          <div class="bbslip-ok" aria-hidden="true">✓</div>
          <h2 class="bbslip-title">You're back in</h2>
          <p class="bbslip-note">${esc(label)} can pick again. ${cfg.venmo ? `Venmo ${fee} to @${esc(cfg.venmo)}` : `Pay the ${fee}`}${deadline ? ` by ${esc(fmtKickTZ(deadline))}` : ""}.</p>
          <button class="btn primary bbslip-go" data-slipdone>Pick week ${pickWeek}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const back = document.activeElement;
    let done = false;
    const close = (val) => {
      if (!wrap.isConnected) return;
      wrap.remove();
      document.removeEventListener("keydown", onKey);
      back?.focus?.();
      resolve(val);
    };
    const onKey = (e) => { if (e.key === "Escape") close(done); };
    document.addEventListener("keydown", onKey);
    wrap.addEventListener("click", async (e) => {
      if (e.target.closest("[data-slipclose]")) return close(done);
      if (e.target.closest("[data-slipdone]")) return close(true);
      const go = e.target.closest("[data-slipgo]");
      if (!go || go.disabled) return;
      go.disabled = true;
      try {
        await onConfirm();
        done = true;
        wrap.querySelector('[data-step="ask"]').hidden = true;
        wrap.querySelector('[data-step="done"]').hidden = false;
        wrap.querySelector("[data-slipdone]").focus();
      } catch (err) { toast(err.message); go.disabled = false; }
    });
    wrap.querySelector("[data-slipgo]").focus();
  });
}

/* The week's games as tappable team buttons, scoped to one slot. Burned teams
   stay in the list, grayed and labeled with the week they were spent. */
function slateHTML(r, pickWeek, sched) {
  const games = sched?.games || [];
  if (!games.length) return `<div class="slate"><p class="muted small">Schedule not posted yet.</p></div>`;
  const myPick = r.weeks?.[pickWeek]?.team || null;
  const usedWeek = {};
  for (const [w, rec] of Object.entries(r.weeks || {})) {
    if (rec?.team && Number(w) !== Number(pickWeek)) usedWeek[rec.team] = w;
  }
  const nowMs = Date.now();
  const tb = (g, t) => {
    const kicked = g.state !== "pre" || new Date(g.date).getTime() <= nowMs;
    const uw = usedWeek[t.name];
    const sel = myPick === t.name;
    const dis = (kicked || uw) && !sel;
    const sp = teamSpread(g, t.abbr);
    const why = uw ? `picked W${uw}` : kicked ? "kicked off" : "";
    return `<button class="tb ${sel ? "selected" : ""}" data-pick data-slot="${r.id}" data-team="${esc(t.name)}" ${dis ? "disabled" : ""} ${sel ? "data-selected='1'" : ""} title="${esc(t.name)}${why ? ` · ${why}` : ""}">
      <img src="${t.logo || logoOf(t.name)}" alt=""><span class="tb-abbr">${abbrOf(t.name).toUpperCase()}</span><span class="tb-full">${esc(t.name)}</span>${why ? `<span class="tb-why">${why}</span>` : ""}${sp && !kicked ? `<span class="spread ${sp.fav ? "fav" : ""}">${sp.text}</span>` : ""}${sel ? `<span class="tb-check">✓</span>` : ""}</button>`;
  };
  const burned = (r.usedTeams || []).filter((t) => t !== myPick);
  return `<div class="slate">
    <div class="slatehead"><span>Week ${pickWeek} games · tap a team${myPick ? " to change your pick" : ""}</span><button class="btn sm" data-closeslate="${r.id}">Close</button></div>
    ${games.map((g) => `<div class="srow"><div class="steams">${tb(g, g.away)}<span class="at">@</span>${tb(g, g.home)}</div><div class="skick">${g.completed ? "Final" : esc(g.state === "in" ? g.detail : fmtKick(g.date))}${g.odds?.details ? ` · <a class="linkout" href="${esc(g.link)}" target="_blank" rel="noopener">${esc(g.odds.details)} · ESPN</a>` : ""}</div></div>`).join("")}
    ${burned.length ? `<p class="small muted" style="margin:10px 0 4px;">Teams burned (${burned.length}/32):</p><div style="display:flex;flex-wrap:wrap;gap:4px;">${burned.map((t) => chip(t, "used")).join("")}</div>` : ""}
  </div>`;
}

let openSlate = null;  // slot whose week slate is expanded
let slateAuto = false; // cards start closed; only auto-advance after a pick saves

async function renderPicks() {
  const mySeq = ++renderSeq;
  const st = await loadState();
  const { snapshot: s, cfg } = st;

  if (!session.token) {
    view.innerHTML = loginFormHTML(st.players, cfg, "Log in to make picks");
    bindLoginForm(st.players, renderPicks);
    return;
  }

  const managedSet = managedIdsOf(st.players);
  const pickSlots = (rows) => rows
    .filter((r) => r.playerId === session.playerId || managedSet.has(r.playerId))
    .sort((a, b) => ((a.playerId === session.playerId ? 0 : 1) - (b.playerId === session.playerId ? 0 : 1)) || a.label.localeCompare(b.label));
  const mySlots = pickSlots(s.slots);
  if (!mySlots.length) {
    if (mySeq !== renderSeq) return; // superseded while loading
  view.innerHTML = `<div class="card muted" style="max-width:420px;margin:24px auto;">No slots under your name. Text the commissioner.</div>`;
    return;
  }

  const totalWeeks = cfg.totalWeeks || 18;
  pickWeek = Math.min(Math.max(pickWeek || s.week, s.week), totalWeeks);
  const [sched, wpDoc] = await Promise.all([loadScores(pickWeek), loadWinProb(pickWeek)]);
  const wp = wpDoc?.probs || {};
  const mustBuyBack = (r) => Object.values(r.weeks || {}).some((x) => x?.buyback === "available");
  const needsPick = (r) => r.status !== "dead" && !r.weeks?.[pickWeek]?.team && !mustBuyBack(r);
  if (openSlate && !mySlots.some((r) => r.id === openSlate)) openSlate = null;
  if (!openSlate && slateAuto) openSlate = mySlots.find(needsPick)?.id || null;

  const cards = mySlots.map((r) => pickCardHTML(r, pickWeek, s.week, cfg, { open: r.id === openSlate, sched, wp })).join("");
  const allIn = mySlots.filter((r) => r.status !== "dead").every((r) => r.weeks?.[pickWeek]?.team);
  const planNext = allIn && pickWeek < totalWeeks ? `<button class="btn sm" id="pkPlanNext">Plan week ${pickWeek + 1} →</button>` : "";

  view.innerHTML = `
    <h1 style="margin-bottom:12px;">My picks</h1>
    ${hint(`🙈 Picks stay hidden from the league until each game kicks off. Every card is one slot's season: tap its bar to fold it or open it. Tap Pick a team for the week's games; if another slot still needs a pick, it opens next. Teams you've burned stay in the list, grayed, with the week you used them.`, "picks")}
    ${resourcesHTML()}
    ${owedNoteHTML(st.owed, cfg, (id) => (mySlots.length > 1 ? mySlots.find((r) => r.id === id)?.label : ""))}
    <div class="jlist onecol">
      <div class="weeknav" style="margin:0;">
        <button class="btn sm" id="pkPrev" ${pickWeek <= s.week ? "disabled" : ""}>‹</button>
        <span class="wk">Week ${pickWeek}${allIn ? ` <span class="mark win">✓</span>` : ""}</span>
        <button class="btn sm" id="pkNext" ${pickWeek >= totalWeeks ? "disabled" : ""}>›</button>
        ${planNext}
      </div>
      ${cards}
    </div>
  `;

  const scrollToOpen = () => { if (openSlate) document.querySelector(`[data-card="${openSlate}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }); };
  $$("[data-openslate]").forEach((b) => b.addEventListener("click", () => {
    openSlate = b.dataset.openslate; slateAuto = true;
    renderPicks().then(scrollToOpen);
  }));
  $$("[data-closeslate]").forEach((b) => b.addEventListener("click", () => { openSlate = null; slateAuto = false; renderPicks(); }));
  // Folding a card from its bar sticks for that slot and week; folding the one
  // you're picking in also puts its slate away.
  $$("details[data-pk]").forEach((d) => d.addEventListener("toggle", () => {
    try { localStorage.setItem(pkKey(d.dataset.pk, d.dataset.pkw), d.open ? "1" : "0"); } catch {}
    if (!d.open && openSlate === d.dataset.pk) { openSlate = null; slateAuto = false; }
  }));
  if (!window.__slateAway) { // tap anywhere outside the open card to fold it (registered once)
    window.__slateAway = true;
    document.addEventListener("click", (e) => {
      if (currentRoute() !== "picks" || !openSlate) return;
      if (e.target.closest(`[data-card="${openSlate}"]`)) return;
      if (e.target.closest("button, a, select, input, textarea, summary, .weeknav, #toast, .verbar, .bbslip-wrap")) return;
      openSlate = null; slateAuto = false; renderPicks();
    });
  }
  $$("[data-pick]").forEach((b) => b.addEventListener("click", async () => {
    if (b.dataset.selected) return;
    const team = b.dataset.team, slotId = b.dataset.slot;
    b.disabled = true;
    try {
      await api("/api/pick", { token: session.token, slotId, week: pickWeek, team });
      toast(`Locked in ${team} for week ${pickWeek} ✓`);
      await loadState(true);
      const next = pickSlots(DB.state.snapshot.slots).find((r) => r.id !== slotId && needsPick(r));
      openSlate = next ? next.id : null; slateAuto = !!next;
      renderPicks().then(scrollToOpen);
    } catch (err) {
      toast(err.message);
      // A slate opened before a loss went final: redraw, and the card shows its Buy back button.
      if (err.status === 422) { await loadState(true); renderPicks(); } else b.disabled = false;
    }
  }));
  const changeWeek = (delta) => { pickWeek += delta; openSlate = null; slateAuto = false; renderPicks(); };
  $("#pkPrev")?.addEventListener("click", () => changeWeek(-1));
  $("#pkNext")?.addEventListener("click", () => changeWeek(1));
  $("#pkPlanNext")?.addEventListener("click", () => changeWeek(1));
  $$("[data-unpick]").forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    const row = mySlots.find((r) => r.id === b.dataset.unpick);
    const team = row?.weeks[pickWeek]?.team || "this pick";
    if (!confirm(`Remove ${team} for week ${pickWeek}? The week goes back to empty until you pick again.`)) return;
    b.disabled = true;
    try {
      await api("/api/unpick", { token: session.token, slotId: b.dataset.unpick, week: pickWeek });
      toast(`Removed. Week ${pickWeek} is open again.`);
      openSlate = b.dataset.unpick; slateAuto = true;
      await loadState(true); renderPicks();
    } catch (err) { toast(err.message); b.disabled = false; }
  }));
  $$("[data-buyback]").forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    // The second yes: buying back costs money, so it never happens on a stray tap.
    const slotId = b.dataset.buyback, w = Number(b.dataset.loss);
    const row = mySlots.find((r) => r.id === slotId);
    const locked = !!row?.weeks?.[pickWeek]?.locked; // this week's game already went: the next pick is next week's
    const target = locked ? Math.min(pickWeek + 1, totalWeeks) : pickWeek;
    const ok = await buybackSlip({
      label: row?.label || "this slot", lossWeek: w, lossTeam: row?.weeks?.[w]?.team,
      deadline: row?.weeks?.[w]?.buybackBy || row?.buybackDeadline, cfg, pickWeek: target,
      onConfirm: () => api("/api/buyback", { token: session.token, slotId, lossWeek: w }),
    });
    if (!ok) return;
    pickWeek = target;
    openSlate = slotId; slateAuto = true; // straight to the pick they bought back for
    await loadState(true); renderPicks().then(scrollToOpen);
  }));
}

async function renderMoney() {
  const st = await loadState();
  const { snapshot: s, cfg } = st;
  view.innerHTML = `
    <h1>The pot</h1>
    ${hint("💸 Everything runs through Venmo. Pay your buy-in there and the commissioner marks it received.", "money")}
    ${owedNoteHTML(st.owed, cfg)}
    <div class="card potcard">
      <div class="k">The pot</div>
      <div class="bigpot">${fmtMoney(s.pot.total)}</div>
      <p class="muted small" style="margin:0 0 14px;">${s.pot.entries} entr${s.pot.entries === 1 ? "y" : "ies"} × ${fmtMoney(cfg.buyIn)}${s.pot.buybackCash ? ` + ${fmtMoney(s.pot.buybackCash)} in buy-backs` : ""}</p>
      ${cfg.venmo ? `<a class="btn primary" target="_blank" rel="noopener" href="https://venmo.com/u/${encodeURIComponent(cfg.venmo)}">Pay @${esc(cfg.venmo)} on Venmo</a>` : ""}
      ${payArrangementsNote(cfg)}
      <p class="muted small" style="margin:14px 0 0;">Winner takes all. Multiple survivors at the end of week 18 split the pot.</p>
    </div>
    ${session.adminToken ? `<p class="muted small">Commissioner: the who's-paid ledger lives in <a href="#/admin">your desk</a>.</p>` : ""}
  `;
}

const LOG_ICONS = { pick: "✍️", "pick-change": "🔁", "auto-default": "🤖", join: "👋", "buyback-request": "💸", "buyback-confirmed": "✅", "buyback-denied": "🚫", "buyback-granted": "💸", "buyback-undone": "↩️", payment: "💰", "payment-voided": "↩️", "result-override": "🧑‍⚖️", config: "⚙️", bootstrap: "🏁", "pin-reset": "🔑", "pin-changed": "🔑", "slot-added": "➕", "slot-removed": "➖", renameSlot: "✏️", withdrawSlot: "🚪", restoreSlot: "↩️", "pick-cleared": "🧹", "pick-removed": "🧹", "contact-updated": "📇", "name-changed": "✏️", "player-removed": "🗑️", "reminders-sent": "📨" };
function logText(e) {
  const who = e.slotLabel ? `<b>${esc(e.slotLabel)}</b>` : e.actor && e.actor !== "commissioner" && e.actor !== "system" ? `<b>${esc(e.actor)}</b>` : "";
  switch (e.action) {
    case "pick": return `${who} picked <b>${esc(e.after)}</b> for week ${e.week}`;
    case "pick-change": return `${who} changed week ${e.week}: ${esc(e.before)} → <b>${esc(e.after)}</b>`;
    case "auto-default": return `${who} was auto-granted <b>${esc(e.after)}</b> for week ${e.week} (default pick)`;
    case "pick-removed": return `${who} removed <b>${esc(e.before)}</b> for week ${e.week}`;
    default: return `${who ? who + " · " : ""}${esc(e.note || e.action)}`;
  }
}
async function renderLog() {
  const tok = session.adminToken || session.token;
  if (!tok) {
    const st = await loadState();
    view.innerHTML = `
      <h1>Activity</h1>
      ${hint("🔒 Your activity is private to you. Log in to see your own picks, changes, and buy-backs.")}
      ${loginFormHTML(st.players, st.cfg, "Log in to see your activity")}`;
    bindLoginForm(st.players, renderLog);
    return;
  }
  const isAll = Boolean(session.adminToken);
  const st = await loadState();
  view.innerHTML = `<h1>${isAll ? "All activity" : "Your activity"}</h1>
    ${hint(isAll ? "🧑‍⚖️ Commissioner view: every action in the league, timestamped. Pick a name to follow one person all the way back." : "🔒 Everything you've done, timestamped. Only you and the commissioner can see this.")}
    <div id="logFeed"></div>`;
  mountLogFeed($("#logFeed"), { tok, canFilter: isAll, players: st.players, card: true });
}

/* The activity feed, wherever it appears: the log page and the desk both use
   this. Paging keeps the history whole, since the server hands back a cursor
   whenever there is more behind the page, however far back it had to reach. */
function mountLogFeed(host, { tok, canFilter, players = [], card = false, limit = 100 }) {
  if (!host) return;
  const pick = canFilter
    ? `<div class="weeknav" style="margin:0 0 10px;"><select data-logwho><option value="">Everyone</option>${players.slice().sort((a, b) => a.name.localeCompare(b.name)).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select></div>`
    : "";
  host.innerHTML = `${pick}<div class="${card ? "card" : ""}" data-loglist><div class="loading">Loading…</div></div>`;
  const list = host.querySelector("[data-loglist]");
  const row = (e) => `<div class="logrow"><span class="ico">${LOG_ICONS[e.action] || "•"}</span><span>${logText(e)}${e.actor === "commissioner" ? ` <span class="muted small">(commissioner)</span>` : ""}</span><span class="when">${fmtStamp(e.ts)}</span></div>`;
  let cursor = null, who = "";
  const load = async (append) => {
    if (!append) { list.innerHTML = `<div class="loading">Loading…</div>`; cursor = null; }
    try {
      const { entries, nextCursor } = await api(`/api/log?limit=${limit}&token=${encodeURIComponent(tok)}${who ? `&player=${encodeURIComponent(who)}` : ""}${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`);
      cursor = nextCursor || null;
      const rows = entries.map(row).join("");
      const more = cursor ? `<div class="t-cta"><button class="btn sm" data-logmore>Show older</button></div>` : "";
      if (append) {
        list.querySelector("[data-logmore]")?.closest(".t-cta")?.remove();
        list.insertAdjacentHTML("beforeend", rows + more);
      } else {
        list.innerHTML = entries.length ? rows + more : `<p class="muted small">Nothing yet.</p>`;
      }
      list.querySelector("[data-logmore]")?.addEventListener("click", () => load(true), { once: true });
    } catch (e) {
      if (!append) list.innerHTML = `<p class="muted small">${esc(e.message)}</p>`;
      else toast(e.message);
    }
  };
  host.querySelector("[data-logwho]")?.addEventListener("change", (e) => { who = e.target.value; load(false); });
  load(false);
}

async function renderRules() {
  const { cfg } = await loadState();
  // The rules live as plain text in league settings; dress the structure the
  // commissioner already writes: CAPS lines become section headers, "N." lines
  // become numbered rows, everything else stays a paragraph.
  const paras = (cfg.rulesText || "").split("\n").map((raw) => {
    const l = raw.trim();
    if (!l) return "";
    if (/^[A-Z0-9 &'/-]{3,42}$/.test(l) && !/^\d/.test(l)) return `<h3 class="rules-h">${esc(l)}</h3>`;
    const m = l.match(/^(\d+)\.\s*(.*)$/);
    if (m) return `<div class="rule-row"><span class="rule-n">${m[1]}</span><span>${esc(m[2])}</span></div>`;
    return `<p class="rules-p">${esc(l)}</p>`;
  }).join("");
  view.innerHTML = `
    <h1>Rules</h1>
    <div class="card rules-text">${paras || "<p class='muted'>Rules coming soon.</p>"}</div>
    <div class="card">
      <h2>Legend</h2>
      <div class="timeline" style="border:0;padding:0;">
        <div class="trow"><span class="badge alive">Safe</span><span class="small muted">this week's pick won. Nothing can take you out this week</span></div>
        <div class="trow"><span class="badge vuln">Vulnerable</span><span class="small muted">still in it, but this week isn't won yet (no pick, not kicked off, or live)</span></div>
        <div class="trow"><span class="badge limbo">In limbo</span><span class="small muted">lost in weeks 1–3 and not settled: not bought back yet (window still open), or bought back and waiting on the commissioner to confirm the money</span></div>
        <div class="trow"><span class="badge dead">💀 Out</span><span class="small muted">season over</span></div>
        <div class="trow"><span>💸</span><span class="small muted">one buy-back used ($${esc(String(cfg.buybackFee))} each)</span></div>
        <div class="trow"><span class="mark win">✓</span><span class="small muted">correct pick (ties count as wins)</span></div>
        <div class="trow"><span class="mark loss">✗</span><span class="bbtag ok">💸 bought back</span><span class="small muted">lost that week, paid the mulligan, still alive</span></div>
        <div class="trow"><span>★</span><span class="small muted">your favorites (tap the star on Who's left; saved on this device)</span></div>
        <div class="trow">${mysteryChip()}<span class="small muted">someone's pick, scrambled until their game kicks off</span></div>
        <div class="trow"><span class="spread fav">-3.5</span><span class="small muted">point spread, straight from the game's ESPN page (favorite in blue)</span></div>
      </div>
    </div>
    ${(cfg.contacts || []).length ? `<div class="card"><h2>Questions?</h2>${cfg.contacts.map((c) => `<div class="contactrow"><b>${esc(c.name)}</b><span class="spacer"></span>${contactBtns(c)}</div>`).join("")}</div>` : ""}
  `;
}

/* The ceremonial oval from the brand kit: tribal-council badge for the
   Hall of Fame (and, per the kit, apparel and share cards). */
const hofBadge = (leagueName) => {
  const name = String(leagueName || "Survivor League").toUpperCase();
  const fit = name.length > 20 ? ' textLength="196" lengthAdjust="spacingAndGlyphs"' : "";
  return `
<svg class="hof-badge" viewBox="0 0 400 260" role="img" aria-label="${esc(leagueName || "Survivor League")}: Outwit, Outpick, Outlast">
  <ellipse cx="200" cy="130" rx="198" ry="128" fill="#001E3C"/>
  <ellipse cx="200" cy="130" rx="186" ry="116" fill="none" stroke="#FFB612" stroke-width="5"/>
  <path id="hof-arc-top" d="M 62 130 A 138 76 0 0 1 338 130" fill="none"/>
  <path id="hof-arc-bottom" d="M 50 130 A 150 92 0 0 0 350 130" fill="none"/>
  <g transform="translate(152 52) scale(0.96)">
    <circle cx="50" cy="50" r="50" fill="#001E3C"/>
    <circle cx="50" cy="50" r="45" fill="none" stroke="#0077F7" stroke-width="3.5"/>
    <g stroke="#FFB612" stroke-width="6.5" stroke-linecap="square" fill="none">
      <path d="M21 66 H79"/><path d="M23.5 66 V29"/><path d="M76.5 66 V29"/><path d="M50 66 V85"/>
    </g>
    <g transform="translate(50 67) scale(0.74) translate(-50 -78)">
      <path fill="#D50A0A" d="M50 8 C62 26 74 34 74 52 C74 68 63 78 50 78 C37 78 26 68 26 52 C26 40 33 36 38 30 C40 40 45 44 48 46 C46 34 47 18 50 8 Z"/>
      <path fill="#fff" d="M50 35 C57 45 62 50 62 58 C62 68 56 74 50 74 C44 74 38 68 38 58 C38 51 44 45 50 35 Z"/>
    </g>
  </g>
  <rect x="97" y="157" width="206" height="28" rx="3" fill="#FFB612"/>
  <text x="200" y="177.5" text-anchor="middle" font-family="Barlow Condensed, sans-serif" font-weight="800" font-size="19.5" letter-spacing="1.2" fill="#001E3C"${fit}>${esc(name)}</text>
  <text font-family="Barlow Condensed, sans-serif" font-weight="800" font-size="27" letter-spacing="3.5" fill="#FFFFFF"><textPath href="#hof-arc-top" startOffset="50%" text-anchor="middle">OUTWIT · OUTPICK</textPath></text>
  <text font-family="Barlow Condensed, sans-serif" font-weight="800" font-size="26" letter-spacing="6.5" fill="#FFFFFF"><textPath href="#hof-arc-bottom" startOffset="50%" text-anchor="middle">OUTLAST</textPath></text>
</svg>`;
};

async function renderHof() {
  const { cfg } = await loadState();
  const hof = (cfg.hallOfFame || []).slice().sort((a, b) => b.year - a.year);
  const titles = {};
  hof.forEach((h) => (h.champions || []).forEach((n) => (titles[n] = titles[n] || []).push(h.year)));
  const repeats = Object.entries(titles).filter(([, ys]) => ys.length > 1)
    .sort((a, b) => b[1].length - a[1].length || Math.max(...b[1]) - Math.max(...a[1]));
  const reigning = hof[0];
  view.innerHTML = `
    ${hofBadge(cfg.leagueName)}
    <h1 style="text-align:center;">Hall of Fame</h1>
    ${reigning ? `<div class="card reigncard">
      <div class="reign-k">👑 Reigning champion${(reigning.champions || []).length > 1 ? "s" : ""} · ${reigning.year}</div>
      <div class="reign-names">${(reigning.champions || []).map(esc).join(" · ")}</div>
      <p class="muted small" style="margin:6px 0 0;">${reigning.note ? esc(reigning.note) + " · " : ""}Defending the crown in ${reigning.year + 1}.</p>
    </div>` : ""}
    ${repeats.length ? `<div class="card">
      <h2>Repeat champions</h2>
      ${repeats.map(([n, ys]) => `<div class="hofrow"><span class="yr rings" title="${ys.length} titles">${"💍".repeat(Math.min(ys.length, 5))}</span><span class="names">${esc(n)}</span><span class="wk">${ys.length} titles · ${ys.slice().sort().join(", ")}</span></div>`).join("")}
    </div>` : ""}
    <div class="card">
      <h2>Season by season</h2>
      ${hof.map((h) => `<div class="hofrow"><span class="yr">${h.year}</span><span class="names">${(h.champions || []).map((n) => `${esc(n)}${(h.flawless || []).includes(n) ? ` <span class="badge flaw" title="Won it all without ever buying back">💯 Flawless</span>` : ""}`).join(", ")}</span><span class="wk">${esc(h.note || "")}</span></div>`).join("") || `<p class="muted">History loading…</p>`}
    </div>
    <p class="muted small">${cfg.established ? `Champions since ${esc(String(cfg.established))}. ` : ""}Multiple names in one year split that season's pot. 💯 Flawless = went the distance without a single buy-back.</p>
  `;
}

/* Note atop Join and Log in. The commissioner's text wins; while it's blank and
   sign-ups are open, an automatic line names this week's real last kickoff. */
/* Sign-ups end at kickoff of week 1's last game; the server enforces it, this mirrors it. */
async function joinDeadline() {
  try {
    const sc = await loadScores(1);
    const last = (sc.games || []).slice().sort((x, y) => new Date(x.date) - new Date(y.date)).pop();
    return last ? { at: last.date, passed: last.state !== "pre" || last.completed || new Date() >= new Date(last.date) } : null;
  } catch { return null; }
}
async function signupNoteHTML(st) {
  const { cfg } = st;
  if (cfg.joinNote) return `<div class="banner">📣 ${esc(cfg.joinNote).replace(/\n/g, "<br>")}</div>`;
  if (!cfg.joinOpen) return "";
  const dl = await joinDeadline();
  if (dl && !dl.passed) return `<div class="banner">📣 <b>Still time to sign up.</b> Entries stay open until Week 1's last game kicks off: <b>${esc(fmtKickTZ(dl.at))}</b>.</div>`;
  return "";
}
async function renderJoin() {
  const st = await loadState();
  const { cfg } = st;
  const note = await signupNoteHTML(st);
  const dl = cfg.joinOpen ? await joinDeadline() : null;
  if (!cfg.joinOpen || dl?.passed) {
    view.innerHTML = `<div class="card" style="max-width:420px;margin:24px auto;">${note}<h2>Sign-ups are closed</h2><p class="muted">${dl?.passed ? "Entries closed when Week 1's last game kicked off." : ""} Still want in? ${commishTextLink(cfg)}.</p></div>`;
    return;
  }
  view.innerHTML = `
    <div class="card" style="max-width:460px;margin:24px auto;">
      ${note}
      <h2>Join the ${esc(String(cfg.seasonYear))} season</h2>
      <p class="muted small">${fmtMoney(cfg.buyIn)} per slot, up to ${cfg.maxSlotsPerPlayer} slots. Each slot plays its own season.</p>
      <label class="field"><span>Full name</span><input id="jName" placeholder="First Last" autocomplete="name"></label>
      <label class="field"><span>Choose a PIN <span class="muted">(4–8 digits, you'll log in with it)</span></span><input id="jPin" inputmode="numeric" placeholder="e.g. 4 digits you'll remember"></label>
      <label class="field"><span>Email <span class="muted">(required, for reminders)</span></span><input id="jEmail" type="email" required autocomplete="email" inputmode="email" placeholder="you@example.com"></label>
      <label class="field"><span>Phone <span class="muted">(optional)</span></span><input id="jPhone" type="tel" autocomplete="tel" placeholder="(555) 555-1234"></label>
      <label class="field"><span>How many slots for you?</span><select id="jSlots">${Array.from({ length: cfg.maxSlotsPerPlayer || 3 }, (_, i) => `<option value="${i + 1}">${i + 1} slot${i ? "s" : ""} · ${fmtMoney((i + 1) * cfg.buyIn)}</option>`).join("")}</select></label>
      <div class="section-h" style="margin:16px 0 6px;"><h3 style="margin:0;">Family you manage</h3><div class="line"></div></div>
      <p class="muted small">Optional. They get their own slots, show up on your My Picks so you can pick for them, and the whole household logs in with the one PIN you chose above.</p>
      <div id="jMembers"></div>
      <button class="btn sm" id="jAddMember" type="button">+ Add a family member</button>
      <button class="btn primary block" id="jGo" style="margin-top:14px;">Join the league</button>
      <p class="muted small" style="margin-top:12px;">Already signed up? <a href="#/login">Log in</a> · You'll stay logged in on this device after joining.</p>
    </div>`;
  const addMemberRow = () => {
    const row = document.createElement("div");
    row.className = "admin-row";
    row.style.border = "0";
    row.innerHTML = `<input class="jmName" placeholder="Member's full name" style="flex:2;min-width:120px;">
      <select class="jmSlots" style="flex:1;min-width:88px;">${Array.from({ length: cfg.maxSlotsPerPlayer || 3 }, (_, i) => `<option value="${i + 1}">${i + 1} slot${i ? "s" : ""}</option>`).join("")}</select>
      <button class="btn sm danger jmDel" type="button">✕</button>`;
    row.querySelector(".jmDel").addEventListener("click", () => row.remove());
    $("#jMembers").appendChild(row);
  };
  $("#jAddMember").addEventListener("click", addMemberRow);
  $("#jGo").addEventListener("click", async () => {
    const name = $("#jName").value.trim();
    const pin = $("#jPin").value.trim();
    if (name.length < 2) return toast("Enter your name");
    if (!/^\d{4,8}$/.test(pin)) return toast("PIN must be 4 to 8 digits");
    const members = $$("#jMembers .admin-row").map((row) => ({
      name: row.querySelector(".jmName").value.trim(),
      slots: Number(row.querySelector(".jmSlots").value),
    })).filter((m) => m.name.length >= 2);
    const email = $("#jEmail").value.trim().toLowerCase();
    if (!email) { toast("Email required. It's how reminders reach you."); return $("#jEmail").focus(); }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { toast("That email doesn't look right. Check it and try again."); return $("#jEmail").focus(); }
    $("#jGo").disabled = true;
    try {
      const r = await api("/api/join", { name, pin, email, phone: $("#jPhone").value.trim(), slots: Number($("#jSlots").value) });
      session.login(r.token, r.playerId, r.name);
      renderSession();
      const added = [], troubled = [];
      for (const m of members) {
        try { added.push(await api("/api/household", { token: r.token, name: m.name, slots: m.slots })); }
        catch (e2) { troubled.push(`${m.name}: ${e2.message}`); }
      }
      const allLabels = [...r.slots.map((s2) => s2.label), ...added.flatMap((hm) => hm.slots.map((s2) => s2.label))];
      view.innerHTML = `
        <div class="card" style="max-width:460px;margin:24px auto;text-align:center;">
          <h2>You're in, ${esc(r.name)} 🎉</h2>
          ${added.length ? `<p class="small">And so ${added.length === 1 ? "is" : "are"} <b>${added.map((a) => esc(a.name)).join(", ")}</b>.</p>` : ""}
          <p class="muted">Your whole household logs in with <b>any of your names + the one PIN you just chose</b>.</p>
          <p class="small muted">Slots (${allLabels.length}): ${allLabels.map(esc).join(", ")}</p>
          ${troubled.length ? `<div class="banner">⚠ Couldn't add ${troubled.map(esc).join("; ")}</div>` : ""}
          ${cfg.venmo ? `<a class="btn primary block" target="_blank" rel="noopener" href="https://venmo.com/u/${encodeURIComponent(cfg.venmo)}">Pay your buy-in · ${fmtMoney(allLabels.length * cfg.buyIn)} · Venmo ${esc(cfg.venmo)}</a>` : ""}
          <a class="btn block" style="margin-top:8px;" href="#/picks">Skip, and make week 1 picks →</a>
          ${payArrangementsNote(cfg)}
        </div>`;
      loadState(true);
    } catch (e) { toast(e.message); $("#jGo").disabled = false; }
  });
}

async function renderLogin() {
  const st = await loadState();
  if (session.token) { location.hash = "#/account"; return; }
  const note = await signupNoteHTML(st);
  view.innerHTML = (note ? `<div style="max-width:460px;margin:24px auto -10px;">${note}</div>` : "") + loginFormHTML(st.players, st.cfg);
  bindLoginForm(st.players, () => { location.hash = "#/" + (returnAfterLogin || "picks"); });
}

async function renderAccount() {
  if (!session.token) { location.hash = "#/login"; return; }
  const st = await loadState();
  const { snapshot: s, cfg } = st;
  const mySlots = s.slots.filter((r) => r.playerId === session.playerId);
  const members = st.players.filter((p) => p.managedBy === session.playerId);
  const memberSlots = (pid) => s.slots.filter((r) => r.playerId === pid);
  view.innerHTML = `
    <h1>Account settings</h1>
    <div class="card" style="max-width:460px;">
      <div style="display:flex;align-items:center;gap:10px;">
        <h2 style="margin:0;flex:1;">${esc(session.name)}</h2>
        <button class="btn sm" id="editName">✏️ Edit name</button>
      </div>
      ${mySlots.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 4px;">${mySlots.map((r) => `<span class="chip">${esc(r.label)} ${r.status === "dead" ? "💀" : "✓"}</span>`).join("")}</div>` : ""}
      <p class="small muted" style="margin-top:8px;"><a href="#/picks">Go to my picks →</a></p>
    </div>
    <div class="card" style="max-width:460px;">
      <h3>Contact info</h3>
      <p class="muted small" style="margin:0 0 4px;">For league reminders. Only you and the commissioner can see these.</p>
      <div class="admin-row"><span class="grow small">📧 <span id="cEmailVal" class="muted">loading…</span></span><button class="btn sm" id="cEmailBtn">Edit</button></div>
      <div class="admin-row" style="border-bottom:0;"><span class="grow small">📱 <span id="cPhoneVal" class="muted">loading…</span></span><button class="btn sm" id="cPhoneBtn">Edit</button></div>
      <h3 style="margin:14px 0 4px;">Reminders</h3>
      <p class="muted small" style="margin:0 0 6px;">Thursdays with your picks, plus Mondays if a slot still needs one.</p>
      <label class="small" style="display:flex;align-items:center;gap:8px;margin:6px 0 0;cursor:pointer;"><input type="checkbox" id="remEmail" checked style="width:auto;margin:0;"> Email reminders</label>
      <label class="small" style="display:flex;align-items:center;gap:8px;margin:6px 0 0;cursor:pointer;"><input type="checkbox" id="remSms" style="width:auto;margin:0;"> Text reminders <span class="muted">(coming soon; needs your phone above)</span></label>
      <p class="small" style="margin:10px 0 0;"><button class="btn sm" id="remPreview">Preview my reminder email</button></p>
    </div>
    <div class="card" style="max-width:460px;">
      <h3>Household</h3>
      <p class="muted small">Add family members you manage. Their slots show up on your My Picks so you can pick for them, and the whole household logs in with your one PIN. Up to ${cfg.maxSlotsPerPlayer} slots each, ${fmtMoney(cfg.buyIn)} a slot.</p>
      ${members.map((m) => `<div class="admin-row"><span class="grow">${esc(m.name)}</span><span class="muted small">${memberSlots(m.id).map((r) => `${esc(r.label)} ${r.status === "dead" ? "💀" : "✓"}`).join(" · ") || "no slots"}</span><button class="btn sm" data-rnmember="${m.id}" data-rnname="${esc(m.name)}">Rename</button><button class="btn sm" data-ctmember="${m.id}" data-ctname="${esc(m.name)}">Contact</button></div>`).join("")}
      <div id="hhResult"></div>
      ${cfg.joinOpen ? `
      <div class="admin-row" style="border:0;">
        <input id="hhName" placeholder="Member's full name" style="flex:2;min-width:130px;">
        <select id="hhSlots" style="flex:1;min-width:90px;">${Array.from({ length: cfg.maxSlotsPerPlayer || 3 }, (_, i) => `<option value="${i + 1}">${i + 1} slot${i ? "s" : ""}</option>`).join("")}</select>
        <button class="btn sm primary" id="hhGo">Add</button>
      </div>` : `<p class="muted small">Sign-ups are closed; ask the commissioner to add members.</p>`}
    </div>
    <div class="card" style="max-width:460px;">
      <h3>Change PIN</h3>
      <label class="field"><span>New PIN (4–8 digits)</span><input id="npin" inputmode="numeric" placeholder="New PIN"></label>
      <button class="btn" id="npinGo">Update PIN</button>
    </div>
    <div class="card" style="max-width:460px;">
      <h3>Commissioner</h3>
      ${session.adminToken
        ? `<p class="small" style="margin:0 0 10px;"><a href="#/admin">Open the commissioner desk →</a></p><button class="btn sm" id="admOut">End commissioner session</button>`
        : `<p class="small muted" style="margin:0;">Run the league? <a href="#/admin">Log in to the desk</a> with the admin PIN. Your player login stays active alongside it.</p>`}
    </div>
    <div class="card" style="max-width:460px;">
      <h3>Need something else changed?</h3>
      <p class="small muted" style="margin:0 0 10px;">Slots, payments, a locked pick, a buy-back: if you can't change it on this page, text the commissioner and they'll fix it at the desk.</p>
      ${(cfg.contacts || []).map((c) => `<div class="contactrow"><b>${esc(String(c.name || "").split(" ")[0])}</b><span class="spacer"></span>${contactBtns(c)}</div>`).join("")}
    </div>
    <div class="card" style="max-width:460px;">
      <button class="btn danger" id="acctOut">Log out</button>
      <p class="ver" style="margin:10px 0 0;">App build v${APP_BUILD}. Something look stale? Pull to refresh.</p>
    </div>
  `;
  const doRename = async (memberId, currentName) => {
    const name = prompt(`New name for ${currentName}:`, currentName);
    if (name === null) return;
    if (name.trim().length < 2) return toast("Name must be at least 2 characters");
    try {
      const r = await api("/api/setname", { token: session.token, name: name.trim(), ...(memberId ? { memberId } : {}) });
      if (!memberId) {
        localStorage.setItem("sl_name", r.name);
        localStorage.setItem("sl_lastName", r.name);
      }
      toast(`Renamed to ${r.name} ✓`);
      DB.state = null;
      renderSession();
      renderAccount();
    } catch (e) { toast(e.message); }
  };
  $("#editName").addEventListener("click", () => doRename(null, session.name));
  $$("[data-rnmember]").forEach((b) => b.addEventListener("click", () => doRename(b.dataset.rnmember, b.dataset.rnname)));
  const myContact = { email: "", phone: "", emailReminders: true, smsReminders: false };
  const fillContact = (c) => {
    myContact.email = c.email || ""; myContact.phone = c.phone || "";
    myContact.emailReminders = c.emailReminders !== false; myContact.smsReminders = c.smsReminders === true;
    const em = $("#remEmail"), sm = $("#remSms");
    if (em) em.checked = myContact.emailReminders;
    if (sm) sm.checked = myContact.smsReminders;
    const pairs = [["#cEmailVal", "#cEmailBtn", myContact.email, "no email yet"], ["#cPhoneVal", "#cPhoneBtn", myContact.phone, "no phone yet"]];
    for (const [valSel, btnSel, val, emptyText] of pairs) {
      const v = $(valSel), btn = $(btnSel);
      if (v) { v.textContent = val || emptyText; v.classList.toggle("muted", !val); }
      if (btn) btn.textContent = val ? "Edit" : "Add";
    }
  };
  api("/api/setcontact", { token: session.token }).then(fillContact).catch(() => {
    const e = $("#cEmailVal"), p = $("#cPhoneVal");
    if (e) e.textContent = "couldn't load";
    if (p) p.textContent = "couldn't load";
  });
  const editContact = async (field) => {
    const label = field === "email" ? "email address" : "phone number";
    const v = prompt(`Your ${label} (leave blank to remove it):`, myContact[field] || "");
    if (v === null) return;
    try {
      const r = await api("/api/setcontact", { token: session.token, [field]: v.trim() });
      fillContact(r);
      toast(v.trim() ? "Saved ✓" : "Removed");
    } catch (e) { toast(e.message); }
  };
  $("#remPreview")?.addEventListener("click", async () => {
    const w = window.open("about:blank", "_blank"); // open synchronously so popup blockers allow it
    try {
      const res = await fetch(`/api/reminder?token=${encodeURIComponent(session.token)}&format=html&test=1`);
      const html = await res.text();
      if (!res.ok) throw new Error("Couldn't build the preview.");
      if (w) { w.document.open(); w.document.write(html); w.document.close(); }
    } catch (e) { toast(e.message); if (w) w.close(); }
  });
  const bindPref = (sel, field, onMsg, offMsg) => $(sel)?.addEventListener("change", async (e) => {
    const want = e.target.checked;
    try {
      const r = await api("/api/setcontact", { token: session.token, [field]: want });
      fillContact(r);
      toast(want ? onMsg : offMsg);
    } catch (err) { toast(err.message); e.target.checked = !want; }
  });
  bindPref("#remEmail", "emailReminders", "Email reminders on", "Email reminders off. Flip it back here anytime.");
  bindPref("#remSms", "smsReminders", "Text reminders on. We'll text you once texting is live.", "Text reminders off");
  $("#cEmailBtn").addEventListener("click", () => editContact("email"));
  $("#cPhoneBtn").addEventListener("click", () => editContact("phone"));
  $$("[data-ctmember]").forEach((b) => b.addEventListener("click", async () => {
    const id = b.dataset.ctmember, nm = b.dataset.ctname;
    try {
      const cur = await api("/api/setcontact", { token: session.token, memberId: id });
      const email = prompt(`${nm}'s email (blank to remove):`, cur.email || "");
      if (email === null) return;
      const phone = prompt(`${nm}'s phone (blank to remove):`, cur.phone || "");
      if (phone === null) return;
      await api("/api/setcontact", { token: session.token, memberId: id, email: email.trim(), phone: phone.trim() });
      toast(`${nm}'s contact info saved ✓`);
    } catch (e) { toast(e.message); }
  }));
  $("#hhGo")?.addEventListener("click", async () => {
    const name = $("#hhName").value.trim();
    if (name.length < 2) return toast("Enter the member's name");
    $("#hhGo").disabled = true;
    try {
      const r = await api("/api/household", { token: session.token, name, slots: Number($("#hhSlots").value) });
      $("#hhResult").innerHTML = `<div class="banner info" style="margin:10px 0;">✅ ${esc(r.name)} is in with ${r.slots.length} slot${r.slots.length > 1 ? "s" : ""}. They log in with <b>your PIN</b>. Pick for them from <a href="#/picks">My Picks</a>.</div>`;
      $("#hhName").value = "";
      toast(`${r.name} added to your household`);
      await loadState(true);
    } catch (e) { toast(e.message); }
    $("#hhGo").disabled = false;
  });
  $("#npinGo").addEventListener("click", async () => {
    const pin = $("#npin").value.trim();
    if (!/^\d{4,8}$/.test(pin)) return toast("PIN must be 4 to 8 digits");
    try { await api("/api/setpin", { token: session.token, pin }); toast("PIN updated ✓"); $("#npin").value = ""; }
    catch (e) { toast(e.message); }
  });
  $("#acctOut").addEventListener("click", () => { session.logout(); renderSession(); toast("Logged out"); location.hash = "#/"; });
  $("#admOut")?.addEventListener("click", () => { session.adminToken = ""; renderSession(); toast("Commissioner session ended"); renderAccount(); });
}

function renderMore() {
  view.innerHTML = `
    <h1>More</h1>
    <div class="morelist">
      ${session.token ? `<a href="#/account"><span class="mi">🙂</span>Account settings · ${esc(session.name)}</a>` : `<a href="#/login"><span class="mi">🔓</span>Log in</a>`}
      <a href="#/chat"><span class="mi">🗣</span>Trash Talk</a>
      <a href="#/log"><span class="mi">📜</span>${session.adminToken ? "All activity" : "Your activity"}</a>
      <a href="#/install"><span class="mi">📲</span>Add it to your phone</a>
      <a href="#/rules"><span class="mi">📖</span>Rules</a>
      <a href="#/hof"><span class="mi">🏆</span>Hall of Fame</a>
      <a href="#/join"><span class="mi">👋</span>Join the league</a>
      <a href="#/admin"><span class="mi">🔐</span>Commissioner</a>
    </div>
    <p class="ver" style="margin:14px 4px 0;">App build v${APP_BUILD}</p>
  `;
}

/* ---------- first run: create the league ---------- */
/* A fresh deploy has no league. Whoever opens it first creates one here and
   becomes the commissioner, so do it right after the first deploy. Every
   field can change later from the desk. */
function renderSetup() {
  document.title = "Create your league";
  const now = new Date();
  const season = now.getMonth() < 2 ? now.getFullYear() - 1 : now.getFullYear();
  view.innerHTML = `
    <h1>Create your league</h1>
    <p class="muted" style="margin:0 0 14px;">This site doesn't have a league yet. Set it up once and you're the commissioner. You can change any of this later from the desk.</p>
    <div class="card">
      <label class="field"><span>League name</span><input id="suName" maxlength="60" placeholder="e.g. Smith Family Survivor League"></label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <label class="field"><span>Season</span><input id="suSeason" type="number" value="${season}"></label>
        <label class="field"><span>Running since <span class="muted">(optional)</span></span><input id="suEst" inputmode="numeric" placeholder="e.g. 2017"></label>
        <label class="field"><span>Buy-in per slot $</span><input id="suBuyIn" type="number" min="0" value="10"></label>
        <label class="field"><span>Buy-back $</span><input id="suBuyback" type="number" min="0" value="10"></label>
        <label class="field"><span>Sudden death week</span><input id="suSD" type="number" min="1" max="18" value="4"></label>
        <label class="field"><span>Slots per player, max</span><input id="suSlots" type="number" min="1" max="10" value="3"></label>
      </div>
      <label class="field"><span>Your name, shown as commissioner</span><input id="suCName" autocomplete="name"></label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <label class="field"><span>Your phone <span class="muted">(optional)</span></span><input id="suCPhone" type="tel" autocomplete="tel"></label>
        <label class="field"><span>Your email <span class="muted">(optional)</span></span><input id="suCEmail" type="email" autocomplete="email"></label>
      </div>
      <label class="field"><span>Venmo username for payments <span class="muted">(optional)</span></span><input id="suVenmo" autocapitalize="off" placeholder="no @ needed"></label>
      <label class="field"><span>Admin PIN, 8+ characters (a short phrase works)</span><input id="suPin" type="password" autocomplete="new-password"></label>
      <button class="btn primary" id="suGo">Create the league</button>
      <p class="muted small" style="margin:10px 0 0;">The league starts with a standard rulebook built from these numbers. Edit it any time under League settings.</p>
    </div>`;
  $("#suGo").addEventListener("click", async () => {
    const v = (id) => $(id).value.trim();
    if (!v("#suName")) return toast("Give the league a name.");
    if (v("#suPin").length < 8) return toast("The admin PIN needs 8 or more characters.");
    const me = { name: v("#suCName"), phone: v("#suCPhone"), email: v("#suCEmail") };
    const btn = $("#suGo");
    btn.disabled = true;
    try {
      const r = await api("/api/bootstrap", {
        leagueName: v("#suName"), seasonYear: Number(v("#suSeason")) || undefined, established: v("#suEst"),
        buyIn: Number(v("#suBuyIn")), buybackFee: Number(v("#suBuyback")),
        suddenDeathWeek: Number(v("#suSD")) || 4, maxSlotsPerPlayer: Number(v("#suSlots")) || 3,
        venmo: v("#suVenmo").replace(/^@/, ""), adminPin: v("#suPin"),
        contacts: me.name && (me.phone || me.email) ? [me] : [],
      });
      session.adminToken = r.adminToken;
      toast("League created. This is your desk.");
      if (location.hash === "#/admin") render(); else location.hash = "#/admin";
    } catch (e) {
      btn.disabled = false;
      toast(e.message);
    }
  });
}

/* ---------- add it to your phone ---------- */
/* One quiet line on the board pointing at the how-to. Gone once the league
   runs from your home screen, and for good once you close it. */
function installNudgeHTML() {
  const standalone = window.matchMedia?.("(display-mode: standalone)")?.matches || navigator.standalone === true;
  let closed = false;
  try { closed = localStorage.getItem("sl_nudge_install") === "0"; } catch {}
  if (standalone || closed) return "";
  return `<div class="installnudge"><a href="#/install">📲 <b>Put the league on your home screen.</b> <span>Here's how ›</span></a><button class="nudgex" data-nudgex aria-label="Hide this">✕</button></div>`;
}
document.addEventListener("click", (e) => {
  const x = e.target.closest("[data-nudgex]");
  if (!x) return;
  try { localStorage.setItem("sl_nudge_install", "0"); } catch {}
  x.closest(".installnudge")?.remove();
});

/* The four steps that put the league on a phone's home screen. */
function renderInstall() {
  view.innerHTML = `
    <h1>Add it to your phone</h1>
    <p class="muted" style="margin:0 0 14px;">Put the league on your home screen: one tap in, full screen, no browser bars. Takes ten seconds.</p>
    <ol class="installsteps">
      <li>Open <b>${esc(location.host)}</b> in Safari.</li>
      <li>Press and hold the address bar (or tap <b>•••</b>), then tap <b>Share</b>.</li>
      <li>Scroll down and tap <b>Add to Home Screen</b>.</li>
      <li>Leave <b>Open as Web App</b> on and tap <b>Add</b>. That's it.</li>
    </ol>
    <p class="muted small">On Android: open the site in Chrome, tap the ⋮ menu, then <b>Add to Home screen</b>.</p>
  `;
}

/* ---------- trash talk ---------- */
/* Trash Talk as a component: list + composer, mounted into any container.
   Used by its own page and by the collapsible cell on Who's left. */
async function mountChat(root, { compact = false } = {}) {
  if (!root) return;
  const canPost = Boolean(session.token || session.adminToken);
  root.innerHTML = `
    <div class="chatlist ${compact ? "compact" : ""}" id="chatList"><div class="loading">Loading…</div></div>
    ${canPost ? `
      <div class="searchrow" style="margin-top:10px;">
        <input id="chatMsg" placeholder="Say something… (400 max)" maxlength="400" autocomplete="off">
        <button class="btn primary" id="chatSend">Send</button>
      </div>` : `<p class="muted small" style="margin:8px 0 0;"><a href="#/login">Log in</a> to talk your talk.</p>`}
  `;
  const load = async () => {
    const el = $("#chatList");
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
    try {
      const { messages } = await api("/api/chat?limit=150");
      el.innerHTML = messages.length ? messages.map((m) => `
        <div class="chatrow ${m.bot ? "bot" : ""}">
          <div class="chathead"><b>${esc(m.name)}</b>${m.bot ? ` <span class="badge host">🎤 Host</span>` : m.commish ? ` <span class="badge brand">Commish</span>` : ""}<span class="when">${timeAgo(m.ts)}</span>${session.adminToken ? `<button class="expand" data-delchat="${esc(m.id)}" title="Delete">✕</button>` : ""}</div>
          <div class="chattext">${esc(m.text)}</div>
        </div>`).join("") : `<p class="muted">No trash talk yet. Someone start it. 🐐 or 🤡, history will decide.</p>`;
      $$("[data-delchat]").forEach((b) => b.addEventListener("click", async () => {
        try { await api("/api/admin/op", { token: session.adminToken, op: "deleteChat", id: b.dataset.delchat }); toast("Deleted"); load(); } catch (e) { toast(e.message); }
      }));
      if (nearBottom || !el.dataset.loaded) el.scrollTop = el.scrollHeight;
      el.dataset.loaded = "1";
      if (messages.length && !document.hidden) markChatSeen(chatMsOf(messages[messages.length - 1].id)); // reading it counts as seen
    } catch (e) { el.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
  };
  await load();
  window.__chatReload = load;
  const send = async () => {
    const input = $("#chatMsg");
    const text = input?.value.trim();
    if (!text) return;
    const btn0 = $("#chatSend");
    btn0.disabled = true;
    const hostName = DB.state?.cfg?.hostName || "the host";
    // Same summons test as the server: "host", or the first real word of the host's name.
    const first = hostName.split(/\s+/).find((w) => w && !/^(the|a|an|mr|mrs|ms|dr)\.?$/i.test(w)) || "host";
    const summons = new RegExp(`(^|[^a-z])(host|${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?=$|[^a-z])`, "i");
    if (summons.test(text) || (text.includes("?") && /\b(rule|rules|buy ?backs?|lock|deadline|pot|payout|tie|void|kickoff|eliminat|surviv)\b/i.test(text))) btn0.textContent = `Summoning ${first}…`;
    try {
      await api("/api/chat", { token: session.token || session.adminToken, text });
      input.value = "";
      await load();
    } catch (e) { toast(e.message); }
    const btn = $("#chatSend");
    if (btn) { btn.disabled = false; btn.textContent = "Send"; }
  };
  $("#chatSend")?.addEventListener("click", send);
  $("#chatMsg")?.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
}

async function renderChat() {
  await loadState();
  view.innerHTML = `
    <h1>Trash Talk</h1>
    ${hint("🗣 League-wide chat. Everyone can read it; log in to post. Say the host's name and he answers, and if you talk picks he may wander over uninvited. The commissioner can delete anything, and the filter keeps it family-adjacent.", "chat")}
    <div id="chatPage"></div>
  `;
  await mountChat($("#chatPage"));
}

/* ---------- demo gallery: every status state, synthetic data ---------- */
async function renderDemo() {
  const { cfg } = await loadState();
  const DL = "2026-10-06T00:15:00Z"; // demo buy-back deadline (week 4 MNF)
  const W = (team, result, buyback, extra = {}) => ({ team, result, locked: true, source: "player", ...(buyback ? { buyback } : {}), ...extra });
  const mk = (label, weeks, status, extra = {}) => ({
    id: "demo-" + label.replace(/\W+/g, ""), label, playerId: "demo", playerName: label,
    weeks, status, eliminatedWeek: extra.eliminatedWeek ?? null, buybacksUsed: extra.buybacksUsed ?? 0,
    usedTeams: Object.values(weeks).filter(Boolean).map((r) => r.team).filter(Boolean),
    openLoss: extra.openLoss ?? null, buybackDeadline: extra.deadline === null ? null : DL,
  });

  const scenarios = [
    {
      title: "Lost, hasn't bought back yet",
      blurb: "The loss just landed. The league sees the amber status; the player sees the buy-back button and the deadline.",
      curWeek: 3,
      row: mk("Riley Example", { 1: W("Seattle Seahawks", "win"), 2: W("Denver Broncos", "loss", "available") }, "buyback-available", { openLoss: { lossWeek: 2 } }),
    },
    {
      title: "Buy-back requested, waiting on the money",
      blurb: "They tapped the button. Until the commissioner confirms the Venmo landed, the slot sits in pending.",
      curWeek: 3,
      row: mk("Casey Example", { 1: W("Seattle Seahawks", "win"), 2: W("Denver Broncos", "loss", "pending") }, "buyback-pending", { openLoss: { lossWeek: 2 } }),
    },
    {
      title: "One buy-back used 💸",
      blurb: "Lost week 1, paid the mulligan, moved on. The ✗ keeps the loss honest; the 💸 tag says it was covered.",
      curWeek: 3,
      row: mk("Jordan Example", { 1: W("Miami Dolphins", "loss", "confirmed"), 2: W("Arizona Cardinals", "win"), 3: W("Kansas City Chiefs", "pending", null, { locked: false }) }, "alive", { buybacksUsed: 1 }),
    },
    {
      title: "Two straight losses, two buy-backs 💸💸",
      blurb: "Back-to-back losing weeks, both bought back. Consecutive ✗ rows each carry their own tag, so the story reads clean.",
      curWeek: 3,
      row: mk("Sam Example", { 1: W("New England Patriots", "loss", "confirmed"), 2: W("New York Jets", "loss", "confirmed"), 3: W("Detroit Lions", "win") }, "alive", { buybacksUsed: 2 }),
    },
    {
      title: "Three straight losses, three buy-backs 💸💸💸",
      blurb: "The nine-lives special: $40 in and still breathing. Week 4 on is sudden death, so this is the last freebie era.",
      curWeek: 4,
      row: mk("Alex Example", { 1: W("Carolina Panthers", "loss", "confirmed"), 2: W("New York Giants", "loss", "confirmed"), 3: W("Tennessee Titans", "loss", "confirmed"), 4: W("Buffalo Bills", "pending", null, { locked: false }) }, "alive", { buybacksUsed: 3 }),
    },
    {
      title: "Out: sudden death, no more buy-backs",
      blurb: "A week 4+ loss is final. No button, no limbo: the skull, the week they died, and a sudden-death tag on the fatal pick.",
      curWeek: 5,
      row: mk("Pat Example", { 1: W("Seattle Seahawks", "win"), 2: W("Green Bay Packers", "win"), 3: W("Dallas Cowboys", "win"), 4: W("Tampa Bay Buccaneers", "loss", "sudden-death") }, "dead", { eliminatedWeek: 4, deadline: null }),
    },
    {
      title: "Out: buy-back window closed",
      blurb: "They lost in a revivable week but never paid by the week 4 deadline. Same skull, different epitaph.",
      curWeek: 4,
      row: mk("Drew Example", { 1: W("Carolina Panthers", "loss", "expired") }, "dead", { eliminatedWeek: 1, deadline: null }),
    },
  ];

  const gridWeeks = [1, 2, 3, 4, 5];
  const demoGrid = `
    <div class="section-h"><h2>The Who's left grid with every state at once</h2><div class="line"></div></div>
    <p class="muted small">Exactly how these seven examples look as rows on Who's left (the wide grid you see on desktop). Phones show the same rows as cards, like the left column further down.</p>
    <div class="gridwrap" style="margin-bottom:24px;"><table class="grid">
      <thead><tr><th class="sticky">Slot</th><th>Status</th>${gridWeeks.map((w) => `<th>W${w}</th>`).join("")}</tr></thead>
      <tbody>${scenarios.map((sc) => {
        const r = sc.row;
        return `<tr class="${r.status === "dead" ? "dead" : ""}">
          <td class="sticky">${esc(r.label)} ${moneyBags(r.buybacksUsed)}</td>
          <td>${statusBadge(r, sc.curWeek)}</td>
          ${gridWeeks.map((w) => {
            const rec = r.weeks[w];
            if (!rec?.team) return `<td></td>`;
            return `<td><span class="cellteam" title="${esc(rec.team)}${rec.buyback === "confirmed" ? " (bought back)" : ""}"><img src="${logoOf(rec.team)}" alt="" loading="lazy">${abbrOf(rec.team).toUpperCase()} ${markFor(rec.result)}${rec.buyback === "confirmed" ? "💸" : ""}</span></td>`;
          }).join("")}
        </tr>`;
      }).join("")}</tbody>
    </table></div>`;

  view.innerHTML = `
    <h1>Status gallery</h1>
    ${hint("🧪 Synthetic examples of every slot state, rendered with the real components. Left: what the league sees on Who's left. Right: what that player sees on My Picks. Nothing here touches real data.")}
    ${demoGrid}
    ${scenarios.map((sc) => `
      <div class="scenario">
        <h2>${esc(sc.title)}</h2>
        <p class="muted small">${esc(sc.blurb)}</p>
        <div class="scengrid">
          <div><h3>Who's left · everyone sees</h3>${slotCardHTML(sc.row, sc.curWeek, { open: true, star: false, expandBtn: false })}</div>
          <div><h3>My Picks tile · the player sees</h3>${tileHTML(sc.row, sc.curWeek, cfg, { selected: false, open: true, demo: true })}</div>
        </div>
      </div>`).join("")}
  `;
  $$("[data-demo]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); toast("Just a demo. The real button lives on your own slot."); }));
  $$("#view [data-tile]").forEach((b) => b.addEventListener("click", () => {}));
}

/* ---------- admin ---------- */
async function adminOp(op, payload = {}, { reload = true } = {}) {
  const r = await api("/api/admin/op", { token: session.adminToken, op, ...payload });
  DB.state = null;
  if (reload) DB.admin = await api(`/api/admin/full?token=${encodeURIComponent(session.adminToken)}`);
  return r;
}

/* Commissioner desk edits stage locally and apply together on Save. Nothing
   re-renders under the commissioner's hands; leaving with unsaved edits warns. */
let admPending = []; // [{ key, label, op, params, undo }]
let admDirtySettings = false;
const admOpen = new Set(); // desk cells the commissioner has expanded this session (all closed on first load)
let admSkipRender = false;
let admCtx = null; // per-render helpers for the delegated handlers below
const admUnsavedCount = () => admPending.length + (admDirtySettings ? 1 : 0);
/* Any exit from the desk with staged edits asks first, then drops them for real. */
function admConfirmDiscard(action) {
  if (currentRoute() !== "admin" || !admUnsavedCount()) return true;
  const n = admUnsavedCount();
  if (!confirm(`${action} and discard ${n} unsaved desk change${n === 1 ? "" : "s"}?`)) return false;
  admPending = []; admDirtySettings = false;
  return true;
}
const admMarker = (key, text) => `<span class="badge unsaved" data-marker="${esc(key)}">${text} · unsaved</span><button class="btn xs undo" data-unstage="${esc(key)}" data-marker="${esc(key)}">undo</button>`;
const admClearMarkers = (key) => $$(`[data-marker="${CSS.escape(key)}"]`).forEach((el) => el.remove());
function admDelegatedClick(e) {
  if (!admCtx || currentRoute() !== "admin") return;
  const { stage, unstage, A } = admCtx;
  const un = e.target.closest("[data-unstage]");
  if (un) return unstage(un.dataset.unstage);
  const paid = e.target.closest("[data-paid]");
  if (paid) {
    const key = `paid:${paid.dataset.paid}`;
    paid.hidden = true;
    paid.insertAdjacentHTML("afterend", admMarker(key, "paid"));
    return stage(key, "Mark paid", "addPayment", { slotId: paid.dataset.paid, type: "buyin" }, () => { admClearMarkers(key); paid.hidden = false; });
  }
  const vd = e.target.closest("[data-void]");
  if (vd) {
    const key = `void:${vd.dataset.void}`;
    vd.hidden = true;
    vd.insertAdjacentHTML("afterend", admMarker(key, "voided"));
    return stage(key, "Void payment", "voidPayment", { paymentId: vd.dataset.void }, () => { admClearMarkers(key); vd.hidden = false; });
  }
  const rv = e.target.closest("[data-adm]");
  if (rv) {
    const op = rv.dataset.adm;
    if (op === "grantRevival") {
      // Buying back is the player's call. The desk does it only on request, and says so.
      const fee = fmtMoney(A.cfg.buybackFee);
      const ask = rv.dataset.closed
        ? `Bring ${rv.dataset.label} back anyway?\n\nTheir window closed. Only do this if they paid and asked. It logs ${fee} in the pot and they can pick again.`
        : `Buy back ${rv.dataset.label} for them?\n\nOnly if they asked you to. It logs ${fee} in the pot and unlocks their picks. Everyone else taps Buy back on their own My Picks page.`;
      if (!confirm(ask)) return;
    }
    const LBL = {
      confirmRevival: ["✓ confirming", "Confirm buy-back"],
      denyRevival: ["denying", "Deny buy-back"],
      grantRevival: ["💸 buying back", "Buy back for them"],
      undoRevival: ["undoing", "Undo buy-back"],
    };
    const [mark, label] = LBL[op] || ["saving", "Buy-back"];
    const key = `revival:${op}:${rv.dataset.id || `${rv.dataset.slot}:${rv.dataset.loss}`}`;
    const row = rv.closest(".admin-row");
    const btns = [...row.querySelectorAll("[data-adm]")];
    btns.forEach((b) => (b.hidden = true));
    row.insertAdjacentHTML("beforeend", admMarker(key, mark));
    const payload = op === "grantRevival"
      ? { slotId: rv.dataset.slot, lossWeek: Number(rv.dataset.loss) }
      : { revivalId: rv.dataset.id };
    return stage(key, label, op, payload, () => { admClearMarkers(key); btns.forEach((b) => (b.hidden = false)); });
  }
  const rem = e.target.closest("[data-remind]");
  if (rem) {
    const key = `remind:${rem.dataset.remind}`;
    if (admPending.some((x) => x.key === key)) return unstage(key);
    const serverOn = rem.dataset.remstate === "1";
    const orig = { text: rem.textContent, cls: rem.className };
    rem.textContent = serverOn ? "🔕 Email off" : "🔔 Email on";
    rem.classList.toggle("danger", serverOn);
    rem.insertAdjacentHTML("afterend", admMarker(key, serverOn ? "turning off" : "turning on"));
    return stage(key, "Email reminders", "setContact", { playerId: rem.dataset.remind, emailReminders: !serverOn }, () => { admClearMarkers(key); rem.textContent = orig.text; rem.className = orig.cls; });
  }
  const rn = e.target.closest("[data-rnplayer]");
  if (rn) {
    const key = `rename:${rn.dataset.rnplayer}`;
    const name = prompt(`New name for ${rn.dataset.rnpname}:`, rn.dataset.rnpname);
    if (name === null || name.trim().length < 2) return;
    const nameEl = rn.closest(".admin-row")?.querySelector(".pname");
    const orig = rn.dataset.rnpname; // the server's name, not an earlier unsaved rename
    admClearMarkers(key);
    if (nameEl) nameEl.textContent = name.trim();
    rn.insertAdjacentHTML("afterend", admMarker(key, "renamed"));
    return stage(key, "Rename", "setContact", { playerId: rn.dataset.rnplayer, name: name.trim() }, () => { admClearMarkers(key); if (nameEl && orig !== undefined) nameEl.textContent = orig; });
  }
}
function admDelegatedChange(e) {
  if (!admCtx || currentRoute() !== "admin") return;
  const sel = e.target.closest("[data-ovr]");
  if (!sel) return;
  const key = `ovr:${sel.dataset.ovr}`;
  const orig = sel.dataset.orig || "";
  if (sel.value === orig) return admCtx.unstage(key);
  sel.classList.add("unsaved");
  admCtx.stage(key, "Result override", "setOverride", { gameId: sel.dataset.ovr, value: sel.value || null }, () => { sel.value = orig; sel.classList.remove("unsaved"); });
}
function admDelegatedInput(e) {
  if (!admCtx || currentRoute() !== "admin") return;
  if (!e.target.closest('[data-cell="settings"]') && !e.target.closest('[data-cell="host"]')) return;
  admDirtySettings = true;
  admCtx.updateSaveBar();
}
window.addEventListener("beforeunload", (e) => {
  if (currentRoute() === "admin" && admUnsavedCount()) { e.preventDefault(); e.returnValue = ""; }
});

async function renderAdmin() {
  if (!session.adminToken) {
    view.innerHTML = `
      <div class="card" style="max-width:380px;margin:24px auto;">
        <h2>Commissioner login</h2>
        <label class="field"><span>Admin PIN</span><input id="aPin" inputmode="numeric" placeholder="Admin PIN"></label>
        <button class="btn primary block" id="aGo">Log in</button>
      </div>`;
    $("#aPin").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#aGo").click(); });
    $("#aGo").addEventListener("click", async () => {
      try {
        const r = await api("/api/admin/auth", { pin: $("#aPin").value.trim() });
        session.adminToken = r.token;
        renderAdmin();
      } catch (e) { toast(e.message); }
    });
    return;
  }

  view.innerHTML = `<div class="loading">Loading commissioner desk…</div>`;
  try {
    DB.admin = await api(`/api/admin/full?token=${encodeURIComponent(session.adminToken)}`);
  } catch (e) {
    if (e.status === 401 || e.status === 403) { session.adminToken = ""; toast("Admin session expired"); return renderAdmin(); }
    view.innerHTML = `<div class="card"><h2>Couldn't load the desk</h2><p class="muted">${esc(e.message)}</p><button class="btn primary" id="admRetry">Try again</button></div>`;
    $("#admRetry").addEventListener("click", () => renderAdmin());
    return;
  }
  const A = DB.admin;
  const snap = A.snapshot || { slots: [], pot: {} };
  const slotLabel = (id) => A.slots.slots.find((s) => s.id === id)?.label || id;
  const pendingRevivals = A.revivals.entries.filter((r) => r.status === "pending");
  const confirmedRevivals = A.revivals.entries.filter((r) => r.status === "confirmed");
  // A loss with no buy-back on file: still inside the window (their move) or
  // past it (the slot is out).
  const undeclaredLosses = (snap.slots || []).flatMap((r) =>
    Object.entries(r.weeks || {})
      .filter(([, rec]) => rec?.buyback === "available" || rec?.buyback === "expired")
      .map(([w, rec]) => ({ slotId: r.id, label: r.label, week: Number(w), by: rec.buybackBy || null, expired: rec.buyback === "expired" })));
  const notBoughtBack = undeclaredLosses.filter((x) => !x.expired).sort((a, b) => String(a.by).localeCompare(String(b.by)) || a.label.localeCompare(b.label));
  const windowClosed = undeclaredLosses.filter((x) => x.expired);
  const bbSec = ({ tone, title, badge, count, def, rows, empty, open = false }) => `
      <details class="bbsec ${tone}"${open ? " open" : ""}>
        <summary><span class="bbsec-h">${title} <span class="badge ${badge}">${count}</span></span><span class="bbsec-def">${def}</span></summary>
        <div class="rows">${rows || `<p class="muted small">${empty}</p>`}</div>
      </details>`;
  const fee = `$${A.cfg.buybackFee}`;
  // The rules say the money lands by the loss's deadline. The app never kills a
  // declared slot over late money, so the desk has to chase it: late goes first.
  const dueOf = (r) => (snap.slots || []).find((x) => x.id === r.slotId)?.weeks?.[r.lossWeek]?.buybackBy || null;
  const nowMs = Date.now();
  const isLate = (r) => { const due = dueOf(r); return !!due && new Date(due).getTime() < nowMs; };
  const lateRevivals = pendingRevivals.filter(isLate).sort((a, b) => String(dueOf(a)).localeCompare(String(dueOf(b))));
  const waitingRevivals = pendingRevivals.filter((r) => !isLate(r));
  const daysLate = (r) => Math.floor((nowMs - new Date(dueOf(r)).getTime()) / 864e5);
  // One tap to chase it: a text to whoever pays for that household, already written.
  const collectText = (r) => {
    const pid = A.slots.slots.find((x) => x.id === r.slotId)?.playerId;
    const pl = A.roster.players.find((x) => x.id === pid);
    const payer = (pl?.managedBy && A.roster.players.find((x) => x.id === pl.managedBy)) || pl;
    const tel = String(payer?.phone || "").replace(/[^\d+]/g, "");
    if (!tel) return `<span class="muted small">no phone on file</span>`;
    const body = `Hey ${String(payer.name || "").split(" ")[0]}, the ${fee} for ${slotLabel(r.slotId)}'s week ${r.lossWeek} buy-back is late.${A.cfg.venmo ? ` Venmo @${A.cfg.venmo} today please.` : ""}`;
    return `<a class="btn sm" href="sms:${esc(tel)}?&body=${encodeURIComponent(body)}">💬 Text</a>`;
  };
  const unpaid = new Set(snap.pot?.unpaidSlotIds || []);
  const curWeek = snap.week || 1;
  const sched = await loadScores(curWeek);
  const paidTotal = (slotId) => A.payments.entries.filter((p) => p.slotId === slotId && !p.voided).reduce((sum, p) => sum + Number(p.amount || 0), 0);

  view.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
      <h1 style="margin:0;flex:1;">Commissioner desk</h1>
      <a class="btn sm" href="/api/admin/export?token=${encodeURIComponent(session.adminToken)}">Export CSV</a>
      <button class="btn sm" id="aOut">Log out</button>
    </div>
    ${A.adminPinWeak ? `<div class="banner" style="border-left-color:var(--loss);">🔑 <b>Your admin PIN is short.</b> A guessed admin PIN exposes every pick and every household's contact info. Set one of 8+ characters in League settings below (a short phrase is fine).</div>` : ""}
    <div class="statgrid">
      <div class="stat hero"><div class="k">Pot collected</div><div class="v">${fmtMoney(snap.pot?.collected)}<span class="unit"> of ${fmtMoney(snap.pot?.total)}</span></div></div>
      <div class="stat"><div class="k">If everyone pays</div><div class="v">${fmtMoney(snap.pot?.expected)}</div></div>
      <div class="stat"><div class="k">Unpaid slots</div><div class="v">${snap.pot?.unpaidCount ?? 0}</div></div>
      <div class="stat"><div class="k">Split preview</div><div class="v">${fmtMoney(snap.splitPreview)}<span class="unit"> each</span></div></div>
    </div>

    <details class="adm" data-cell="buybacks">
      <summary>💸 Buy-backs ${lateRevivals.length ? `<span class="badge miss">${lateRevivals.length} late</span> ` : ""}${waitingRevivals.length ? `<span class="badge limbo">${waitingRevivals.length} waiting on ${fee}</span> ` : ""}${notBoughtBack.length ? `<span class="badge limbo">${notBoughtBack.length} not bought back</span>` : ""}</summary>
      <div class="inner">
        ${lateRevivals.length ? bbSec({ tone: "t-late", title: "Late: collect now", badge: "miss", count: lateRevivals.length, open: true,
          def: `They tapped Buy back, but the ${fee} wasn't in by their deadline, and the rules say it has to be. The app keeps them playing, so collecting is on you. Get the money today, then tap Got the ${fee}. If they won't pay, Deny: the loss stands and the slot is out.`,
          rows: lateRevivals.map((r) => `
          <div class="admin-row"><span class="grow">${esc(slotLabel(r.slotId))} · week ${r.lossWeek} loss <span class="badge miss">${daysLate(r) >= 1 ? `${daysLate(r)} day${daysLate(r) === 1 ? "" : "s"} late` : "late"}</span> <span class="muted small">was due ${fmtKick(dueOf(r))}</span></span>
            ${collectText(r)}
            <button class="btn sm primary" data-adm="confirmRevival" data-id="${r.id}">Got the ${fee} ✓</button>
            <button class="btn sm danger" data-adm="denyRevival" data-id="${r.id}">Deny</button></div>`).join("") }) : ""}
        ${bbSec({ tone: "t-you", title: `Waiting on their ${fee}`, badge: "limbo", count: waitingRevivals.length, open: true,
          def: `They tapped Buy back, so they're picking again. The ${fee} is due by their deadline. Tap Got the ${fee} when it lands. If it isn't in by then, it moves up to Late.`,
          empty: "Nobody's waiting on you.",
          rows: waitingRevivals.map((r) => `
          <div class="admin-row"><span class="grow">${esc(slotLabel(r.slotId))} · week ${r.lossWeek} loss ${dueOf(r) ? `<span class="muted small">due ${fmtKick(dueOf(r))}</span>` : ""}</span>
            <button class="btn sm primary" data-adm="confirmRevival" data-id="${r.id}">Got the ${fee} ✓</button>
            <button class="btn sm danger" data-adm="denyRevival" data-id="${r.id}">Deny</button></div>`).join("") })}
        ${bbSec({ tone: "t-them", title: "Lost, not bought back yet", badge: "limbo", count: notBoughtBack.length,
          def: `They lost and haven't tapped Buy back, so their picks are locked. It's their move: they buy back on their own My Picks page. If their deadline passes first, they're out. Use Buy back for them only when someone asks you to.`,
          empty: "Everyone who lost has bought back or is out.",
          rows: notBoughtBack.map((x) => `
          <div class="admin-row"><span class="grow">${esc(x.label)} · week ${x.week} loss ${x.by ? `<span class="muted small">deadline ${fmtKick(x.by)}</span>` : ""}</span>
            <button class="btn sm" data-adm="grantRevival" data-slot="${x.slotId}" data-loss="${x.week}" data-label="${esc(x.label)}">Buy back for them</button></div>`).join("") })}
        ${bbSec({ tone: "t-out", title: "Out: window closed", badge: "dead", count: windowClosed.length,
          def: `Their deadline passed before they bought back, so the slot is out. Bring one back only if they paid and asked. It logs the ${fee} and they can pick again.`,
          empty: "Nobody's missed a deadline.",
          rows: windowClosed.map((x) => `
          <div class="admin-row"><span class="grow">${esc(x.label)} · week ${x.week} loss ${x.by ? `<span class="muted small">closed ${fmtKick(x.by)}</span>` : ""}</span>
            <button class="btn sm" data-adm="grantRevival" data-slot="${x.slotId}" data-loss="${x.week}" data-label="${esc(x.label)}" data-closed="1">Bring back anyway</button></div>`).join("") })}
        ${bbSec({ tone: "t-done", title: "Bought back", badge: "alive", count: confirmedRevivals.length,
          def: `Paid and back in the pool. Undo takes the buy-back off and voids its ${fee}.`,
          empty: "None yet.",
          rows: confirmedRevivals.map((r) => `
          <div class="admin-row"><span class="grow">${esc(slotLabel(r.slotId))} · week ${r.lossWeek} loss${r.grantedBy === "commissioner" ? ` <span class="muted small">(marked at the desk)</span>` : ""}</span>
            <button class="btn sm danger" data-adm="undoRevival" data-id="${r.id}">Undo</button></div>`).join("") })}
      </div>
    </details>

    <details class="adm" data-cell="paid">
      <summary>💰 Who's paid ${unpaid.size ? `<span class="badge limbo">${unpaid.size} unpaid</span>` : `<span class="badge alive">all paid</span>`}</summary>
      <div class="inner">
        ${snap.slots.map((r) => `<div class="admin-row"><span class="grow">${esc(r.label)} ${moneyBags(r.buybacksUsed)}</span><span class="muted small">${fmtMoney(paidTotal(r.id))} in</span>${unpaid.has(r.id) ? `<button class="btn sm primary" data-paid="${r.id}">Mark buy-in paid</button>` : `<span class="badge alive">paid</span>`}</div>`).join("") || `<p class="muted small">Nobody yet.</p>`}
        <h3 style="margin-top:14px;">Recent payments</h3>
        ${A.payments.entries.slice(-12).reverse().map((p) => `<div class="admin-row ${p.voided ? "muted" : ""}"><span class="grow">${esc(slotLabel(p.slotId))} · ${fmtMoney(p.amount)} ${p.type}${p.voided ? " (voided)" : ""}</span><span class="muted small">${fmtStamp(p.ts)}</span>${p.voided ? "" : `<button class="btn sm danger" data-void="${p.id}">Void</button>`}</div>`).join("") || `<p class="muted small">None yet.</p>`}
      </div>
    </details>

    <details class="adm" data-cell="activity">
      <summary>📜 All activity</summary>
      <div class="inner">
        <div id="admLogFeed"></div>
      </div>
    </details>

    <details class="adm" data-cell="reminders">
      <summary>📨 Reminder emails ${A.mail?.ready ? "" : `<span class="badge limbo">not set up</span>`}</summary>
      <div class="inner">
        <p class="muted small">The app emails every head of household on its own: Thursdays at noon PT (everyone) and Mondays at noon PT (only households still owing a pick). Each run mails you a summary. Use these for an extra send.</p>
        ${A.mail?.ready
          ? `<p class="small" style="margin:6px 0 0;">Sends from <b>${esc(A.mail.from)}</b>.${A.mail.summaryTo ? ` Summaries and tests go to <b>${esc(A.mail.summaryTo)}</b>.` : ""}</p>`
          : `<p class="small" style="margin:6px 0 0;">Not sending yet.${A.mail?.missing?.length ? ` Missing in Netlify: <b>${esc(A.mail.missing.join(", "))}</b>. Add it there, then redeploy.` : ""}</p>`}
        <div class="admin-row" style="border:0;gap:8px;flex-wrap:wrap;">
          <button class="btn sm primary" data-remsend="all">Send everyone now</button>
          <button class="btn sm" data-remsend="missing">Send to missing picks only</button>
          <button class="btn sm" data-remsend="test">Send me a test</button>
          <label class="small muted" style="display:flex;align-items:center;gap:6px;"><input type="checkbox" id="remForce" style="width:auto;margin:0;"> resend even if this week's already went out</label>
        </div>
        <div id="remResult" class="small" style="margin-top:8px;"></div>
      </div>
    </details>
    <details class="adm" data-cell="host">
      <summary>🎤 The Host ${A.host?.configured ? (A.host.on && !(A.host.muteUntil && new Date(A.host.muteUntil) > new Date()) ? `<span class="badge alive">on</span>` : `<span class="badge limbo">off</span>`) : `<span class="badge limbo">not set up</span>`}</summary>
      <div class="inner">
        ${A.host?.configured ? `
          <p class="muted small">${esc(A.host.name)} answers when someone says his name or asks a rules question, any day. On his own he only talks on football days: up to 3 times on a day with a game, once on the morning after one, 8am to 10pm PT, and he often passes. A week with no games is a week of silence. Knockouts are separate: when a game ends and someone is out for good, he names them and says the tribe has spoken, any hour, once each. Today: ${A.host.repliesToday} repl${A.host.repliesToday === 1 ? "y" : "ies"} out of ${A.host.attemptsToday ?? A.host.repliesToday} look${(A.host.attemptsToday ?? A.host.repliesToday) === 1 ? "" : "s"}, ${A.host.unpromptedToday} unprompted.${A.host.muteUntil && new Date(A.host.muteUntil) > new Date() ? ` Muted until ${esc(fmtStamp(A.host.muteUntil))}.` : ""}${A.host.lastError ? `<br><span style="color:var(--loss)">Last error: ${esc(A.host.lastError)}</span>` : ""}</p>
          ${A.host.lastLine ? `<p class="small" style="margin:0 0 10px;"><span class="muted">Last line:</span> “${esc(A.host.lastLine)}”</p>` : ""}
          <div class="admin-row" style="border:0;gap:8px;flex-wrap:wrap;">
            <button class="btn sm ${A.host.on ? "danger" : "primary"}" data-hostop="${A.host.on ? "off" : "on"}">${A.host.on ? "Turn the host off" : "Turn the host on"}</button>
            <button class="btn sm" data-hostop="mute">Mute for 24 hours</button>
            <button class="btn sm" data-hostop="now">Say something now</button>
          </div>
          <div id="hostResult" class="small" style="margin-top:8px;"></div>

          <h3 style="margin:16px 0 4px;">His name</h3>
          <label class="field"><span>What the league calls him</span><input id="cfgHostName" value="${esc(A.cfg.hostName || "")}" placeholder="The Host"></label>

          <h3 style="margin:16px 0 4px;">His personality</h3>
          <p class="muted small" style="margin:0 0 8px;">This is the voice, in your words. Everything else holds no matter what you write here: he still runs the snuffing, still only uses real league data, still never goes after anybody's body, family, money or health, and still keeps it to a couple of sentences. Leave it empty for the voice he shipped with.</p>
          <div class="admin-row" style="border:0;gap:6px;flex-wrap:wrap;padding:0 0 8px;">
            ${(A.hostPersonas || []).map((x) => `<button class="btn sm" data-persona="${esc(x.id)}" title="${esc(x.blurb)}">${esc(x.name)}</button>`).join("")}
            <button class="btn sm danger" data-persona="__clear">Back to default</button>
          </div>
          <div class="muted small" id="personaBlurb" style="margin:0 0 6px;">${esc((A.hostPersonas || []).find((x) => x.text === (A.cfg.hostPersona || "").trim())?.blurb || (A.cfg.hostPersona ? "Your own words." : "The voice he shipped with."))}</div>
          <textarea id="cfgHostPersona" rows="10" placeholder="Describe him. Voice first, then how he talks: what he sounds like, what he cares about, what he does to a bad pick.">${esc(A.cfg.hostPersona || "")}</textarea>
          <p class="muted small" style="margin:6px 0 0;">Save below, then hit <b>Say something now</b> to hear it.</p>

          <p class="muted small" style="margin:10px 0 0;">Blocked words for the whole chat live in League settings below. Delete any line from Trash Talk like any other message.</p>`
        : `<p class="muted small">Add <b>ANTHROPIC_API_KEY</b> in Netlify (Site configuration → Environment variables) and redeploy. Until then the chat is just the league.</p>`}
      </div>
    </details>
    <details class="adm" data-cell="roster">
      <summary>🧑‍🤝‍🧑 Roster (${A.roster.players.length} players, ${A.slots.slots.filter((s) => !s.withdrawn).length} slots)</summary>
      <div class="inner">
        ${A.roster.players.map((p) => {
          const slots = A.slots.slots.filter((s2) => s2.playerId === p.id);
          return `<div class="admin-row">
            <span class="grow"><span class="pname">${esc(p.name)}</span> <span class="muted small">PIN ${esc(p.pin)}${p.email ? " · " + esc(p.email) : ""}${p.phone ? " · " + esc(p.phone) : ""}${p.managedBy ? ` · household of ${esc(A.roster.players.find((x) => x.id === p.managedBy)?.name || "?")}` : ""}</span><br>
            <span class="muted small">${slots.map((s2) => `${esc(s2.label)}${s2.withdrawn ? " (withdrawn)" : ""}${slots.length > 1 ? `<button class="slotx" data-rmslot="${s2.id}" data-rmslotlabel="${esc(s2.label)}" title="Remove this slot">✕</button>` : ""}`).join(" · ")}</span></span>
            <button class="btn sm" data-rnplayer="${p.id}" data-rnpname="${esc(p.name)}">Rename</button>
            <button class="btn sm ${p.emailOff ? "danger" : ""}" data-remind="${p.id}" data-remstate="${p.emailOff ? "0" : "1"}" title="${p.emailOff ? "Email reminders are OFF for this player. Click to turn on." : "Email reminders on. Click to turn off (if they ask you to)."}">${p.emailOff ? "🔕 Email off" : "🔔 Email on"}</button>${p.smsOn ? ` <span class="badge brand" title="Wants text reminders when texting is live">📱 texts</span>` : ""}
            <button class="btn sm" data-newpin="${p.id}" data-pname="${esc(p.name)}">New PIN</button>
            <button class="btn sm" data-addslot="${p.id}">+ slot</button>
            <button class="btn sm danger" data-rmplayer="${p.id}" data-rmname="${esc(p.name)}">Remove</button>
          </div>`;
        }).join("") || `<p class="muted small">Nobody yet.</p>`}
        <h3 style="margin-top:14px;">Add a player</h3>
        <div class="admin-row" style="border:0;">
          <input id="apName" placeholder="Name" style="flex:2;min-width:120px;">
          <input id="apEmail" placeholder="Email (optional)" style="flex:2;min-width:120px;">
          <select id="apSlots" style="flex:1;min-width:80px;">${[1, 2, 3].map((n) => `<option>${n}</option>`).join("")}</select>
          <button class="btn sm primary" id="apGo">Add</button>
        </div>
      </div>
    </details>

    <details class="adm" data-cell="results">
      <summary>🏟️ Week ${curWeek} results and overrides</summary>
      <div class="inner">
        <p class="muted small">Results grade automatically from the live feed. Override only when the feed is wrong or a game is postponed (VOID = pick counts as a win).</p>
        ${(sched.games || []).map((g) => `
          <div class="admin-row"><span class="grow">${esc(g.away.name)} @ ${esc(g.home.name)} <span class="muted small">${g.completed ? "Final" : esc(g.detail || fmtKick(g.date))}</span></span>
          <select data-ovr="${g.id}" data-orig="${esc(A.overrides[g.id] || "")}">
            <option value="">auto</option>
            <option value="${esc(g.home.name)}" ${A.overrides[g.id] === g.home.name ? "selected" : ""}>${esc(g.home.name)} won</option>
            <option value="${esc(g.away.name)}" ${A.overrides[g.id] === g.away.name ? "selected" : ""}>${esc(g.away.name)} won</option>
            <option value="TIE" ${A.overrides[g.id] === "TIE" ? "selected" : ""}>Tie</option>
            <option value="VOID" ${A.overrides[g.id] === "VOID" ? "selected" : ""}>Void (push)</option>
          </select></div>`).join("")}
        <h3 style="margin-top:14px;">Enter a pick for someone</h3>
        <p class="muted small">Somebody texted you their pick? Put it in here. It bypasses locks, gets logged as commissioner, and shows up everywhere (app and sheet mirror) within a minute.</p>
        <div class="admin-row" style="border:0;">
          <select id="fpSlot" style="flex:2;min-width:140px;">${snap.slots.map((s2) => `<option value="${s2.id}">${esc(s2.label)}</option>`).join("")}</select>
          <input id="fpWeek" type="number" min="1" max="18" value="${curWeek}" style="flex:0 0 70px;">
          <select id="fpTeam" style="flex:2;min-width:140px;"></select>
          <button class="btn sm primary" id="fpGo">Set</button>
          <button class="btn sm danger" id="fpClear">Clear</button>
        </div>
      </div>
    </details>

    <details class="adm" data-cell="settings">
      <summary>⚙️ League settings</summary>
      <div class="inner">
        <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px;">
          <label class="field"><span>League name</span><input id="cfgName" value="${esc(A.cfg.leagueName)}"></label>
          <label class="field"><span>Running since</span><input id="cfgEst" inputmode="numeric" placeholder="e.g. 2017" value="${esc(A.cfg.established || "")}"></label>
        </div>
        <div class="field"><span>Commissioners (name, phone, email)</span>
          <p class="muted small" style="margin:0 0 6px;font-weight:400;text-transform:none;letter-spacing:0;">The league sees Text and Email buttons for each name, never the number itself. Leave a row's name blank to drop it.</p>
          <div id="cfgContacts">${[...(A.cfg.contacts || []), { name: "", phone: "", email: "" }].map((c, i) => `
            <div class="contactedit" data-ci="${i}">
              <input data-cf="name" placeholder="Name" value="${esc(c.name || "")}">
              <input data-cf="phone" placeholder="Phone" inputmode="tel" value="${esc(c.phone || "")}">
              <input data-cf="email" placeholder="Email" inputmode="email" value="${esc(c.email || "")}">
            </div>`).join("")}</div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          <label class="field"><span>Buy-in $</span><input id="cfgBuyIn" type="number" value="${A.cfg.buyIn}"></label>
          <label class="field"><span>Buy-back $</span><input id="cfgBuyback" type="number" value="${A.cfg.buybackFee}"></label>
        </div>
        <label class="field"><span>League note (shows atop Who's left; blank hides it)</span><textarea id="cfgNote" rows="3" placeholder="e.g. Buy-ins due before kickoff Thursday!">${esc(A.cfg.leagueNote || "")}</textarea></label>
        <label class="field"><span>Sign-up note (shows atop Join and Log in; blank = automatic "still time to sign up" line with this week's last kickoff)</span><textarea id="cfgJoinNote" rows="3" placeholder="e.g. Still time to sign up! Entries close at Monday Night Football kickoff, 5:15 PM PT.">${esc(A.cfg.joinNote || "")}</textarea></label>
        <label class="field"><span>Venmo handle</span><input id="cfgVenmo" value="${esc(A.cfg.venmo || "")}"></label>
        <label class="field"><span>Trash Talk blocked words <span class="muted">(everyone's messages, not just the Host; comma separated, the standard profanity list is always on)</span></span><textarea id="cfgBlocklist" rows="2" placeholder="e.g. family nicknames you'd rather not see in print">${esc(A.cfg.chatBlocklist || "")}</textarea></label>
        <label class="field"><span>Sign-ups open</span><select id="cfgJoin"><option value="true" ${A.cfg.joinOpen ? "selected" : ""}>Open</option><option value="false" ${A.cfg.joinOpen ? "" : "selected"}>Closed</option></select></label>
        <label class="field"><span>Rules text</span><textarea id="cfgRules" rows="10">${esc(A.cfg.rulesText || "")}</textarea></label>
        <label class="field"><span>Hall of Fame <span class="muted">(JSON list; add "flawless": ["Name"] to a year for champs who never bought back)</span></span><textarea id="cfgHof" rows="6" spellcheck="false">${esc(JSON.stringify(A.cfg.hallOfFame || [], null, 1))}</textarea></label>
        <label class="field"><span>Admin PIN <span class="muted">(8+ characters; blank keeps the current one)</span></span><input id="cfgPin" value="" placeholder="unchanged" autocomplete="off"></label>
        <button class="btn primary" id="cfgSave">Save settings</button>
      </div>
    </details>
    <div class="verbar savebar" id="admSaveBar"><span id="admSaveMsg"></span><button class="btn sm" id="admDiscard">Discard</button><button class="btn sm primary" id="admSaveGo">Save</button></div>
  `;
  // Cells: closed on first load, then remembered for the session so nothing jumps around.
  $$("details.adm[data-cell]").forEach((d) => {
    d.open = admOpen.has(d.dataset.cell);
    d.addEventListener("toggle", () => { d.open ? admOpen.add(d.dataset.cell) : admOpen.delete(d.dataset.cell); });
  });

  $("#aOut").addEventListener("click", () => {
    if (admUnsavedCount() && !confirm(`You have ${admUnsavedCount()} unsaved change${admUnsavedCount() === 1 ? "" : "s"}. Log out without saving?`)) return;
    admPending = []; admDirtySettings = false; admCtx = null;
    session.adminToken = ""; renderSession(); renderAdmin();
  });
  // Re-render in place: same scroll position, same open cells.
  const SETTINGS_IDS = ["cfgName", "cfgEst", "cfgBuyIn", "cfgBuyback", "cfgNote", "cfgJoinNote", "cfgVenmo", "cfgJoin", "cfgRules", "cfgHof", "cfgPin", "cfgHostName", "cfgHostPersona", "cfgBlocklist"];
  const contactRows = () => $$("#cfgContacts .contactedit").map((row) => Object.fromEntries(
    ["name", "phone", "email"].map((f) => [f, row.querySelector(`[data-cf="${f}"]`)?.value ?? ""])));
  const rerender = async (msg) => {
    if (msg) toast(msg);
    const y = window.scrollY;
    // Unsaved settings survive a redraw: read them out, put them back. The
    // commissioner rows are fields too, and losing a half-typed email to an
    // unrelated staged action is the kind of thing nobody reports, they just
    // stop trusting the page.
    const keep = admDirtySettings ? Object.fromEntries(SETTINGS_IDS.map((id) => [id, $("#" + id)?.value])) : null;
    const keepContacts = admDirtySettings ? contactRows() : null;
    await loadState(true).catch(() => {});
    await renderAdmin();
    if (keep) {
      for (const [id, v] of Object.entries(keep)) { const el = $("#" + id); if (el && v !== undefined) el.value = v; }
      $$("#cfgContacts .contactedit").forEach((row, i) => {
        const was = keepContacts?.[i]; if (!was) return;
        for (const f of ["name", "phone", "email"]) { const el = row.querySelector(`[data-cf="${f}"]`); if (el) el.value = was[f]; }
      });
      admDirtySettings = true; updateSaveBar();
    }
    window.scrollTo(0, y);
  };
  const updateSaveBar = () => {
    const bar = $("#admSaveBar"); if (!bar) return;
    const n = admUnsavedCount();
    bar.classList.toggle("show", n > 0);
    if (n) $("#admSaveMsg").textContent = `${n} unsaved change${n === 1 ? "" : "s"}`;
    $("#admSaveGo").textContent = n ? `Save ${n}` : "Save";
  };
  const stage = (key, label, op, params, undo) => { admPending = admPending.filter((x) => x.key !== key); admPending.push({ key, label, op, params, undo }); updateSaveBar(); };
  let saving = null; // single-flight: a second Save (or a structural action) waits for the first
  const unstage = (key) => { if (saving) return toast("Hang on, saving…"); const it = admPending.find((x) => x.key === key); if (!it) return; admPending = admPending.filter((x) => x !== it); try { it.undo?.(); } catch {} updateSaveBar(); };
  const saveSettings = async () => {
    let hofVal;
    try {
      hofVal = JSON.parse($("#cfgHof").value);
      if (!Array.isArray(hofVal) || hofVal.some((h) => typeof h?.year !== "number" || !Array.isArray(h?.champions))) throw new Error();
    } catch { throw new Error("Hall of Fame must stay a JSON list of {year, champions[]} entries. Fix it or reload to reset."); }
    const patch = {
      leagueName: $("#cfgName").value, established: $("#cfgEst").value.trim(), buyIn: Number($("#cfgBuyIn").value), buybackFee: Number($("#cfgBuyback").value),
      venmo: $("#cfgVenmo").value.trim(), joinOpen: $("#cfgJoin").value === "true", rulesText: $("#cfgRules").value,
      leagueNote: $("#cfgNote").value.trim(), joinNote: $("#cfgJoinNote").value.trim(), hallOfFame: hofVal,
      chatBlocklist: $("#cfgBlocklist").value.trim(),
      ...($("#cfgHostName") ? { hostName: $("#cfgHostName").value.trim() } : {}),
      ...($("#cfgHostPersona") ? { hostPersona: $("#cfgHostPersona").value.trim() } : {}),
      ...($("#cfgContacts") ? { contacts: contactRows().map((c) => ({ name: c.name.trim(), phone: c.phone.trim(), email: c.email.trim() })).filter((c) => c.name && (c.phone || c.email)) } : {}),
      ...($("#cfgPin").value.trim() ? { adminPin: $("#cfgPin").value.trim() } : {}),
    };
    await adminOp("setConfig", { patch }, { reload: false });
    Object.assign(A.cfg, patch);
    admDirtySettings = false;
  };
  const saveAll = () => saving || (saving = doSaveAll().finally(() => { saving = null; }));
  const doSaveAll = async () => {
    const go = $("#admSaveGo"); if (go) go.disabled = true;
    const items = admPending.slice();
    let done = 0, failed = null;
    for (const it of items) {
      try { await adminOp(it.op, it.params, { reload: false }); admPending = admPending.filter((x) => x !== it); done++; }
      catch (e) { failed = `${it.label}: ${e.message}`; break; }
    }
    let savedSettings = false;
    if (!failed && admDirtySettings) { try { await saveSettings(); savedSettings = true; } catch (e) { failed = e.message; } }
    if (go) go.disabled = false;
    if (failed) toast(failed, 6000);
    if (done || savedSettings) {
      const n = done + (savedSettings ? 1 : 0);
      if (!failed) toast(`Saved ${n} change${n === 1 ? "" : "s"} ✓`);
      if (!failed && !admPending.length) await rerender(); else updateSaveBar(); // a partial save keeps the leftovers (and your typed settings) staged
    } else updateSaveBar();
  };
  const ensureSaved = async () => {
    const n = admUnsavedCount();
    if (!n) return true;
    if (!confirm(`Save your ${n} unsaved change${n === 1 ? "" : "s"} first?`)) return false;
    await saveAll();
    return admUnsavedCount() === 0;
  };
  admCtx = { stage, unstage, updateSaveBar, saveAll, A };
  if (!window.__admDelegated) {
    window.__admDelegated = true;
    view.addEventListener("click", admDelegatedClick);
    view.addEventListener("change", admDelegatedChange);
    view.addEventListener("input", admDelegatedInput);
  }
  $("#admSaveGo").addEventListener("click", saveAll);
  $("#admDiscard").addEventListener("click", async () => {
    if (saving) return toast("Hang on, saving…");
    const n = admUnsavedCount();
    if (!n || !confirm(`Discard ${n} unsaved change${n === 1 ? "" : "s"}?`)) return;
    admPending.slice().reverse().forEach((it) => { try { it.undo?.(); } catch {} });
    admPending = [];
    const settingsWereDirty = admDirtySettings;
    admDirtySettings = false;
    if (settingsWereDirty) await rerender(); else updateSaveBar();
  });
  updateSaveBar();
  const logCell = view.querySelector('[data-cell="activity"]');
  if (logCell) {
    const mount = () => {
      if (logCell.dataset.mounted) return;
      logCell.dataset.mounted = "1";
      mountLogFeed($("#admLogFeed"), { tok: session.adminToken, canFilter: true, players: A.roster.players });
    };
    logCell.addEventListener("toggle", mount);
    if (logCell.open) mount();
  }
  $$("[data-persona]").forEach((b) => b.addEventListener("click", () => {
    const box = $("#cfgHostPersona"); if (!box) return;
    const preset = (A.hostPersonas || []).find((x) => x.id === b.dataset.persona);
    if (!preset && b.dataset.persona !== "__clear") return;
    if (box.value.trim() && !confirm(preset ? `Replace what's in the box with "${preset.name}"?` : "Clear the box and go back to the voice he shipped with?")) return;
    box.value = preset ? preset.text : "";
    $("#personaBlurb").textContent = preset ? preset.blurb : "The voice he shipped with.";
    admDirtySettings = true; updateSaveBar();
    box.scrollIntoView({ block: "center", behavior: "smooth" });
  }));
  $$("[data-hostop]").forEach((b) => b.addEventListener("click", async () => {
    const op = b.dataset.hostop;
    const out = $("#hostResult");
    b.disabled = true;
    try {
      if (op === "now") {
        out.textContent = "Thinking…";
        const r = await api("/api/host/tick", { token: session.adminToken, force: true });
        out.innerHTML = r.posted ? `Posted: “${esc(r.line)}”` : `He passed. ${r.hooks?.length ? `Hooks: ${esc(r.hooks.join("; "))}` : "Nothing going on."}`;
      } else {
        await adminOp("hostSet", op === "mute" ? { muteHours: 24 } : { on: op === "on" }, { reload: false });
        await rerender(op === "mute" ? "Host muted for 24 hours" : op === "on" ? "Host is on" : "Host is off");
        return;
      }
    } catch (e) { out.textContent = e.message; }
    b.disabled = false;
  }));
  $$("[data-remsend]").forEach((b) => b.addEventListener("click", async () => {
    const mode = b.dataset.remsend;
    const missingOnly = mode === "missing";
    const test = mode === "test";
    const force = $("#remForce")?.checked || false;
    if (!test && !confirm(`Email ${missingOnly ? "every household still missing a pick" : "every head of household"} their Week ${curWeek} reminder now?`)) return;
    b.disabled = true;
    const out = $("#remResult");
    out.textContent = "Sending…";
    try {
      const r = await api("/api/reminders/send", { token: session.adminToken, missingOnly, force, test });
      if (r.test) out.innerHTML = r.failed.length ? `Test failed: ${esc(r.failed[0].error)}` : `Test sent to <b>${esc(r.to)}</b> from ${esc(r.from)} (built from ${esc(r.basedOn)}'s slots). Check the inbox, then spam.`;
      else if (r.skipped) out.innerHTML = `Already sent this week (${timeAgo(r.sentAt)}). Tick the resend box to send again.`;
      else out.innerHTML = `<b>${r.sent.length} sent</b>, ${r.failed.length} failed. Skipped: ${r.skippedNoEmail.length} no email, ${r.skippedOptedOut.length} opted out, ${r.skippedInactive.length} eliminated.${r.failed.length ? `<br>Failed: ${esc(r.failed.map((f) => `${f.name} (${f.error})`).join("; "))}` : ""} Summary emailed to you.`;
    } catch (e) { out.textContent = e.message; }
    b.disabled = false;
  }));
  // Structural actions still apply right away (they need the server's answer), but
  // they save any staged edits first and redraw in place instead of jumping to the top.
  $$("[data-newpin]").forEach((b) => b.addEventListener("click", async () => {
    const custom = prompt(`New PIN for ${b.dataset.pname} (4-8 digits).\nLeave blank for a random one. Their household syncs to it.`, "");
    if (custom === null) return;
    if (custom.trim() && !/^\d{4,8}$/.test(custom.trim())) return toast("PIN must be 4 to 8 digits");
    if (!(await ensureSaved())) return;
    try { const r = await adminOp("resetPin", { playerId: b.dataset.newpin, ...(custom.trim() ? { pin: custom.trim() } : {}) }); toast(`PIN for ${b.dataset.pname}: ${r.pin ?? "set"}`, 6000); await rerender(); } catch (e) { toast(e.message); }
  }));
  $$("[data-addslot]").forEach((b) => b.addEventListener("click", async () => {
    if (!(await ensureSaved())) return;
    try { await adminOp("addSlot", { playerId: b.dataset.addslot }); rerender("Slot added"); } catch (e) { toast(e.message); }
  }));
  $$("[data-rmslot]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm(`Remove the slot "${b.dataset.rmslotlabel}"? Its picks and payments go with it. This can't be undone.`)) return;
    if (!(await ensureSaved())) return;
    try { await adminOp("removeSlot", { slotId: b.dataset.rmslot }); rerender("Slot removed"); } catch (e) { toast(e.message); }
  }));
  $$("[data-rmplayer]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm(`Remove ${b.dataset.rmname} and all their slots, picks, and payments? This can't be undone.`)) return;
    if (!(await ensureSaved())) return;
    try { await adminOp("removePlayer", { playerId: b.dataset.rmplayer }); rerender("Player removed"); } catch (e) { toast(e.message); }
  }));
  $("#apGo").addEventListener("click", async () => {
    if (!(await ensureSaved())) return;
    try { await adminOp("addPlayer", { name: $("#apName").value, email: $("#apEmail").value, slots: Number($("#apSlots").value) }); rerender("Player added"); }
    catch (e) { toast(e.message); }
  });
  const fillFpTeams = async () => {
    const wk = Math.min(Math.max(Number($("#fpWeek").value) || curWeek, 1), 18);
    try {
      const sc = await loadScores(wk);
      const teams = [...new Set((sc.games || []).flatMap((g) => [g.home?.name, g.away?.name]).filter(Boolean))].sort();
      $("#fpTeam").innerHTML = teams.map((t) => `<option>${esc(t)}</option>`).join("") || `<option value="">no schedule yet</option>`;
    } catch { $("#fpTeam").innerHTML = `<option value="">schedule unavailable</option>`; }
  };
  fillFpTeams();
  $("#fpWeek").addEventListener("change", fillFpTeams);
  $("#fpGo").addEventListener("click", async () => {
    try {
      await api("/api/pick", { token: session.adminToken, slotId: $("#fpSlot").value, week: Number($("#fpWeek").value), team: $("#fpTeam").value.trim() });
      DB.state = null; toast("Pick set ✓");
    } catch (e) { toast(e.message); }
  });
  $("#fpClear").addEventListener("click", async () => {
    try { await adminOp("clearPick", { slotId: $("#fpSlot").value, week: Number($("#fpWeek").value) }, { reload: false }); toast("Pick cleared"); } catch (e) { toast(e.message); }
  });
  $("#cfgSave").addEventListener("click", async () => {
    try { await saveSettings(); toast("Settings saved ✓"); updateSaveBar(); } catch (e) { toast(e.message, 6000); }
  });
}

/* ---------- router ---------- */
const routes = {
  standings: renderStandings, scores: renderScores, picks: renderPicks, money: renderMoney,
  log: renderLog, rules: renderRules, hof: renderHof, join: renderJoin, more: renderMore,
  admin: renderAdmin, login: renderLogin, account: renderAccount, demo: renderDemo, chat: renderChat,
  install: renderInstall,
};
function currentRoute() {
  const h = location.hash.replace(/^#\//, "").split("?")[0];
  return routes[h] ? h : "standings";
}
async function render(opts = {}) {
  const keepScroll = opts && opts.scroll === false; // poll refreshes must not yank the page to the top
  const y = window.scrollY;
  const r = currentRoute();
  renderSeq++; // a navigation supersedes any page still loading
  if (admSkipRender) { admSkipRender = false; return; }
  if (lastRoute === "admin" && r !== "admin" && session.adminToken && admUnsavedCount()) {
    const n = admUnsavedCount();
    if (!confirm(`You have ${n} unsaved desk change${n === 1 ? "" : "s"}. Leave without saving?`)) { admSkipRender = true; location.hash = "#/admin"; return; }
    admPending = []; admDirtySettings = false;
  }
  if (r === "login" && lastRoute && !["login", "join", "account"].includes(lastRoute)) returnAfterLogin = lastRoute;
  lastRoute = r;
  renderSession();
  $$("#topnav a, #tabbar a").forEach((a) => a.classList.toggle("active", a.dataset.route === r || (r === "standings" && a.dataset.route === "standings")));
  if (!keepScroll) view.innerHTML = `<div class="loading">Loading…</div>`;
  try { await routes[r](); }
  catch (e) {
    if (e.status === 503 && /not initialized/i.test(e.message)) return renderSetup(); // fresh deploy
    view.innerHTML = `<div class="card"><h2>Hmm.</h2><p class="muted">${esc(e.message)}</p><button class="btn" onclick="location.reload()">Reload</button></div>`;
  }
  if (currentRoute() !== r) return render(opts); // a slow view finished after the user moved on
  if (keepScroll) window.scrollTo(0, y);
  else window.scrollTo(0, 0);
}
window.addEventListener("hashchange", render);

/* Poll while games are live or a kickoff just passed; gentle otherwise. */
setInterval(async () => {
  if (document.hidden) return;
  if (["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return; // someone is typing; leave the page alone
  if (typeof window.__chatReload === "function" && $("#chatList")) window.__chatReload();
  else if (DB.chatTease !== undefined) loadChatTease().catch(() => {}); // badge only; the 90s cache decides whether this actually fetches
  if (!DB.state) return;
  const s = DB.state.snapshot;
  const hot = s?.liveNow || (s?.nextKickoff && new Date() >= new Date(s.nextKickoff));
  const idleFor = Date.now() - DB.stateAt;
  if (hot || idleFor > 5 * 60 * 1000) {
    const before = DB.stateSig;
    await loadState(true).catch(() => {});
    const r = currentRoute();
    const changed = DB.stateSig !== before;
    if (r === "scores" && scoresWeek && hot) DB.scoresAt[scoresWeek] = 0; // live scores move even when the league state doesn't
    const redraw = ["standings", "scores", "money"].includes(r) || (r === "picks" && !openSlate);
    if (redraw && (changed || (r === "scores" && hot))) render({ scroll: false });
  }
}, 45000);
document.addEventListener("visibilitychange", () => {
  if (document.hidden || !DB.state || Date.now() - DB.stateAt <= 60000) return;
  const r = currentRoute();
  loadState(true).then(() => {
    // Forms (join, login, account, chat, desk) keep whatever is being typed.
    if (["standings", "scores", "money", "picks"].includes(r) && currentRoute() === r && !(r === "picks" && openSlate)) render({ scroll: false });
  }).catch(() => {});
});

render();
