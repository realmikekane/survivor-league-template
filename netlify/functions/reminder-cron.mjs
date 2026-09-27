import { blobStore, getJSON } from "../../lib/store.mjs";
import { makeToken } from "../../lib/token.mjs";
import { LEAGUE_TZ } from "../../lib/tz.mjs";

/* Fires hourly on Mondays and Thursdays (UTC); only the firing that is noon in
   the league's time zone does anything, which rides through daylight saving.
   Thursday = everyone, Monday = households still owing a pick. The API's
   once-per-week guard makes a duplicate firing harmless. US time zones always
   reach local noon on the same UTC weekday. */
export const config = { schedule: "0 * * * 1,4" };

export default async () => {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: LEAGUE_TZ, hour: "numeric", hour12: false, weekday: "short" }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value) % 24;
  const weekday = parts.find((p) => p.type === "weekday")?.value;
  if (hour !== 12 || !["Mon", "Thu"].includes(weekday)) return new Response(`skip: ${weekday} ${hour}h ${LEAGUE_TZ}`, { status: 200 });
  const cfg = await getJSON(blobStore(), "cfg");
  if (!cfg?.secret) return new Response("no league config", { status: 200 });
  const site = process.env.URL; // Netlify sets this to the site's main address
  if (!site) return new Response("no site URL", { status: 200 });
  const res = await fetch(`${site}/api/reminders/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: makeToken("admin", cfg.secret), missingOnly: weekday === "Mon", source: "cron" }),
  });
  return new Response(`${res.status} ${await res.text()}`.slice(0, 2000), { status: 200 });
};
