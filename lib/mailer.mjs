/* Outbound email through Resend. Configured entirely by environment:
   RESEND_API_KEY, REMINDER_FROM, REMINDER_REPLY_TO, REMINDER_SUMMARY_TO. */

export function mailConfig(env = process.env) {
  const cfg = {
    apiKey: env.RESEND_API_KEY || "",
    from: env.REMINDER_FROM || "",
    replyTo: env.REMINDER_REPLY_TO || "",
    summaryTo: env.REMINDER_SUMMARY_TO || "",
  };
  // Only these two block sending; the other two just go unused when blank.
  const missing = [!cfg.apiKey && "RESEND_API_KEY", !cfg.from && "REMINDER_FROM"].filter(Boolean);
  return { ...cfg, missing, ready: missing.length === 0 };
}

/* Resend error bodies are JSON with a readable message; show that, not the envelope. */
function resendError(status, body) {
  let msg = body;
  try { msg = JSON.parse(body).message || body; } catch { /* not JSON */ }
  return `${status} ${String(msg).slice(0, 160)}`;
}

/* Resend's batch endpoint takes up to 100 messages per call. By default one
   invalid message rejects the whole call, so a single mistyped address would
   silence the entire league. Permissive mode sends the rest and reports each
   rejection by its position in the call. */
export async function sendReminderBatch({ items, from, replyTo, apiKey, fetchImpl = fetch }) {
  const sent = [], failed = [];
  for (let i = 0; i < items.length; i += 100) {
    const chunk = items.slice(i, i + 100);
    const body = chunk.map((it) => ({ from, to: [it.email], ...(replyTo ? { reply_to: replyTo } : {}), subject: it.subject, html: it.html, text: it.text }));
    let res;
    try {
      res = await fetchImpl("https://api.resend.com/emails/batch", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "x-batch-validation": "permissive" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
    } catch (e) {
      chunk.forEach((it) => failed.push({ name: it.name, email: it.email, error: e.message }));
      continue;
    }
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      chunk.forEach((it) => failed.push({ name: it.name, email: it.email, error: resendError(res.status, t) }));
      continue;
    }
    const out = await res.json().catch(() => ({}));
    const rejected = new Map((out.errors || []).map((x) => [x.index, x.message]));
    chunk.forEach((it, k) => {
      if (rejected.has(k)) failed.push({ name: it.name, email: it.email, error: `rejected: ${rejected.get(k)}` });
      else sent.push({ name: it.name, email: it.email, missingCount: it.missingCount });
    });
  }
  return { sent, failed };
}

export async function sendPlain({ to, subject, text, from, apiKey, fetchImpl = fetch }) {
  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, text }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`summary email ${res.status}`);
}

export function summaryText(s) {
  const line = (x) => `${x.name} <${x.email}>${x.missingCount ? `  [${x.missingCount} missing]` : ""}${x.error ? `  ${x.error}` : ""}`;
  return [
    `${s.leagueName || "Survivor League"} reminders, week ${s.week}, run: ${s.label === "missing" ? "missing picks only" : "everyone"}`,
    `Sent at ${s.at}`,
    "",
    `SENT (${s.sent.length})`, s.sent.map(line).join("\n") || "(none)",
    "",
    `FAILED (${s.failed.length})`, s.failed.map(line).join("\n") || "(none)",
    "",
    `Skipped, no email (${s.skippedNoEmail.length}): ${s.skippedNoEmail.join(", ") || "(none)"}`,
    `Skipped, email reminders off (${s.skippedOptedOut.length}): ${s.skippedOptedOut.join(", ") || "(none)"}`,
    `Skipped, eliminated or no active slots (${s.skippedInactive.length}): ${s.skippedInactive.join(", ") || "(none)"}`,
  ].join("\n");
}
