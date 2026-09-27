/* Unit checks for the rules engine. Run: node scripts/test-rules.mjs */
import {
  evaluateSlot, validatePick, validateBuyback, currentWeek, computePot,
  defaultPick, resultForTeam, computeStandings, publicSlotView, standingOf, stalePickWeek,
} from "../lib/rules.mjs";

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; }
  else { failed++; console.error(`FAIL: ${name}`); }
}

const cfg = { seasonYear: 2026, totalWeeks: 18, buyIn: 10, buybackFee: 10, suddenDeathWeek: 4, maxSlotsPerPlayer: 3 };

let gid = 0;
function game(home, away, kickoffISO, { state = "pre", completed = false, hs = null, as = null, winner = null } = {}) {
  return {
    id: `g${++gid}`, date: kickoffISO, state, completed, detail: "",
    home: { name: home, abbr: home.slice(0, 3).toUpperCase(), score: hs, winner: winner === home },
    away: { name: away, abbr: away.slice(0, 3).toUpperCase(), score: as, winner: winner === away },
  };
}
const finalG = (home, away, iso, winner, hs = 24, as = 17) =>
  game(home, away, iso, { state: "post", completed: true, hs, as, winner });
const tieG = (home, away, iso) =>
  game(home, away, iso, { state: "post", completed: true, hs: 20, as: 20, winner: null });
const liveG = (home, away, iso, hs, as) =>
  game(home, away, iso, { state: "in", hs, as });

// Season fixture: weeks 1-4. Per-loss buy-back deadline = last kickoff of the
// FOLLOWING week: a W1 loss closes at W2 MNF (Sep 22), a W3 loss at W4 MNF (Oct 6).
const schedules = {
  1: { week: 1, games: [
    finalG("Seattle Seahawks", "New England Patriots", "2026-09-10T00:20Z", "Seattle Seahawks"),
    finalG("Los Angeles Rams", "San Francisco 49ers", "2026-09-11T00:35Z", "San Francisco 49ers"),
    finalG("Denver Broncos", "Tennessee Titans", "2026-09-13T20:05Z", "Denver Broncos"),
    finalG("Chicago Bears", "Minnesota Vikings", "2026-09-15T00:15Z", "Minnesota Vikings"), // MNF
  ] },
  2: { week: 2, games: [
    finalG("Green Bay Packers", "Washington Commanders", "2026-09-18T00:15Z", "Green Bay Packers"),
    tieG("Detroit Lions", "Chicago Bears", "2026-09-20T17:00Z"),
    finalG("Buffalo Bills", "New York Jets", "2026-09-20T17:00Z", "Buffalo Bills"),
    finalG("Kansas City Chiefs", "Philadelphia Eagles", "2026-09-22T00:15Z", "Kansas City Chiefs"),
  ] },
  3: { week: 3, games: [
    liveG("Dallas Cowboys", "New York Giants", "2026-09-27T17:00Z", 14, 10),
    game("Arizona Cardinals", "Los Angeles Chargers", "2026-09-27T20:25Z"),
    game("Baltimore Ravens", "Cleveland Browns", "2026-09-29T00:15Z"),
  ] },
  4: { week: 4, games: [
    game("Houston Texans", "Jacksonville Jaguars", "2026-10-04T17:00Z"),
    game("Miami Dolphins", "New Orleans Saints", "2026-10-06T00:15Z"), // wk4 MNF = deadline
  ] },
};
const now = new Date("2026-09-27T18:00Z"); // mid week 3 Sunday slate

const slot = { id: "s1", playerId: "p1", label: "Test Player" };

// 1. Straight wins + a tie counting as a win
{
  const ev = evaluateSlot({ slot, picks: {
    1: { team: "Denver Broncos" }, 2: { team: "Detroit Lions" }, 3: { team: "Arizona Cardinals" },
  }, revivals: [], schedules, overrides: {}, cfg, now });
  check("win graded", ev.weeks[1].result === "win");
  check("tie graded as win", ev.weeks[2].result === "win");
  check("future pick pending", ev.weeks[3].result === "pending");
  check("status alive", ev.status === "alive");
  check("used teams tracked", ev.usedTeams.join("|") === "Denver Broncos|Detroit Lions|Arizona Cardinals");
}

// 2. Live states
{
  const g = schedules[3].games[0];
  check("live leading", resultForTeam(g, "Dallas Cowboys") === "live-leading");
  check("live trailing", resultForTeam(g, "New York Giants") === "live-trailing");
}

// 3. Loss + buy-back flow
{
  const picks = { 1: { team: "New England Patriots" }, 2: { team: "Buffalo Bills" }, 3: { team: "Arizona Cardinals" } };
  const wNow = new Date("2026-09-16T18:00Z"); // mid week 2: the W1 loss's window is open
  const evNo = evaluateSlot({ slot, picks, revivals: [], schedules, overrides: {}, cfg, now: wNow });
  check("loss w1 -> buyback available during week 2", evNo.status === "buyback-available" && evNo.openLoss.lossWeek === 1);
  check("w1 loss deadline = w2 last kickoff", evNo.buybackDeadline === "2026-09-22T00:15:00.000Z" && evNo.weeks[1].buybackBy === "2026-09-22T00:15:00.000Z");
  const evPend = evaluateSlot({ slot, picks, revivals: [{ id: "r1", slotId: "s1", lossWeek: 1, status: "pending" }], schedules, overrides: {}, cfg, now: wNow });
  check("pending buyback status", evPend.status === "buyback-pending");
  const evOk = evaluateSlot({ slot, picks, revivals: [{ id: "r1", slotId: "s1", lossWeek: 1, status: "confirmed" }], schedules, overrides: {}, cfg, now: wNow });
  check("confirmed buyback revives", evOk.status === "alive" && evOk.buybacksUsed === 1);
  // League rule: lose W1, ghost W2, decide during W3? Tough. You're out.
  const evGhost = evaluateSlot({ slot, picks, revivals: [], schedules, overrides: {}, cfg, now });
  check("skip-a-week ghost -> dead once next week wraps", evGhost.status === "dead" && evGhost.eliminatedWeek === 1);
  // League rule (2026-09-25): tapping Buy back in time is what keeps the slot.
  // The money is still due by the deadline, but late money never kills it: the
  // slot keeps playing, In limbo, and the desk chases the late $.
  const evPendLate = evaluateSlot({ slot, picks, revivals: [{ id: "r1", slotId: "s1", lossWeek: 1, status: "pending" }], schedules, overrides: {}, cfg, now });
  check("declared in time, unpaid past the deadline -> still in", evPendLate.status === "buyback-pending" && evPendLate.weeks[1].buyback === "pending" && evPendLate.eliminatedWeek === null);
  check("the money's due date stays on the week, so the desk can call it late", evPendLate.weeks[1].buybackBy === "2026-09-22T00:15:00.000Z");
  check("a passed due date no longer drives the limbo countdown", evPendLate.buybackDeadline === null);
  check("inside the window a declared buy-back still counts down", evPend.buybackDeadline === "2026-09-22T00:15:00.000Z");
  check("its later weeks still count", evPendLate.weeks[2]?.result === "win" && evPendLate.weeks[3]?.team === "Arizona Cardinals");
  check("and it can still pick", validatePick({ evaluation: evPendLate, week: 3, team: "Baltimore Ravens", weekSchedule: schedules[3], now }).ok === true);
  const late = new Date("2026-10-07T00:00Z");
  const evLateConfirmed = evaluateSlot({ slot, picks, revivals: [{ id: "r1", slotId: "s1", lossWeek: 1, status: "confirmed" }], schedules, overrides: {}, cfg, now: late });
  check("late admin confirm still revives", evLateConfirmed.status !== "dead" || evLateConfirmed.eliminatedWeek !== 1);
}

// 4. Sudden death: week 4 loss is final even with a revival on file
{
  const sched4 = structuredClone(schedules);
  sched4[4].games[0] = finalG("Houston Texans", "Jacksonville Jaguars", "2026-10-04T17:00Z", "Houston Texans");
  const picks = { 1: { team: "Denver Broncos" }, 2: { team: "Buffalo Bills" }, 3: { team: "Arizona Cardinals" }, 4: { team: "Jacksonville Jaguars" } };
  const ev = evaluateSlot({ slot, picks, revivals: [{ id: "rX", slotId: "s1", lossWeek: 4, status: "confirmed" }], schedules: sched4, overrides: {}, cfg, now: new Date("2026-10-05T00:00Z") });
  check("sudden death loss is final", ev.status === "dead" && ev.eliminatedWeek === 4);
}

// 5. Default picks
{
  check("default = MNF away", defaultPick(schedules[1].games, []).team === "Minnesota Vikings");
  check("default falls to home if away used", defaultPick(schedules[1].games, ["Minnesota Vikings"]).team === "Chicago Bears");
  check("both used -> none", defaultPick(schedules[1].games, ["Minnesota Vikings", "Chicago Bears"]).team === null);
  const ev = evaluateSlot({ slot, picks: { 2: { team: "Buffalo Bills" } }, revivals: [], schedules, overrides: {}, cfg, now });
  check("missed w1 granted MNF away (won)", ev.weeks[1].team === "Minnesota Vikings" && ev.weeks[1].source === "auto-default" && ev.weeks[1].result === "win");
}

// 6. validatePick guards
{
  const picks = { 1: { team: "Denver Broncos" }, 2: { team: "Buffalo Bills" } };
  const ev = evaluateSlot({ slot, picks, revivals: [], schedules, overrides: {}, cfg, now });
  check("reject reused team", validatePick({ evaluation: ev, week: 3, team: "Denver Broncos", weekSchedule: schedules[3], now }).ok === false);
  check("reject started game", validatePick({ evaluation: ev, week: 3, team: "Dallas Cowboys", weekSchedule: schedules[3], now }).ok === false);
  check("reject bye team", validatePick({ evaluation: ev, week: 3, team: "Green Bay Packers", weekSchedule: schedules[3], now }).ok === false);
  check("allow un-kicked pick", validatePick({ evaluation: ev, week: 3, team: "Arizona Cardinals", weekSchedule: schedules[3], now }).ok === true);
  check("allow future week prefill", validatePick({ evaluation: ev, week: 4, team: "Houston Texans", weekSchedule: schedules[4], now }).ok === true);
  const evLockedPick = evaluateSlot({ slot, picks: { ...picks, 3: { team: "Dallas Cowboys" } }, revivals: [], schedules, overrides: {}, cfg, now });
  check("reject changing a locked pick", validatePick({ evaluation: evLockedPick, week: 3, team: "Arizona Cardinals", weekSchedule: schedules[3], now }).ok === false);
  const evDead = evaluateSlot({ slot, picks: { 1: { team: "New England Patriots" } }, revivals: [], schedules, overrides: {}, cfg, now: new Date("2026-10-07T00:00Z") });
  check("dead slot cannot pick", validatePick({ evaluation: evDead, week: 5, team: "Arizona Cardinals", weekSchedule: schedules[3], now }).ok === false);
}

// 7. validateBuyback guards
{
  const picks = { 1: { team: "Denver Broncos" }, 2: { team: "New York Jets" } };
  const ev = evaluateSlot({ slot, picks, revivals: [], schedules, overrides: {}, cfg, now });
  check("buyback ok on real loss", validateBuyback({ evaluation: ev, lossWeek: 2, cfg, now }).ok === true);
  check("buyback rejected on a win week", validateBuyback({ evaluation: ev, lossWeek: 1, cfg, now }).ok === false);
  const evStale = evaluateSlot({ slot, picks: { 1: { team: "New England Patriots" }, 2: { team: "Buffalo Bills" } }, revivals: [], schedules, overrides: {}, cfg, now });
  check("buyback rejected after next week wrapped", validateBuyback({ evaluation: evStale, lossWeek: 1, cfg, now }).ok === false);
}

// 8. currentWeek roll-forward
{
  check("mid-week-3 current", currentWeek(schedules, cfg) === 3);
  const done = structuredClone(schedules);
  done[3].games = done[3].games.map((g) => ({ ...g, state: "post", completed: true, home: { ...g.home, winner: true } }));
  check("rolls to week 4 after w3 final", currentWeek(done, cfg) === 4);
}

// 9. Pot math
{
  const slots = [{ id: "s1" }, { id: "s2" }, { id: "s3" }];
  const payments = { entries: [
    { id: "1", slotId: "s1", type: "buyin", amount: 10 },
    { id: "2", slotId: "s2", type: "buyin", amount: 10 },
    { id: "3", slotId: "s1", type: "buyback", amount: 10 },
    { id: "4", slotId: "s3", type: "buyin", amount: 10, voided: true },
  ] };
  const pot = computePot(payments, slots, cfg);
  check("pot collected", pot.collected === 30);
  check("unpaid count", pot.unpaidCount === 1);
  check("expected", pot.expected === 40);
  check("league-facing total = entries × buy-in + logged buy-backs", pot.total === 40 && pot.entries === 3 && pot.buybackCash === 10);
}

// 10. Standings assembly
{
  const snap = computeStandings({
    cfg,
    players: [{ id: "p1", name: "Alice" }, { id: "p2", name: "Bob" }],
    slots: [{ id: "s1", playerId: "p1", label: "Alice" }, { id: "s2", playerId: "p2", label: "Bob" }],
    picksBySlot: {
      s1: { 1: { team: "Denver Broncos" }, 2: { team: "Buffalo Bills" }, 3: { team: "Arizona Cardinals" } },
      s2: { 1: { team: "Seattle Seahawks" }, 2: { team: "New York Jets" } },
    },
    revivals: [], payments: { entries: [] }, schedules, overrides: {}, now,
  });
  check("standings week", snap.week === 3);
  check("alive first", snap.slots[0].label === "Alice" && snap.slots[0].status === "alive");
  check("bob in buyback limbo", snap.slots[1].status === "buyback-available");
  check("aggregate deadline = earliest open loss", snap.buybackDeadline === "2026-09-29T00:15:00.000Z");
  check("riders", (snap.riders["Arizona Cardinals"] || []).includes("Alice"));
  check("live flag", snap.liveNow === true);
}

// 10b. Standing words (safe / vulnerable / limbo / out) and the board order
{
  check("standing: dead -> out", standingOf({ status: "dead", weeks: {} }, 3) === "out");
  check("standing: can buy back -> limbo", standingOf({ status: "buyback-available", weeks: { 3: { result: "win" } } }, 3) === "limbo");
  check("standing: buy-back pending -> limbo even on a winning week", standingOf({ status: "buyback-pending", weeks: { 3: { result: "win" } } }, 3) === "limbo");
  check("standing: alive + this week won -> safe", standingOf({ status: "alive", weeks: { 3: { result: "win" } } }, 3) === "safe");
  check("standing: alive + no pick -> vulnerable", standingOf({ status: "alive", weeks: {} }, 3) === "vulnerable");
  check("standing: alive + live game -> vulnerable", standingOf({ status: "alive", weeks: { 3: { result: "live-leading" } } }, 3) === "vulnerable");
  check("standing: alive + hidden pick -> vulnerable", standingOf({ status: "alive", weeks: { 3: { hidden: true } } }, 3) === "vulnerable");
  // Board order: safe, vulnerable, limbo, out. Carl already won week 3 on a
  // commissioner override of the live DAL game; Alice's ARI game hasn't kicked off.
  const dal = schedules[3].games[0];
  const snap = computeStandings({
    cfg,
    players: [{ id: "p1", name: "Alice" }, { id: "p2", name: "Bob" }, { id: "p3", name: "Carl" }, { id: "p4", name: "Dana" }],
    slots: [
      { id: "s1", playerId: "p1", label: "Alice" }, { id: "s2", playerId: "p2", label: "Bob" },
      { id: "s3", playerId: "p3", label: "Carl" }, { id: "s4", playerId: "p4", label: "Dana" },
    ],
    picksBySlot: {
      s1: { 1: { team: "Denver Broncos" }, 2: { team: "Buffalo Bills" }, 3: { team: "Arizona Cardinals" } },
      s2: { 1: { team: "Seattle Seahawks" }, 2: { team: "New York Jets" } },
      s3: { 1: { team: "Denver Broncos" }, 2: { team: "Buffalo Bills" }, 3: { team: "Dallas Cowboys" } },
      s4: { 1: { team: "New England Patriots" } },
    },
    revivals: [], payments: { entries: [] }, schedules, overrides: { [dal.id]: "Dallas Cowboys" }, now,
  });
  check("board order: safe, vulnerable, limbo, out", snap.slots.map((r) => r.label).join(",") === "Carl,Alice,Bob,Dana");
  check("board order words", snap.slots.map((r) => standingOf(r, snap.week)).join(",") === "safe,vulnerable,limbo,out");
}

// 11. Overrides
{
  const g = schedules[1].games[0];
  check("override winner", resultForTeam(g, "New England Patriots", { [g.id]: "New England Patriots" }) === "win");
  check("override VOID = push", resultForTeam(g, "New England Patriots", { [g.id]: "VOID" }) === "win");
}

// 12. Per-week buy-back annotations
{
  const picks = { 1: { team: "Denver Broncos" }, 2: { team: "New York Jets" } };
  const evA = evaluateSlot({ slot, picks, revivals: [], schedules, overrides: {}, cfg, now });
  check("loss annotated available", evA.weeks[2].buyback === "available");
  const evP = evaluateSlot({ slot, picks, revivals: [{ id: "r1", slotId: "s1", lossWeek: 2, status: "pending" }], schedules, overrides: {}, cfg, now });
  check("loss annotated pending", evP.weeks[2].buyback === "pending");
  const evC = evaluateSlot({ slot, picks, revivals: [{ id: "r1", slotId: "s1", lossWeek: 2, status: "confirmed" }], schedules, overrides: {}, cfg, now });
  check("loss annotated confirmed", evC.weeks[2].buyback === "confirmed");
  check("win weeks not annotated", evC.weeks[1].buyback === undefined);
  const evX = evaluateSlot({ slot, picks: { 1: { team: "New England Patriots" }, 2: { team: "Buffalo Bills" } }, revivals: [], schedules, overrides: {}, cfg, now });
  check("loss annotated expired after deadline", evX.weeks[1].buyback === "expired");
}

// 13. Consecutive losses, both bought back
{
  const picks = { 1: { team: "New England Patriots" }, 2: { team: "New York Jets" }, 3: { team: "Arizona Cardinals" } };
  const revs = [
    { id: "r1", slotId: "s1", lossWeek: 1, status: "confirmed" },
    { id: "r2", slotId: "s1", lossWeek: 2, status: "confirmed" },
  ];
  const ev = evaluateSlot({ slot, picks, revivals: revs, schedules, overrides: {}, cfg, now });
  check("double buyback alive", ev.status === "alive");
  check("double buyback count", ev.buybacksUsed === 2);
  check("both weeks marked", ev.weeks[1].buyback === "confirmed" && ev.weeks[2].buyback === "confirmed");
}

// 14. Declaring the buy-back gates the next pick; PAYMENT never does.
//     An open loss with no buy-back on file blocks picking (the button is right
//     there). Once declared, pending is enough: the commissioner confirms the
//     money on their own clock and the pick stands either way.
{
  const picks = { 1: { team: "Denver Broncos" }, 2: { team: "New York Jets" } };
  const evAvail = evaluateSlot({ slot, picks, revivals: [], schedules, overrides: {}, cfg, now });
  const availCheck = validatePick({ evaluation: evAvail, week: 3, team: "Arizona Cardinals", weekSchedule: schedules[3], now });
  check("undeclared buy-back blocks the pick", availCheck.ok === false);
  check("block names the loss week", availCheck.code === "buyback-required" && availCheck.lossWeek === 2);
  check("commissioner picks past the block", validatePick({ evaluation: evAvail, week: 3, team: "Arizona Cardinals", weekSchedule: schedules[3], now, isAdmin: true }).ok === true);
  const evPend = evaluateSlot({ slot, picks, revivals: [{ id: "rp", slotId: "s1", lossWeek: 2, status: "pending" }], schedules, overrides: {}, cfg, now });
  check("buyback-pending can still pick", validatePick({ evaluation: evPend, week: 3, team: "Arizona Cardinals", weekSchedule: schedules[3], now }).ok === true);
}

// 14b. League rule (2026-09-25): until the loss is bought back the slot holds no
//     pick for the week in play, not even one made before the loss went final.
{
  const picks = { 1: { team: "Denver Broncos" }, 2: { team: "New York Jets" }, 3: { team: "Baltimore Ravens" }, 4: { team: "Houston Texans" } };
  const ev = evaluateSlot({ slot, picks, revivals: [], schedules, overrides: {}, cfg, now });
  check("stale: an unbought loss sets the week-in-play pick aside", ev.status === "buyback-available" && !ev.weeks[3] && !ev.usedTeams.includes("Baltimore Ravens"));
  check("stale: the API is told which week to clear", stalePickWeek(ev, picks) === 3);
  check("stale: a plan for a later week is left alone", ev.weeks[4]?.team === "Houston Texans");
  const evBought = evaluateSlot({ slot, picks, revivals: [{ id: "rb", slotId: "s1", lossWeek: 2, status: "pending" }], schedules, overrides: {}, cfg, now });
  check("stale: once bought back the week's pick stands", evBought.weeks[3]?.team === "Baltimore Ravens" && stalePickWeek(evBought, picks) === null);
  const lockedPicks = { 1: { team: "Denver Broncos" }, 2: { team: "New York Jets" }, 3: { team: "Dallas Cowboys" } };
  const evLocked = evaluateSlot({ slot, picks: lockedPicks, revivals: [], schedules, overrides: {}, cfg, now });
  check("stale: a pick whose game already started is never touched", evLocked.weeks[3]?.team === "Dallas Cowboys" && stalePickWeek(evLocked, lockedPicks) === null);
}

// 15. Sudden death loss annotated
{
  const sched4 = structuredClone(schedules);
  sched4[4].games[0] = finalG("Houston Texans", "Jacksonville Jaguars", "2026-10-04T17:00Z", "Houston Texans");
  const picks = { 1: { team: "Denver Broncos" }, 2: { team: "Buffalo Bills" }, 3: { team: "Arizona Cardinals" }, 4: { team: "Jacksonville Jaguars" } };
  const ev = evaluateSlot({ slot, picks, revivals: [], schedules: sched4, overrides: {}, cfg, now: new Date("2026-10-05T00:00Z") });
  check("sudden death annotated", ev.weeks[4].buyback === "sudden-death");
}

// 16. Public view hides unstarted picks entirely (and their existence)
{
  const picks = { 1: { team: "Denver Broncos" }, 2: { team: "Buffalo Bills" }, 3: { team: "Arizona Cardinals" }, 4: { team: "Houston Texans" } };
  const ev = evaluateSlot({ slot, picks, revivals: [], schedules, overrides: {}, cfg, now });
  // weeks 1-2 final (locked), week 3 ARI game is pre (unlocked), week 4 pre (unlocked prefill)
  check("own view keeps unlocked picks", ev.weeks[3].team === "Arizona Cardinals");
  const pub = publicSlotView(ev, false, 3);
  check("locked weeks visible to league", pub.weeks[1]?.team === "Denver Broncos" && pub.weeks[2]?.team === "Buffalo Bills");
  check("current-week pick shows existence only", pub.weeks[3]?.hidden === true && pub.weeks[3].team === undefined && pub.weeks[3].result === undefined);
  check("future prefill fully hidden", pub.weeks[4] === undefined);
  check("usedTeams scrubbed of hidden picks", !pub.usedTeams.includes("Arizona Cardinals") && !pub.usedTeams.includes("Houston Texans"));
  check("status still visible", pub.status === ev.status);
  const own = publicSlotView(ev, true, 3);
  check("isMine returns full record", own.weeks[3]?.team === "Arizona Cardinals");
  // live game counts as started: swap wk3 to the in-progress DAL game
  const evLive = evaluateSlot({ slot, picks: { ...picks, 3: { team: "Dallas Cowboys" } }, revivals: [], schedules, overrides: {}, cfg, now });
  const pubLive = publicSlotView(evLive, false, 3);
  check("in-progress pick is public", pubLive.weeks[3]?.team === "Dallas Cowboys");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
