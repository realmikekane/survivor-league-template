/* Pure rules engine for the survivor league. No I/O here: everything takes
   plain data and a clock so it can be unit-tested and reused by every
   endpoint. League rules encoded (lib/rules-text.mjs says the same in plain words):

   - Pick one team per week to win. A tie counts as a win.
   - A slot can never reuse a team it has picked before, including a team it
     lost with and bought back from.
   - Losses in weeks 1..(suddenDeathWeek-1) can be bought back for a fee.
     The player taps Buy back before that loss's own deadline: the last
     kickoff of the FOLLOWING week (lose W1, buy back before W2 wraps). A W3
     loss therefore gets until the sudden-death week's last game. The money
     is due by the same deadline, but a late payment never kills a declared
     buy-back: the desk flags it late and the commissioner collects.
     A slot must have played every week to stay eligible.
   - From suddenDeathWeek on, a loss is final.
   - No pick when the week fully locks: you are granted the away team of the
     week's last game (MNF). If used, the home team. If both used, you're out.
   - Picks lock per game at kickoff: scheduled time, or the moment the live
     feed says the game started, whichever comes first. */

export function gameForTeam(games, team) {
  return games.find((g) => g.home?.name === team || g.away?.name === team) || null;
}

export function resultForTeam(game, team, overrides = {}) {
  const ov = overrides[game.id];
  if (ov === "VOID" || ov === "TIE") return "win"; // pushes and ties survive
  if (ov) return ov === team ? "win" : "loss";
  const mine = game.home?.name === team ? game.home : game.away;
  const theirs = mine === game.home ? game.away : game.home;
  if (!mine || !theirs) return "pending";
  if (game.completed) {
    if (mine.winner) return "win";
    if (theirs.winner) return "loss";
    // No winner flags yet: trust the score before calling it a tie.
    if (mine.score != null && theirs.score != null && mine.score !== theirs.score) return mine.score > theirs.score ? "win" : "loss";
    return "win"; // genuine tie = win
  }
  if (game.state === "in") {
    if (mine.score == null || theirs.score == null) return "live-tied";
    if (mine.score > theirs.score) return "live-leading";
    if (mine.score < theirs.score) return "live-trailing";
    return "live-tied";
  }
  return "pending";
}

export function gameStarted(game, now) {
  // "post" without completed is a postponement or cancellation, not a start.
  return game.state === "in" || game.completed === true || now >= new Date(game.date);
}

export function weekFullyLocked(games, now) {
  if (!games?.length) return false;
  return games.every((g) => gameStarted(g, now));
}

export function lastGame(games) {
  if (!games?.length) return null;
  return games.reduce((a, b) => (new Date(b.date) >= new Date(a.date) ? b : a));
}

/* Default pick (rule 10 in the stock rules): away team of the week's last game; home if used; null if both used. */
export function defaultPick(games, usedTeams) {
  const g = lastGame(games);
  if (!g) return { team: null, game: null };
  if (g.away && !usedTeams.includes(g.away.name)) return { team: g.away.name, game: g };
  if (g.home && !usedTeams.includes(g.home.name)) return { team: g.home.name, game: g };
  return { team: null, game: g };
}

export function buybackDeadline(schedules, cfg) {
  const sd = cfg.suddenDeathWeek ?? 4;
  const sched = schedules[sd];
  if (!sched?.games?.length) return null;
  return new Date(lastGame(sched.games).date);
}

/* A loss must be bought back before the FOLLOWING week's LAST KICKOFF:
   you need a game left to pick, so deciding right before that week's MNF is
   legal, and after it kicks off you're out. */
export function buybackDeadlineFor(lossWeek, schedules) {
  const sched = schedules[lossWeek + 1];
  if (!sched?.games?.length) return null;
  return new Date(lastGame(sched.games).date);
}

/* First week whose games are not all final. Rolls over the morning after MNF. */
export function currentWeek(schedules, cfg, overrides = {}) {
  const total = cfg.totalWeeks ?? 18;
  for (let w = 1; w <= total; w++) {
    const sched = schedules[w];
    if (!sched?.games?.length) return w;
    // A commissioner override (VOID for a cancelled game) counts the game as settled.
    if (!sched.games.every((g) => g.completed || overrides[g.id])) return w;
  }
  return total;
}

/* Full evaluation of one slot across the season. */
export function evaluateSlot({ slot, picks = {}, revivals = [], schedules = {}, overrides = {}, cfg, now }) {
  const sd = cfg.suddenDeathWeek ?? 4;
  const total = cfg.totalWeeks ?? 18;
  const weeks = {};
  const usedTeams = [];
  let status = "alive"; // alive | buyback-available | buyback-pending | dead
  let eliminatedWeek = null;
  let buybacksUsed = 0;
  let openLoss = null; // { lossWeek } while a buy-back is available/pending
  let undeclaredLoss = null; // a loss nobody has bought back yet, window still open

  for (let w = 1; w <= total; w++) {
    const sched = schedules[w];
    let rec = picks[w] ? { ...picks[w] } : null;

    // Default pick once the whole week has kicked off.
    if (!rec && sched?.games?.length && weekFullyLocked(sched.games, now)) {
      // Never default onto a team this slot has already pre-filled for a later week.
      const def = defaultPick(sched.games, [...usedTeams, ...Object.values(picks).map((p) => p?.team).filter(Boolean)]);
      if (def.team) {
        rec = { team: def.team, source: "auto-default", virtual: true };
      } else {
        weeks[w] = { team: null, source: "auto-default", result: "loss", locked: true, note: "No pick; both default teams already used" };
        status = "dead";
        eliminatedWeek = w;
        break;
      }
    }

    if (!rec) {
      weeks[w] = null;
      continue;
    }

    const game = sched ? gameForTeam(sched.games, rec.team) : null;
    const result = game ? resultForTeam(game, rec.team, overrides) : "pending";
    const locked = game ? gameStarted(game, now) : false;
    // No picking until you buy back, so the week in play can't hold a pick
    // either: one made before the loss went final would otherwise lock and
    // count while the slot sits undecided. The API deletes the blob
    // (stalePickWeek); until then it simply isn't there.
    if (undeclaredLoss !== null && w === undeclaredLoss + 1 && !locked && !rec.virtual) {
      weeks[w] = null;
      continue;
    }
    const opp = game ? (game.home?.name === rec.team ? game.away : game.home) : null;
    weeks[w] = {
      team: rec.team,
      source: rec.source || "player",
      virtual: rec.virtual === true,
      ts: rec.ts || null,
      result,
      locked,
      gameId: game?.id ?? null,
      kickoff: game?.date ?? null,
      opponent: opp?.name ?? null,
      homeAway: game ? (game.home?.name === rec.team ? "home" : "away") : null,
      detail: game?.detail ?? null,
    };
    if (!usedTeams.includes(rec.team)) usedTeams.push(rec.team);

    if (result === "loss") {
      if (w < sd) {
        const mine = revivals.filter((r) => r.slotId === slot.id && r.lossWeek === w);
        const confirmed = mine.find((r) => r.status === "confirmed");
        const pending = mine.find((r) => r.status === "pending");
        const dlFor = buybackDeadlineFor(w, schedules); // your window is the week right after the loss
        const dlIso = dlFor ? dlFor.toISOString() : null;
        const withinWindow = !dlFor || now <= dlFor;
        if (confirmed) {
          buybacksUsed += 1; // revived; keep scanning
          weeks[w].buyback = "confirmed";
        } else if (pending) {
          // Declared in time (the server refuses a late one), so the slot never
          // dies over money. The rules still say the $ lands by the deadline:
          // past it, the desk lists this as late for the commissioner to collect.
          status = "buyback-pending";
          openLoss = { lossWeek: w, deadline: withinWindow ? dlIso : null };
          weeks[w].buyback = "pending";
          weeks[w].buybackBy = dlIso;
        } else if (withinWindow) {
          status = "buyback-available";
          undeclaredLoss = w;
          openLoss = { lossWeek: w, deadline: dlIso };
          weeks[w].buyback = "available";
          weeks[w].buybackBy = dlIso;
        } else {
          status = "dead";
          eliminatedWeek = w;
          weeks[w].buyback = "expired";
          weeks[w].buybackBy = dlIso;
          break;
        }
      } else {
        status = "dead";
        eliminatedWeek = w;
        weeks[w].buyback = "sudden-death";
        break;
      }
    }
  }

  return { slotId: slot.id, weeks, usedTeams, status, eliminatedWeek, buybacksUsed, openLoss, buybackDeadline: openLoss?.deadline ?? null };
}

/* The week-in-play pick evaluateSlot set aside because its slot hasn't bought
   back a loss: the week to delete, or null. */
export function stalePickWeek(evaluation, picks = {}) {
  if (evaluation.status !== "buyback-available" || !evaluation.openLoss) return null;
  const w = evaluation.openLoss.lossWeek + 1;
  return picks[w]?.team && !evaluation.weeks[w] ? w : null;
}

/* Server-side validation for a pick submission. Returns { ok } or { ok:false, error }. */
export function validatePick({ evaluation, week, team, weekSchedule, now, isAdmin = false }) {
  if (isAdmin) return { ok: true };
  if (evaluation.status === "dead") return { ok: false, error: "This slot has been eliminated." };
  // An undeclared loss is the silent killer: the pick saves, the window closes,
  // and the slot dies with a pick nobody credited. Make them declare first.
  if (evaluation.status === "buyback-available") {
    const lw = evaluation.openLoss?.lossWeek ?? null;
    return {
      ok: false,
      code: "buyback-required",
      lossWeek: lw,
      error: `Buy back your week ${lw} loss first (the Buy back button on this slot), then pick.`,
    };
  }
  const games = weekSchedule?.games || [];
  const game = gameForTeam(games, team);
  if (!game) return { ok: false, error: `${team} doesn't play in week ${week} (bye or not on the schedule).` };
  if (gameStarted(game, now)) return { ok: false, error: `${team} already kicked off. Picks lock at kickoff.` };
  const existing = evaluation.weeks[week];
  if (existing?.team && existing.locked) return { ok: false, error: `Your week ${week} pick (${existing.team}) is locked; that game already started.` };
  const usedElsewhere = Object.entries(evaluation.weeks)
    .filter(([w, rec]) => Number(w) !== Number(week) && rec?.team)
    .map(([, rec]) => rec.team);
  if (usedElsewhere.includes(team)) return { ok: false, error: `You already used ${team}. One ride per team, ever.` };
  return { ok: true };
}

/* ignoreWindow: the commissioner granting a buy-back on someone's behalf. Money
   shows up in Venmo late, or the player never tapped the button; the deadline is
   a player deadline, not a desk one. Every other rule still holds. */
export function validateBuyback({ evaluation, lossWeek, cfg, now, ignoreWindow = false }) {
  const sd = cfg.suddenDeathWeek ?? 4;
  const rec = evaluation.weeks[lossWeek];
  if (!rec || rec.result !== "loss") return { ok: false, error: `No loss recorded in week ${lossWeek}.` };
  if (lossWeek >= sd) return { ok: false, error: `Week ${lossWeek} is sudden death. No buy-backs.` };
  const dl = rec.buybackBy ? new Date(rec.buybackBy) : null;
  if (dl && now > dl && !ignoreWindow) return { ok: false, error: `Too late. A week ${lossWeek} loss had to be bought back before week ${lossWeek + 1}'s last game kicked off.` };
  // Must have played every locked week up to the loss (defaults count as played).
  for (let w = 1; w <= lossWeek; w++) {
    if (evaluation.weeks[w] === null || evaluation.weeks[w] === undefined) {
      return { ok: false, error: `Buy-backs require playing every week; week ${w} has no pick.` };
    }
  }
  return { ok: true };
}

/* League-facing view of a slot: picks stay invisible until their game starts.
   Not even pick-existence leaks — unlocked and unpicked weeks serve identically.
   Owners, their household manager, and the commissioner bypass this. */
export function publicSlotView(r, isMine, curWeek = null) {
  if (isMine) return r;
  const weeks = {};
  for (const [w, rec] of Object.entries(r.weeks || {})) {
    if (rec?.locked === true) weeks[w] = rec;
    else if (rec?.team && curWeek !== null && Number(w) === Number(curWeek)) {
      weeks[w] = { hidden: true }; // current week: existence shows, the team doesn't
    }
    // future prefills stay fully invisible, existence included
  }
  const usedTeams = [...new Set(Object.values(weeks).map((x) => x?.team).filter(Boolean))];
  return { ...r, weeks, usedTeams };
}

export function computePot(payments, slots, cfg) {
  const confirmed = (payments?.entries || []).filter((p) => !p.voided);
  const collected = confirmed.reduce((s, p) => s + Number(p.amount || 0), 0);
  const buyIn = Number(cfg.buyIn ?? 10);
  const activeSlots = slots.filter((s) => !s.withdrawn);
  const paidBuyinSlotIds = new Set(confirmed.filter((p) => p.type === "buyin").map((p) => p.slotId));
  const unpaid = activeSlots.filter((s) => !paidBuyinSlotIds.has(s.id));
  // What the league sees: every entry counts at the buy-in, and buy-backs count
  // once the commissioner logs them. Who has actually paid is desk business.
  const buybacksPaid = confirmed.filter((p) => p.type === "buyback");
  const buybackCash = buybacksPaid.reduce((s, p) => s + Number(p.amount || 0), 0);
  const total = activeSlots.length * buyIn + buybackCash;
  return { collected, buyIn, unpaidCount: unpaid.length, unpaidSlotIds: unpaid.map((s) => s.id), expected: collected + unpaid.length * buyIn, total, entries: activeSlots.length, buybackCash, buybacks: buybacksPaid.length };
}

/* The four words the board shows, judged against the current week.
   safe = this week's pick already won; nothing can take you out this week.
   vulnerable = alive, but this week isn't won yet (no pick, not kicked off, live).
   limbo = lost in weeks 1-3 and not settled: not bought back yet (window still
     open), or bought back and waiting on the commissioner to confirm the money.
   out = eliminated.
   app.js carries a copy (the browser can't import this file); keep them identical. */
export function standingOf(r, week) {
  if (r.status === "dead") return "out";
  if (r.status === "buyback-available" || r.status === "buyback-pending") return "limbo";
  return r.weeks?.[week]?.result === "win" ? "safe" : "vulnerable";
}

/* Sort + league-wide aggregates over already-evaluated rows. Shared by the
   full rebuild and the single-slot incremental snapshot update. */
export function aggregateStandings(rows, { cfg, slots, payments, schedules, now, overrides = {} }) {
  const week = currentWeek(schedules, cfg, overrides);
  const active = slots.filter((s) => !s.withdrawn);
  const order = { safe: 0, vulnerable: 1, limbo: 2, out: 3 };
  const sorted = rows.slice().sort((a, b) => {
    const d = order[standingOf(a, week)] - order[standingOf(b, week)];
    if (d) return d;
    if (a.status === "dead" && b.status === "dead" && a.eliminatedWeek !== b.eliminatedWeek) {
      return (b.eliminatedWeek || 0) - (a.eliminatedWeek || 0); // latest survivors first
    }
    return a.label.localeCompare(b.label);
  });

  const aliveCount = sorted.filter((r) => r.status === "alive").length;
  const limboCount = sorted.filter((r) => r.status === "buyback-pending" || r.status === "buyback-available").length;
  const pot = computePot(payments, active, cfg);
  const survivorsForSplit = aliveCount + limboCount || 1;

  // Who's riding whom in the current week (alive-ish slots only).
  const riders = {};
  for (const r of sorted) {
    if (r.status === "dead") continue;
    const rec = r.weeks[week];
    if (rec?.team) (riders[rec.team] = riders[rec.team] || []).push(r.label);
  }

  const sched = schedules[week];
  const liveNow = sched?.games?.some((g) => g.state === "in") || false;

  return {
    season: cfg.seasonYear,
    week,
    liveNow,
    aliveCount,
    limboCount,
    deadCount: sorted.filter((r) => r.status === "dead").length,
    totalSlots: sorted.length,
    pot,
    splitPreview: Math.floor((pot.collected / survivorsForSplit) * 100) / 100,
    riders,
    buybackDeadline: sorted.map((r) => r.buybackDeadline).filter(Boolean).sort()[0] ?? null, // earliest open loss
    slots: sorted,
  };
}

/* Assemble the public snapshot for the whole league. */
export function computeStandings({ cfg, players, slots, picksBySlot, revivals, payments, schedules, overrides, now }) {
  const byPlayer = Object.fromEntries(players.map((p) => [p.id, p]));
  const active = slots.filter((s) => !s.withdrawn);
  const rows = active.map((slot) => {
    const evaluation = evaluateSlot({ slot, picks: picksBySlot[slot.id] || {}, revivals, schedules, overrides, cfg, now });
    return {
      id: slot.id,
      label: slot.label,
      playerId: slot.playerId,
      playerName: byPlayer[slot.playerId]?.name || slot.label,
      ...evaluation,
    };
  });
  return { builtAt: now.toISOString(), ...aggregateStandings(rows, { cfg, slots, payments, schedules, now, overrides }) };
}
