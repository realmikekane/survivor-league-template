/* Netlify build step, run after the tests. Link previews (iMessage, Slack,
   Facebook) read index.html without running any JavaScript, so the site URL
   and league name are stamped into its tags here. Netlify provides URL; set
   LEAGUE_NAME in the Netlify environment to match your league. */
import { readFileSync, writeFileSync } from "node:fs";

const file = new URL("../public/index.html", import.meta.url);
const site = (process.env.URL || "").replace(/\/$/, "");
const name = (process.env.LEAGUE_NAME || "Survivor League")
  .replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const html = readFileSync(file, "utf8");
writeFileSync(file, html.replaceAll("%SITE_URL%", site).replaceAll("%LEAGUE_NAME%", name));
console.log(`site-meta: ${site || "(no URL, previews use relative links)"} / ${name}`);
