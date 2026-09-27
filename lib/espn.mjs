/* ESPN public scoreboard adapter. Normalizes one week of games into the
   shape the rules engine consumes. Team identity is the full display name
   ("Arizona Cardinals"), matching the league's historical records.
   Also carries the betting line (ESPN BET via the same feed) and a link to
   the ESPN gamecast so the league can see where the number comes from. */

const BASE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
const SCHEMA_V = 2; // bump to invalidate cached weeks when the shape changes

export async function fetchWeek(year, week) {
  // ESPN honors `dates=` for the season; `year=` is silently ignored.
  const url = `${BASE}?dates=${year}&seasontype=2&week=${week}`;
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`ESPN ${res.status} for week ${week}`);
  const data = await res.json();
  return normalizeWeek(data, week);
}

export function normalizeWeek(data, week) {
  const games = (data.events || []).map((ev) => {
    const comp = ev.competitions?.[0] || {};
    const sides = {};
    for (const c of comp.competitors || []) {
      sides[c.homeAway] = {
        name: c.team?.displayName || "",
        abbr: c.team?.abbreviation || "",
        logo: c.team?.logo || (c.team?.logos?.[0]?.href ?? ""),
        score: c.score != null ? Number(c.score) : null,
        winner: c.winner === true,
      };
    }
    const st = ev.status?.type || {};
    const rawOdds = comp.odds?.[0] || null;
    const odds = rawOdds && (rawOdds.details || rawOdds.overUnder != null)
      ? {
          details: rawOdds.details || "",
          overUnder: rawOdds.overUnder ?? null,
          provider: rawOdds.provider?.name || "ESPN BET",
        }
      : null;
    return {
      id: String(ev.id),
      date: ev.date, // ISO kickoff (scheduled; ESPN flips state to "in" at the real start)
      state: st.state || "pre", // pre | in | post
      completed: st.completed === true,
      detail: st.shortDetail || st.detail || "",
      home: sides.home || null,
      away: sides.away || null,
      odds,
      link: `https://www.espn.com/nfl/game/_/gameId/${ev.id}`,
    };
  });
  games.sort((a, b) => new Date(a.date) - new Date(b.date));
  return { v: SCHEMA_V, week, fetchedAt: new Date().toISOString(), games };
}

/* Cache TTL by how hot the week is: seconds. Live or imminent games poll
   fast; a schedule weeks away can sit for hours (flex moves still land). */
export function ttlSeconds(weekData, now = new Date()) {
  const games = weekData.games || [];
  if (games.some((g) => g.state === "in")) return 45;
  const t = now.getTime();
  const imminent = games.some((g) => {
    const k = new Date(g.date).getTime();
    return t >= k - 30 * 60e3 && t <= k + 5 * 3600e3 && !g.completed;
  });
  if (imminent) return 60;
  if (games.length && games.every((g) => g.completed)) return games.every((g) => g.odds || g.oddsChecked) ? 7 * 86400 : 86400;
  return 6 * 3600;
}

export function isStale(weekData, now = new Date()) {
  if (!weekData?.fetchedAt || weekData.v !== SCHEMA_V) return true;
  const age = (now.getTime() - new Date(weekData.fetchedAt).getTime()) / 1000;
  return age > ttlSeconds(weekData, now);
}

/* Closing line for a game ESPN has already stripped from the scoreboard feed:
   the game summary keeps it under pickcenter. Returns the same shape as odds. */
export async function fetchClosingLine(gameId) {
  const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${encodeURIComponent(gameId)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`ESPN summary ${res.status}`);
  const data = await res.json();
  const pc = (data.pickcenter || []).find((p) => p.details || p.overUnder != null) || null;
  return pc ? { details: pc.details || "", overUnder: pc.overUnder ?? null, provider: pc.provider?.name || "ESPN BET" } : null;
}
