# Start next season

Profile: personal (touches money and production data, so spec first)
Repo: survivor-league-template first, then port to survivor-league on Mike's go-ahead

**What.** A commissioner-only "Start next season" control on the desk. It archives the finished season into the Hall of Fame, bumps `seasonYear`, reopens sign-ups, and carries the player roster forward. Slots, picks, buy-backs, payments, and the pot start empty. Last season stays readable.

**Why it is safe.** Everything is keyed by season in Blobs. The rollover never writes or deletes an old-season key except to stamp the final snapshot as archived. It writes only `cfg` and the new season's `roster:<next>`. Undo is a cfg flip plus deleting the one roster blob it created.

**Carries over.** Players, by the same id (tokens on phones keep working), with name, PIN, email, phone, and household links (`managedBy`). Commissioner contacts, Venmo, fees, rules, host settings live in `cfg` and stay.

**Resets.** Slots, picks, buy-backs, payments (so the pot is $0), overrides, chat, host state, snuff ledger, log. All of it simply starts under the new season key.

**Returning players opt in.** Nobody is entered automatically. A logged-in returning player with no slots sees "Enter the <year> season" on My Picks, picks a slot count for themselves and each household member, and is in (unpaid, like a new join). New people use the normal Join page. Same deadline as joins: week 1's last kickoff.

**Done.**
- Desk, League cell, "Start next season": Preview shows the season, the champions it found (alive or limbo slots; if none, the last ones standing), flawless champs (no buy-backs), the pot, pending buy-backs, and whether the season is over.
- Start needs the next year typed in. It refuses while any buy-back is pending. It refuses before the season is over (final week all final, or one survivor left) unless the commissioner ticks "end it early".
- After Start: header says the new year, Hall of Fame shows last year's champions, sign-ups open, board empty, returning players log in with their old PIN.
- Undo is offered until anyone enters, pays, or edits their details in the new season. It puts the year, sign-up switch, and Hall of Fame back exactly.
- Hall of Fame years that the app archived link to a read-only final board for that season.

**Out.** No payout tracking. No old-season chat or log browsing. No auto-detect "season over" nag. No multi-season stats.

**Checks.** `npm test` exits 0 with new tests: preview, refusals (wrong year, pending buy-back, not over), start, roster carry, old PIN and old token work, pot $0, opt-in entry, household opt-in, entry past deadline refused, archived state read, undo, undo refused after entry.

**Blast radius.** The live league's cfg and next season's roster. Old-season data is never rewritten.

**Rollback.** Desk Undo while the new season is empty. After that, restore `cfg.seasonYear` and `cfg.hallOfFame` by hand; old-season blobs are untouched. Code: revert the commit and redeploy.
