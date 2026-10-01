/**
 * The language the person writes in, from their own recent messages: the
 * device/browser language is not necessarily the one they speak (iOS does
 * not tell an app which keyboard is in use, and a phone or browser set to
 * English in France still reports English to someone who writes and speaks
 * French). Shared by mobile's native dictation and the web's Web Speech
 * dictation, both of which prefer this over the raw device/browser locale.
 * Counts common short words of a few languages (no single letters: `a`, `e`,
 * `o`, `i`, `y` are words in several of them and swamp short English or
 * Spanish text); `undefined` when too little text or no clear winner.
 */
const COMMON_WORDS: Record<string, readonly string[]> = {
  fr: [
    "le",
    "la",
    "les",
    "de",
    "des",
    "du",
    "et",
    "est",
    "que",
    "qui",
    "pas",
    "je",
    "tu",
    "pour",
    "une",
    "un",
    "ça",
    "ce",
    "dans",
    "sur",
    "avec",
    "mais",
    "on",
    "il",
    "c'est",
    "j'ai",
  ],
  en: [
    "the",
    "and",
    "is",
    "are",
    "to",
    "of",
    "that",
    "it",
    "you",
    "for",
    "with",
    "this",
    "not",
    "what",
    "can",
    "do",
    "my",
    "on",
    "in",
    "have",
    "be",
  ],
  es: [
    "el",
    "la",
    "los",
    "las",
    "de",
    "que",
    "es",
    "en",
    "un",
    "una",
    "por",
    "para",
    "con",
    "no",
    "lo",
    "se",
    "pero",
    "como",
    "está",
  ],
  de: [
    "der",
    "die",
    "das",
    "und",
    "ist",
    "nicht",
    "ich",
    "du",
    "ein",
    "eine",
    "zu",
    "mit",
    "auf",
    "für",
    "den",
    "es",
    "wie",
    "was",
    "aber",
  ],
  it: [
    "il",
    "la",
    "di",
    "che",
    "è",
    "un",
    "una",
    "per",
    "non",
    "con",
    "sono",
    "mi",
    "ma",
    "come",
    "questo",
    "anche",
    "del",
  ],
  pt: [
    "os",
    "de",
    "que",
    "é",
    "um",
    "uma",
    "para",
    "com",
    "não",
    "do",
    "da",
    "em",
    "mas",
    "como",
    "você",
  ],
};

export function writtenLanguage(texts: readonly string[]): string | undefined {
  const words = texts
    .join(" ")
    .toLowerCase()
    .replace(/[’]/g, "'")
    .split(/[^\p{L}']+/u)
    .filter(Boolean);
  if (words.length < 3) return undefined;
  let best: string | undefined;
  let bestScore = 0;
  let second = 0;
  for (const [language, common] of Object.entries(COMMON_WORDS)) {
    const set = new Set(common);
    const score = words.filter((word) => set.has(word)).length;
    if (score > bestScore) {
      second = bestScore;
      bestScore = score;
      best = language;
    } else if (score > second) {
      second = score;
    }
  }
  // A clear lead, not a tie between languages that share short words.
  return bestScore >= 2 && bestScore >= second * 1.5 ? best : undefined;
}
