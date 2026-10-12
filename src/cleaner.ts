import OpenAI from 'openai';

import { languageName } from './languages.js';

let client: OpenAI | null = null;

/** Lazy: instansieras först vid användning, efter att .env hunnit laddas. */
function getClient(): OpenAI {
  client ??= new OpenAI({
    apiKey: process.env.BERGET_API_KEY,
    baseURL: 'https://api.berget.ai/v1',
  });
  return client;
}

const MODEL = process.env.CLEAN_MODEL ?? 'google/gemma-4-31B-it';
const ENABLED = process.env.CLEAN !== 'off';

/**
 * Renskriver ett färdigt talstycke till läsbart skriftspråk: dikteringsfel,
 * punktion och kapitalisering rättas, fyllnadsord ("eh", "liksom"), falska
 * starter och upprepningar strukits, och grammatiken dras ihop så att
 * historiken går att skumma. Betydelsen och alla fakta bevaras alltid –
 * rensningen sker i en enda kedja före både sändning, översättning och
 * historik, så det finns precis en källa till sanning.
 *
 * Fail-open: vid fel (eller CLEAN=off) används råtexten – flödet stannar aldrig.
 */
export async function cleanSegment(text: string, lang: string): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed || !ENABLED) return trimmed;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await getClient().chat.completions.create({
        model: MODEL,
        temperature: 0,
        max_tokens: Math.max(64, Math.round(trimmed.length * 1.6)),
        messages: [
          {
            role: 'system',
            content: [
              `You rewrite a live caption segment in ${languageName(lang)} into clean, readable written prose.`,
              'Fix speech-recognition slips, punctuation and capitalization.',
              'Remove filler words (um, eh, liksom, alltså ...), false starts, stutters and needless repetitions, and tighten grammar so the history is scannable.',
              'Preserve every fact and the original meaning – never add information.',
              'If the fragment is very short or incomplete, only fix obvious errors.',
              'Reply with ONLY the rewritten text, no quotes or commentary.',
            ].join(' '),
          },
          { role: 'user', content: trimmed },
        ],
      });
      const out = res.choices[0]?.message?.content?.trim();
      // Ordn-kontroll: gick modellen omvägar (hallucination/paraphras) behåll råtexten.
      // Nedre gränsen är generös – ihopdragning av fyllnadsord får krympa texten.
      if (!out || out.length > trimmed.length * 2.5 || out.length < trimmed.length * 0.25) {
        return trimmed;
      }
      return out;
    } catch (err) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      console.error('[clean] fel – använder råtext:', err);
      return trimmed;
    }
  }
  return trimmed;
}
