/* Client smoke tests: does the page actually come up?

   The rules and API suites prove the math. Neither of them ever renders
   app.js, so a refactor that deletes a function the board calls passes every
   test and ships a blank page with an error card on it. That happened. This
   loads the real index.html and the real app.js in jsdom, serves fixture API
   responses, and walks every route asserting the view rendered something real.

   render() catches its own errors into a "Hmm." card, so an exception does not
   reach us: the assertion is that the card is NOT there.

   The limit worth knowing: the API responses here are fixtures, so a change to
   the real payload shape passes this suite and still breaks the page. This
   catches the page failing to draw, not the server lying to it.

   Run: node scripts/test-client.mjs */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

let passed = 0, failed = 0;
function check(name, cond, extra = "") {
  if (cond) passed++;
  else { failed++; console.error(`FAIL: ${name} ${extra}`); }
}

/* ---- fixture league: every state the board has to draw ----
   Two weeks graded, a live-ish current week, one slot of each standing, an
   unpaid tab, and contacts with and without an email. */
const WEEK = 3;
const iso = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const wk = (team, result, extra = {}) => ({ team, result, locked: true, source: "player", ...extra });

const SLOTS = [
  { id: "s1", label: "Alpha (1)", playerId: "p1", playerName: "Alpha", status: "alive", eliminatedWeek: null, buybacksUsed: 0,
    weeks: { 1: wk("Seattle Seahawks", "win"), 2: wk("Kansas City Chiefs", "win"), 3: wk("Dallas Cowboys", "pending", { locked: false }) },
    usedTeams: ["Seattle Seahawks", "Kansas City Chiefs"], openLoss: null, buybackDeadline: null },
  { id: "s2", label: "Bravo (1)", playerId: "p2", playerName: "Bravo", status: "buyback-available", eliminatedWeek: null, buybacksUsed: 0,
    weeks: { 1: wk("Denver Broncos", "win"), 2: wk("New York Jets", "loss", { buyback: "available", buybackBy: iso(48) }) },
    usedTeams: ["Denver Broncos", "New York Jets"], openLoss: { lossWeek: 2, deadline: iso(48) }, buybackDeadline: iso(48) },
  { id: "s3", label: "Charlie (1)", playerId: "p3", playerName: "Charlie", status: "dead", eliminatedWeek: 2, buybacksUsed: 1,
    weeks: { 1: wk("Chicago Bears", "loss", { buyback: "confirmed" }), 2: wk("New York Giants", "loss", { buyback: "expired" }) },
    usedTeams: ["Chicago Bears", "New York Giants"], openLoss: null, buybackDeadline: null },
  { id: "s4", label: "Delta (1)", playerId: "p1", playerName: "Alpha", status: "alive", eliminatedWeek: null, buybacksUsed: 0,
    weeks: { 1: wk("Green Bay Packers", "win"), 2: wk("Detroit Lions", "win"), 3: { hidden: true } },
    usedTeams: ["Green Bay Packers", "Detroit Lions"], openLoss: null, buybackDeadline: null },
  // Bought back in time, but the money never landed by the deadline: the desk must chase it.
  { id: "s6", label: "Foxtrot (1)", playerId: "p2", playerName: "Bravo", status: "buyback-pending", eliminatedWeek: null, buybacksUsed: 0,
    weeks: { 1: wk("Tennessee Titans", "loss", { buyback: "pending", buybackBy: iso(-50) }), 2: wk("Carolina Panthers", "win") },
    usedTeams: ["Tennessee Titans", "Carolina Panthers"], openLoss: { lossWeek: 1, deadline: null }, buybackDeadline: null },
  // The logged-in player's own loss, not bought back: the slot must lock until they do.
  { id: "s5", label: "Echo (1)", playerId: "p1", playerName: "Alpha", status: "buyback-available", eliminatedWeek: null, buybacksUsed: 0,
    weeks: { 1: wk("Miami Dolphins", "win"), 2: wk("New York Giants", "loss", { buyback: "available", buybackBy: iso(30) }) },
    usedTeams: ["Miami Dolphins", "New York Giants"], openLoss: { lossWeek: 2, deadline: iso(30) }, buybackDeadline: iso(30) },
];

const STATE = {
  snapshot: {
    season: 2026, week: WEEK, liveNow: false, builtAt: new Date().toISOString(),
    aliveCount: 2, limboCount: 1, deadCount: 1, totalSlots: 4,
    pot: { total: 50, entries: 4, buybackCash: 10, buybacks: 1, buyIn: 10 },
    buybackDeadline: iso(48), nextKickoff: iso(20), slots: SLOTS,
  },
  owed: [{ slotId: "s1", buyin: 10, buybackWeeks: [2], total: 20 }],
  cfg: {
    seasonYear: 2026, leagueName: "Test Survivor League", buyIn: 10, buybackFee: 10, suddenDeathWeek: 4,
    totalWeeks: 18, maxSlotsPerPlayer: 3, venmo: "test-commish", joinOpen: true,
    rulesText: "PICKS AND LOCKING\n1. Pick one team a week.\n2. Never the same team twice.\nMONEY\n3. $10 a slot.",
    hallOfFame: [{ year: 2025, champions: ["Alpha"], flawless: ["Bravo"] }],
    contacts: [{ name: "Pat Commish", phone: "(555) 555-0100" }, { name: "Sam Commish", phone: "(555) 555-0101", email: "sam@example.com" }],
    leagueNote: "Pay up.", joinNote: "", hostName: "The Host",
  },
  players: [{ id: "p1", name: "Alpha", managedBy: null }, { id: "p2", name: "Bravo", managedBy: null }, { id: "p3", name: "Charlie", managedBy: "p1" }],
  serverNow: new Date().toISOString(), appVersion: readFileSync(new URL("../public/app.js", import.meta.url), "utf8").match(/const APP_BUILD = "([^"]+)"/)[1],
  hostReady: true, mailReady: true,
  contactCoverage: { players: 3, withEmail: 2, withPhone: 3, missingEmailHeads: [] },
};

const game = (id, away, home, hrs, done, winner) => ({
  id, date: iso(hrs), completed: done, state: done ? "post" : "pre",
  away: { name: away, abbr: away.slice(0, 3).toUpperCase(), score: done ? 17 : null, winner: done && winner === away },
  home: { name: home, abbr: home.slice(0, 3).toUpperCase(), score: done ? 24 : null, winner: done && winner === home },
  odds: { details: "SEA -3.5", overUnder: 44.5, provider: "TestBook" }, detail: done ? "Final" : "Sun 1:00 PM",
});
const SCORES = {
  1: { week: 1, games: [game("g1", "New England Patriots", "Seattle Seahawks", -300, true, "Seattle Seahawks"), game("g2", "Chicago Bears", "Green Bay Packers", -298, true, "Green Bay Packers")] },
  2: { week: 2, games: [game("g3", "New York Jets", "Kansas City Chiefs", -150, true, "Kansas City Chiefs"), game("g4", "New York Giants", "Detroit Lions", -148, true, "Detroit Lions")] },
  3: { week: 3, games: [game("g5", "Dallas Cowboys", "Arizona Cardinals", 20, false), game("g6", "Miami Dolphins", "Buffalo Bills", 22, false)] },
};

const ADMIN_FULL = {
  cfg: STATE.cfg,
  roster: { players: [{ id: "p1", name: "Alpha", pin: "1234", email: "a@test.com", phone: "", emailOff: false }, { id: "p2", name: "Bravo Person", pin: "5678", email: "", phone: "(555) 555-0123" }, { id: "p3", name: "Charlie", pin: "9012", email: "", phone: "", managedBy: "p1" }] },
  slots: { slots: SLOTS.map((s) => ({ id: s.id, label: s.label, playerId: s.playerId })) },
  payments: { entries: [{ id: "pay1", slotId: "s1", type: "buyin", amount: 10, ts: new Date().toISOString() }, { id: "pay2", slotId: "s3", type: "buyback", week: 1, amount: 10, revivalId: "r1", ts: new Date().toISOString() }] },
  revivals: { entries: [{ id: "r1", slotId: "s3", lossWeek: 1, status: "confirmed", grantedBy: "commissioner" }, { id: "r2", slotId: "s2", lossWeek: 2, status: "pending", requestedTs: new Date().toISOString() }, { id: "r3", slotId: "s6", lossWeek: 1, status: "pending", requestedTs: iso(-60) }] },
  overrides: {}, snapshot: STATE.snapshot, adminPinWeak: false,
  hostPersonas: [{ id: "roast", name: "Roast", blurb: "The default", text: "Voice: loud." }, { id: "noir", name: "Noir", blurb: "Rain", text: "Voice: rain." }],
  host: { configured: true, name: "The Host", on: true, muteUntil: null, repliesToday: 1, attemptsToday: 3, unpromptedToday: 0, lastUnpromptedAt: null, lastLine: "Torches out.", lastError: null },
  mail: { ready: true, missing: [], from: "x@y.z", summaryTo: "" },
};

const ROUTES = {
  "/api/state": STATE,
  "/api/news": { items: [{ headline: "Test headline", link: "https://espn.com/x", source: "espn" }] },
  "/api/winprob": { week: WEEK, teams: {} },
  "/api/chat": { messages: [{ ts: new Date().toISOString(), name: "Alpha", text: "hello" }] },
  "/api/log": { scope: "mine", entries: [{ ts: new Date().toISOString(), action: "pick", actor: "Alpha", actorId: "p1", slotId: "s1", slotLabel: "Alpha (1)", week: 3, after: "Dallas Cowboys" }], nextCursor: null },
  "/api/admin/full": ADMIN_FULL,
  "/api/reminder": { week: WEEK, rows: [], firstGame: null, lastGame: null },
};

let unhandled = [];
let calls = []; // every request the page made: [{ path, body }]
function makeFetch(win) {
  return async (path, opts = {}) => {
    const url = new URL(String(path), "https://test.local");
    calls.push({ path: url.pathname, body: opts.body ? JSON.parse(opts.body) : null });
    let body = ROUTES[url.pathname];
    if (url.pathname === "/api/scores") body = SCORES[Number(url.searchParams.get("week")) || WEEK];
    if (body === undefined) body = {};
    return {
      ok: true, status: 200,
      json: async () => JSON.parse(JSON.stringify(body)),
      text: async () => JSON.stringify(body),
    };
  };
}

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8").replace(/<script src="\/app\.js"><\/script>/, "");
const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

async function boot({ admin = false, player = false, fetchImpl = null } = {}) {
  const dom = new JSDOM(html, { url: "https://test.local/#/", runScripts: "dangerously", pretendToBeVisual: true });
  const win = dom.window;
  unhandled = [];
  win.addEventListener("error", (e) => unhandled.push(String(e.message || e.error)));
  win.addEventListener("unhandledrejection", (e) => unhandled.push(String(e.reason)));
  win.fetch = fetchImpl || makeFetch(win);
  win.Element.prototype.scrollIntoView = function () {};          // jsdom has no layout
  win.matchMedia = (q) => ({ matches: /min-width: 900px/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  win.scrollTo = () => {};
  win.confirm = () => true;
  win.alert = () => {};
  win.prompt = () => "x";
  if (player) { win.localStorage.setItem("sl_token", "t"); win.localStorage.setItem("sl_playerId", "p1"); win.localStorage.setItem("sl_name", "Alpha"); }
  if (admin) win.localStorage.setItem("sl_admin", "adm");
  const tag = win.document.createElement("script");
  tag.textContent = appJs;
  win.document.body.appendChild(tag);
  await new Promise((r) => setTimeout(r, 0));
  return { dom, win };
}

const viewHTML = (win) => win.document.querySelector("#view").innerHTML;
const broke = (win) => /<h2>Hmm\.<\/h2>/.test(viewHTML(win)); // render() catches into this card

async function go(win, hash) {
  win.location.hash = hash;
  await win.render();
  await new Promise((r) => setTimeout(r, 10)); // let any deferred fill land
}

/* ---- a fresh deploy has no league: the page offers to create one ---- */
{
  let created = null;
  const fresh = async (path, opts = {}) => {
    const url = new URL(String(path), "https://test.local");
    if (url.pathname === "/api/bootstrap") {
      created = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({ ok: true, adminToken: "fresh" }) };
    }
    return { ok: false, status: 503, json: async () => ({ error: "League not initialized yet." }) };
  };
  const { dom, win } = await boot({ fetchImpl: fresh });
  await go(win, "#/");
  const q = (s) => win.document.querySelector(s);
  check("no league yet: setup form, not an error card", !!q("#suGo") && !broke(win), viewHTML(win).slice(0, 200));
  q("#suName").value = "Test League"; q("#suPin").value = "short";
  q("#suGo").click();
  await new Promise((r) => setTimeout(r, 20));
  check("setup refuses a short admin PIN", created === null);
  q("#suPin").value = "long enough pin"; q("#suCName").value = "Pat"; q("#suCPhone").value = "(555) 555-0100";
  q("#suGo").click();
  await new Promise((r) => setTimeout(r, 20));
  check("setup posts the league", created?.leagueName === "Test League" && created.adminPin === "long enough pin" && created.contacts?.[0]?.name === "Pat" && created.buyIn === 10, JSON.stringify(created));
  check("setup signs the commissioner in", win.localStorage.getItem("sl_admin") === "fresh");
  dom.window.close();
}

/* ---- every route comes up, logged out ---- */
{
  const { dom, win } = await boot();
  for (const [hash, name] of [
    ["#/", "standings"], ["#/scores", "scores"], ["#/picks", "picks"], ["#/money", "money"],
    ["#/log", "log"], ["#/rules", "rules"], ["#/hof", "hall of fame"], ["#/join", "join"],
    ["#/more", "more"], ["#/chat", "chat"], ["#/login", "login"], ["#/demo", "demo"], ["#/account", "account"], ["#/install", "install"],
  ]) {
    await go(win, hash);
    check(`${name} renders`, !broke(win) && viewHTML(win).length > 150, `${viewHTML(win).slice(0, 160)}`);
  }
  check("no uncaught errors logged out", unhandled.length === 0, unhandled.join(" | "));
  await go(win, "#/more");
  check("More links to the phone how-to", /href="#\/install"/.test(viewHTML(win)));
  await go(win, "#/install");
  check("the how-to page carries the written steps", !/<video/.test(viewHTML(win)) && /Add to Home Screen/.test(viewHTML(win)));
  dom.window.close();
}

/* ---- the same walk as a logged-in player, where the picker and the tab show ---- */
{
  const { dom, win } = await boot({ player: true });
  for (const [hash, name] of [["#/", "standings"], ["#/picks", "picks"], ["#/money", "money"], ["#/log", "log"], ["#/account", "account"]]) {
    await go(win, hash);
    check(`${name} renders for a player`, !broke(win) && viewHTML(win).length > 150, viewHTML(win).slice(0, 160));
  }
  await go(win, "#/picks");
  check("the picker shows the slot cards", /Alpha \(1\)/.test(viewHTML(win)), viewHTML(win).slice(0, 200));
  check("an unpaid tab shows what you owe", /You owe/.test(viewHTML(win)), viewHTML(win).slice(0, 200));
  await go(win, "#/money");
  check("the pot page carries the tab too", /You owe/.test(viewHTML(win)));

  // A loss nobody bought back: the card offers Buy back and nothing else.
  await go(win, "#/picks");
  const echo = win.document.querySelector('[data-card="s5"]');
  check("bb: the locked slot has its Buy back button", !!echo?.querySelector('[data-buyback="s5"][data-loss="2"]'), echo?.outerHTML.slice(0, 300));
  check("bb: the locked slot offers no way to pick", echo && !echo.querySelector("[data-openslate]") && !echo.querySelector("[data-unpick]"), echo?.outerHTML.slice(0, 300));
  check("bb: the card says why", /Picks are locked until you buy back/.test(echo?.textContent || ""), echo?.textContent);
  check("bb: and holds no pick for the week", /No week 3 pick\. Buy back, then pick\./.test(echo?.textContent || ""), echo?.textContent);
  check("bb: an unlocked slot still picks", !!win.document.querySelector('[data-card="s1"] [data-openslate="s1"]'));

  // Cards fold from their bar: open when the slot needs you, folded when the pick is in.
  const card = (id) => win.document.querySelector(`details[data-pk="${id}"]`);
  check("fold: every slot is a card that folds", ["s1", "s4", "s5"].every((id) => card(id)?.tagName === "DETAILS" && card(id).querySelector(":scope > summary")));
  check("fold: a slot that has to buy back starts open", card("s5")?.open === true);
  check("fold: a slot with its pick in starts folded", card("s1")?.open === false);
  check("fold: the folded bar still shows the pick", /DAL/.test(card("s1")?.querySelector("summary")?.textContent || ""), card("s1")?.querySelector("summary")?.textContent);
  check("fold: the folded bar of a locked slot says to buy back", /Buy back/.test(card("s5")?.querySelector("summary")?.textContent || ""));
  card("s1").open = true;
  card("s1").dispatchEvent(new win.Event("toggle"));
  check("fold: opening a card is remembered for that week", win.localStorage.getItem("sl_pk_s1_w3") === "1");
  await go(win, "#/picks");
  check("fold: and survives a redraw", card("s1")?.open === true);
  card("s1").querySelector('[data-openslate="s1"]')?.dispatchEvent(new win.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
  check("fold: Change opens the week's games inside that card", card("s1")?.open === true && !!card("s1")?.querySelector(".slate [data-pick]"), card("s1")?.outerHTML.slice(0, 200));
  card("s1").open = false;
  card("s1").dispatchEvent(new win.Event("toggle"));
  await go(win, "#/picks");
  check("fold: folding the card puts its games away", !card("s1")?.querySelector(".slate"));

  // Buy back asks a second time, on a slip, not the browser's alert. No means nothing gets sent.
  let alerted = false;
  win.confirm = () => { alerted = true; return true; };
  calls = [];
  card("s5").querySelector("[data-buyback]").dispatchEvent(new win.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  const slip = win.document.querySelector(".bbslip");
  check("bb: Buy back opens the slip, not an alert box", !!slip && !alerted);
  check("bb: the slip shows the slot, the loss, and the fee before anything happens", /Echo \(1\)/.test(slip?.textContent || "") && /Week 2 · New York Giants/.test(slip?.textContent || "") && /\$10/.test(slip?.textContent || "") && /Venmo @test-commish/.test(slip?.textContent || ""), slip?.textContent);
  check("bb: opening the slip sends nothing", !calls.some((c) => c.path === "/api/buyback"), JSON.stringify(calls));
  slip?.parentElement.querySelector("[data-slipclose].bbslip-no")?.dispatchEvent(new win.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  check("bb: Not now closes it and sends nothing", !win.document.querySelector(".bbslip") && !calls.some((c) => c.path === "/api/buyback"), JSON.stringify(calls));
  card("s5").querySelector("[data-buyback]").dispatchEvent(new win.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  win.document.querySelector("[data-slipgo]")?.dispatchEvent(new win.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  const sent = calls.find((c) => c.path === "/api/buyback");
  check("bb: confirming records the buy-back for that loss", sent?.body?.slotId === "s5" && sent?.body?.lossWeek === 2, JSON.stringify(calls));
  check("bb: then the slip says you're back in", /You're back in/.test(win.document.querySelector('.bbslip [data-step="done"]:not([hidden])')?.textContent || ""));
  win.document.querySelector("[data-slipdone]")?.dispatchEvent(new win.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  check("bb: and Pick week 3 closes it", !win.document.querySelector(".bbslip"));
  check("no uncaught errors on the picks page", unhandled.length === 0, unhandled.join(" | "));
  dom.window.close();
}

/* ---- the board's three cells, the thing that broke ---- */
{
  const { dom, win } = await boot();
  await go(win, "#/");
  const v = viewHTML(win);
  check("season cell is there", /data-cell-key="season"/.test(v));
  check("recaps cell is there", /data-cell-key="recaps"/.test(v));
  check("current week cell is there and open", /data-cell-key="thisweek"[^>]*open/.test(v), v.match(/data-cell-key="thisweek"[^>]*/)?.[0]);
  check("the pot ledger adds up on screen", /Pot total/.test(v) && /entries × /.test(v));
  check("the status ledger lists every standing", ["Safe", "Vulnerable", "In limbo", "Out", "Slots"].every((w) => v.includes(w)));
  // "No pick" is two jobs: Foxtrot (bought back, unpaid) just needs a pick;
  // Bravo and Echo lost last week and must buy back first.
  check("the week cell splits who needs a pick from who must buy back", /No pick yet · still alive[\s\S]{0,320}>1</.test(v) && /lost last week, buy back first[\s\S]{0,320}>2</.test(v), (v.match(/No pick yet[\s\S]{0,400}/) || [""])[0]);
  check("the filter offers both groups with counts", /value="needpick"[^>]*>✍️ Needs a pick \(1\)/.test(v) && /value="needbuy"[^>]*>💸 Buy back, then pick \(2\)/.test(v));
  const rowOf = (label) => [...win.document.querySelectorAll("table.grid tbody tr")].find((tr) => tr.textContent.includes(label))?.innerHTML || "";
  check("a slot that only owes a pick says so on the board", /Needs a pick/.test(rowOf("Foxtrot (1)")) && !/Buy back \+ pick/.test(rowOf("Foxtrot (1)")));
  check("a slot that lost last week says buy back first", /Buy back \+ pick/.test(rowOf("Bravo (1)")) && /Buy back \+ pick/.test(rowOf("Echo (1)")));
  check("a slot with its pick in owes nothing", !/Needs a pick|Buy back \+ pick/.test(rowOf("Alpha (1)")));
  check("the legend explains both", /✍️ Needs a pick<\/span>no pick yet this week/.test(v) && /💸 Buy back \+ pick<\/span>lost last week/.test(v));
  check("the board points at the phone how-to, near the top", /<div class="installnudge"><a href="#\/install">/.test(v) && v.indexOf("installnudge") < v.indexOf('data-cell-key="season"'));
  win.document.querySelector("[data-nudgex]")?.dispatchEvent(new win.Event("click", { bubbles: true }));
  check("closing the pointer hides it", !win.document.querySelector(".installnudge") && win.localStorage.getItem("sl_nudge_install") === "0");
  await go(win, "#/");
  check("and it stays closed", !win.document.querySelector(".installnudge"));

  // Opening the recaps cell fills it: counts first, then the underdog line.
  const cell = win.document.querySelector('[data-cell-key="recaps"]');
  check("the recaps cell can be opened", !!cell);
  if (cell) {
    cell.open = true;
    cell.dispatchEvent(new win.Event("toggle"));
    await new Promise((r) => setTimeout(r, 30));
  }
  const body = win.document.querySelector("#recapBody")?.innerHTML ?? "";
  check("the recap body fills with the week's grade", /Survived the week/.test(body), body.slice(0, 200));
  check("the deferred spread row lands", /Riskiest pick that lived/.test(body) || !/Chalkiest/.test(body), body.slice(0, 300));

  // Switching weeks reloads that week without leaving the other one on screen.
  const pills = [...win.document.querySelectorAll("[data-recapweek]")];
  check("a pill per graded week", pills.length === 2, String(pills.length));
  if (pills.length) {
    pills.at(-1).dispatchEvent(new win.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    check("the pills switch weeks", win.document.querySelector("[data-recapweek].primary")?.dataset.recapweek === pills.at(-1).dataset.recapweek);
  }
  check("no uncaught errors on the board", unhandled.length === 0, unhandled.join(" | "));
  dom.window.close();
}

/* ---- the commissioner desk, every cell of it ---- */
{
  const { dom, win } = await boot({ admin: true });
  await go(win, "#/admin");
  const v = viewHTML(win);
  check("the desk renders", !broke(win) && v.length > 500, v.slice(0, 200));
  for (const cell of ["buybacks", "paid", "activity", "host", "settings", "roster"]) {
    check(`desk cell: ${cell}`, v.includes(`data-cell="${cell}"`), v.slice(0, 120));
  }
  check("undeclared losses are listed to mark", /data-adm="grantRevival"/.test(v));
  const secs = [...win.document.querySelectorAll('[data-cell="buybacks"] details.bbsec')];
  check("buy-backs split into five boxed sections when money is late", secs.length === 5, String(secs.length));
  check("late money is the first thing in the panel", /Late: collect now/.test(secs[0]?.querySelector(".bbsec-h")?.textContent || ""), secs[0]?.textContent.slice(0, 80));
  check("the panel header leads with the late count, in red", /💸 Buy-backs\s*<span class="badge miss">1 late<\/span>/.test(win.document.querySelector('[data-cell="buybacks"] > summary')?.innerHTML || ""), win.document.querySelector('[data-cell="buybacks"] > summary')?.innerHTML);
  const lateRow = secs[0]?.querySelector(".admin-row");
  check("a late row says how late and when it was due", /Foxtrot \(1\)/.test(lateRow?.textContent || "") && /2 days late/.test(lateRow?.textContent || "") && /was due/.test(lateRow?.textContent || ""), lateRow?.textContent.replace(/\s+/g, " "));
  const txt = lateRow?.querySelector('a[href^="sms:"]')?.getAttribute("href") || "";
  check("a late row texts the payer with the ask already written", txt.startsWith("sms:5555550123?&body=") && /Hey%20Bravo%2C.*is%20late/.test(txt) && /Venmo%20%40test-commish/.test(txt), txt);
  check("a late row can be marked paid or denied", !!lateRow?.querySelector('[data-adm="confirmRevival"]') && !!lateRow?.querySelector('[data-adm="denyRevival"]'));
  check("a late buy-back is not also listed as waiting", !/Foxtrot/.test(secs[1]?.textContent || ""));
  check("no phone number is printed on the desk's late row", !/555-0123/.test(lateRow?.textContent || ""));
  for (const [title, def] of [["Late: collect now", /rules say it has to be/], ["Waiting on their $10", /due by their deadline/], ["Lost, not bought back yet", /their picks are locked/], ["Out: window closed", /slot is out/], ["Bought back", /back in the pool/]]) {
    const sec = secs.find((d) => d.querySelector(".bbsec-h")?.textContent.includes(title));
    check(`section "${title}" has its definition`, !!sec && def.test(sec.querySelector(".bbsec-def")?.textContent || ""), sec?.querySelector("summary")?.textContent);
  }
  check("only the money sections start open", secs.filter((d) => d.open).length === 2 && secs[0].open && secs[1].open);
  check("a waiting buy-back shows its due date", /due /.test(secs[1].querySelector(".rows")?.textContent || "") && !/was due/.test(secs[1].textContent), secs[1].textContent.replace(/\s+/g, " ").slice(0, 300));
  check("the sweep list no longer says money landed", !/Money landed in Venmo/.test(v));
  check("buying back for someone is not a primary button", !/class="btn sm primary" data-adm="grantRevival"/.test(v));
  check("a window-closed row offers only the exception", /data-closed="1">Bring back anyway/.test(v));
  let askedDesk = "";
  win.confirm = (q) => { askedDesk = q; return false; };
  win.document.querySelector('[data-adm="grantRevival"]:not([data-closed])').dispatchEvent(new win.Event("click", { bubbles: true }));
  check("buying back for someone asks first", /Only if they asked you to/.test(askedDesk), askedDesk);
  check("saying no stages nothing", !win.document.querySelector('[data-marker^="revival:grantRevival"]'));
  win.confirm = () => true;
  win.document.querySelector('[data-adm="grantRevival"]:not([data-closed])').dispatchEvent(new win.Event("click", { bubbles: true }));
  check("saying yes stages it for Save", !!win.document.querySelector('[data-marker^="revival:grantRevival"]'));
  check("a confirmed buy-back can be undone", /data-adm="undoRevival"/.test(v));
  check("a pending request can still be confirmed", /data-adm="confirmRevival"/.test(v));
  check("the host's name and persona live in the host cell", /id="cfgHostPersona"/.test(v) && /id="cfgHostName"/.test(v));
  check("persona presets render as buttons", /data-persona="roast"/.test(v));
  check("the contacts editor is in settings", /id="cfgContacts"/.test(v) && /data-cf="email"/.test(v));
  check("host name is NOT in league settings any more", v.indexOf('id="cfgHostName"') < v.indexOf('data-cell="settings"'));

  // The activity cell loads its feed when opened, not on every desk render.
  const act = win.document.querySelector('[data-cell="activity"]');
  check("the activity cell can be opened", !!act);
  if (act) {
    act.open = true;
    act.dispatchEvent(new win.Event("toggle"));
    await new Promise((r) => setTimeout(r, 30));
  }
  check("the activity feed fills on open", /logrow|Nothing yet/.test(win.document.querySelector("#admLogFeed")?.innerHTML ?? ""));
  check("no uncaught errors on the desk", unhandled.length === 0, unhandled.join(" | "));
  dom.window.close();
}

/* ---- already on the home screen: no pointer to the how-to ---- */
{
  const { dom, win } = await boot();
  const base = win.matchMedia;
  win.matchMedia = (q) => (/display-mode: standalone/.test(q) ? { ...base(q), matches: true } : base(q));
  await go(win, "#/");
  check("no how-to pointer when the league already runs from the home screen", !win.document.querySelector(".installnudge") && /data-cell-key="season"/.test(viewHTML(win)));
  dom.window.close();
}

/* ---- contacts: a name and buttons, never a phone number ---- */
{
  const { dom, win } = await boot();
  await go(win, "#/rules");
  const v = viewHTML(win);
  check("contacts render as buttons", /href="sms:5555550100"/.test(v) && /💬 Text/.test(v), v.slice(-300));
  check("the email button shows only where there's an email", (v.match(/✉️ Email/g) || []).length === 1);
  check("no phone number is printed on the page", !/\(555\) 555-01/.test(win.document.body.textContent), win.document.body.textContent.slice(-200));
  dom.window.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
