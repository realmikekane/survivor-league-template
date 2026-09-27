import { createHmac, timingSafeEqual } from "node:crypto";

/* HMAC session tokens shared by the API and the scheduled reminder job. */
export const sign = (subject, secret) => createHmac("sha256", secret).update(subject).digest("hex").slice(0, 32);
export const makeToken = (subject, secret) => `${subject}.${sign(subject, secret)}`;
export function verifyToken(token, secret) {
  if (!token || typeof token !== "string") return null;
  const i = token.lastIndexOf(".");
  if (i < 1) return null;
  const subject = token.slice(0, i);
  const given = Buffer.from(token.slice(i + 1));
  const want = Buffer.from(sign(subject, secret));
  return given.length === want.length && timingSafeEqual(given, want) ? subject : null;
}
