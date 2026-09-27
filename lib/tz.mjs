/* The league's clock. Kickoff times, deadlines, the Host's quiet hours, and
   reminder timing all read this zone. Set LEAGUE_TIMEZONE in Netlify to any
   IANA zone name (America/Chicago, America/Los_Angeles, ...). Unset or
   unrecognized, it falls back to Eastern, the NFL's own clock. */
const valid = (tz) => {
  if (!tz) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return null; }
};

export const LEAGUE_TZ = valid(process.env.LEAGUE_TIMEZONE) || "America/New_York";

/* "ET", "CT", "MT", "PT" for the US zones; whatever Intl calls it elsewhere. */
export function tzLabel(tz = LEAGUE_TZ, date = new Date()) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
    .formatToParts(date).find((p) => p.type === "timeZoneName")?.value || "";
  return /^[ECMP][SD]T$/.test(name) ? `${name[0]}T` : name;
}
