import { blobStore, getJSON } from "../../lib/store.mjs";
import { makeToken } from "../../lib/token.mjs";

/* Every 15 minutes. The :17 firing is the full tick, where the API decides
   whether the host says anything at all (quiet hours, daily budget, whether
   there is a real hook). The other three are snuff-only: they exist so a
   knocked-out slot gets named minutes after the final whistle instead of up to
   an hour later. Netlify fires approximately, so which pass this is comes from
   the real clock, not from the schedule string. */
export const config = { schedule: "2,17,32,47 * * * *" };

export default async () => {
  const cfg = await getJSON(blobStore(), "cfg");
  if (!cfg?.secret) return new Response("no league config", { status: 200 });
  const site = process.env.URL; // Netlify sets this to the site's main address
  if (!site) return new Response("no site URL", { status: 200 });
  const minute = new Date().getUTCMinutes();
  const snuffOnly = !(minute >= 12 && minute < 27);
  const res = await fetch(`${site}/api/host/tick`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: makeToken("admin", cfg.secret), source: "cron", snuffOnly }),
  });
  return new Response(`${res.status} ${await res.text()}`.slice(0, 500), { status: 200 });
};
