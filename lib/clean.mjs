/* Family-chat language filter. obscenity catches the standard list plus the
   usual dodges (f*ck, sh!t, bullsh1t, FUUUCK); a small pre-pass catches letters
   spaced out to slip past it (f u c k). Extra words come from League settings. */
import { RegExpMatcher, TextCensor, englishDataset, englishRecommendedTransformers, asteriskCensorStrategy, keepStartCensorStrategy } from "obscenity";

const matcher = new RegExpMatcher({ ...englishDataset.build(), ...englishRecommendedTransformers });
const censor = new TextCensor().setStrategy(keepStartCensorStrategy(asteriskCensorStrategy()));
const mask = (w) => w[0] + "*".repeat(Math.max(1, w.length - 1));

export function cleanText(text, extraWords = "") {
  let out = String(text ?? "");
  if (!out) return out;
  // Spaced-out letters: "f u c k" / "s.h.i.t" -> check the joined word, mask the whole run.
  out = out.replace(/\b(?:[a-z][\s._*-]+){2,}[a-z]\b/gi, (run) => {
    const joined = run.replace(/[\s._*-]/g, "");
    return matcher.hasMatch(joined) ? mask(run) : run;
  });
  out = censor.applyTo(out, matcher.getAllMatches(out));
  const extra = String(extraWords || "").split(/[,\n]/).map((w) => w.trim()).filter((w) => w.length >= 2);
  for (const w of extra) {
    const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    out = out.replace(re, (m) => mask(m));
  }
  return out;
}

export const isClean = (text, extraWords = "") => cleanText(text, extraWords) === String(text ?? "");

