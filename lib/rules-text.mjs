/* The rules a new league starts with, written to match what lib/rules.mjs
   enforces and filled in from the league's own settings. The commissioner can
   rewrite them any time under League settings. The engine never reads this
   text, so if you change a rule in lib/rules.mjs, change the words here too. */
export function defaultRulesText(cfg = {}) {
  const buyIn = Number(cfg.buyIn ?? 10);
  const fee = Number(cfg.buybackFee ?? 10);
  const sd = Number(cfg.suddenDeathWeek ?? 4);
  const slots = Number(cfg.maxSlotsPerPlayer ?? 3);
  const weeks = Number(cfg.totalWeeks ?? 18);
  const money = (n) => `$${n.toLocaleString("en-US")}`;
  return [
    "HOW TO PLAY",
    "1. Pick one NFL team each week to win its game. Win and you move on. Lose and you are out, unless you buy back (see Buy-backs).",
    "2. Once you ride a team, you can never pick it again that season, win or lose.",
    `3. You can play up to ${slots} slot${slots === 1 ? "" : "s"}. Each slot is its own entry with its own buy-in.`,
    "",
    "BUY-BACKS",
    sd > 1
      ? `4. Lose in weeks 1 through ${sd - 1} and you can buy back in for ${money(fee)} per loss. From week ${sd} on it is sudden death: one loss and you are done.`
      : "4. There are no buy-backs. One loss and you are done.",
    "5. Tap Buy back before the last kickoff of the week after your loss. Lose in week 1, buy back before week 2 wraps up. The money is due by the same deadline.",
    "6. You still cannot pick the team you lost with, and you cannot make a new pick until the loss is bought back.",
    "7. You must have played every week to be eligible for a buy-back.",
    "",
    "PICKS AND LOCKING",
    "8. Picks lock per game at kickoff. Until your team kicks off, you can change your pick to any team whose game has not started.",
    "9. Picks stay hidden from the rest of the league until that game kicks off. The league can see that a pick is in, just not what it is. You always see your own picks and your household's, and the commissioners see everything. Every change is logged.",
    "10. No pick by the time the last game of the week kicks off? You get the away team from that last game. Already used them? You get the home team. Used both? You are out.",
    "11. Ties count as wins.",
    "",
    "MONEY",
    `12. ${money(buyIn)} buy-in per slot. The last survivor takes the pot. Multiple survivors at the end of week ${weeks} split it.`,
    "13. The commissioner confirms every payment by hand.",
  ].join("\n");
}
