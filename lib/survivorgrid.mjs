/* SurvivorGrid's W% column: each team's chance of winning this week, from the
   consensus moneyline across books. The page is server-rendered: one <tr> per
   team with three "dist" cells (EV, W%, P%) and a "teamname" cell (abbr). */
const UA = "SurvivorLeagueApp/1.0";

export async function fetchSurvivorGrid(fetchImpl = fetch) {
  const res = await fetchImpl("https://www.survivorgrid.com/", { headers: { "user-agent": UA, accept: "text/html" }, signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`SurvivorGrid ${res.status}`);
  return parseSurvivorGrid(await res.text());
}

export function parseSurvivorGrid(html) {
  const siteWeek = Number((String(html).match(/Week\s+(\d+)/i) || [])[1]) || null;
  const probs = {};
  for (const row of String(html).matchAll(/<tr id="t\d+"[^>]*>([\s\S]*?)<\/tr>/g)) {
    const dist = [...row[1].matchAll(/<td class="dist">([^<]*)<\/td>/g)].map((m) => m[1].trim());
    // The team cell grows a result tag once the game is final: SEA<span class="resultW">(W)</span>
    const abbr = (row[1].match(/<td class="teamname">\s*([A-Za-z]{2,4})/) || [])[1]?.toUpperCase();
    const wp = parseFloat((dist[1] || "").replace("%", ""));
    if (abbr && Number.isFinite(wp)) probs[abbr] = Math.round(wp * 10) / 1000; // "80.5%" -> 0.805
  }
  return { siteWeek, probs };
}
