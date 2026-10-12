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
 * Renskriver ett färdigt talstycke: punktion, mellanslag, kapitalisering och
 * uppenbara dikteringsfel från transkriberingen. Ändrar aldrig betydelsen –
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
              `You copy-edit a live caption segment in ${languageName(lang)}.`,
              'Fix punctuation, spacing, capitalization and obvious speech-recognition slips.',
              'Never add, remove, reorder or rephrase words – the meaning must be identical.',
              'Reply with ONLY the cleaned text, no quotes or commentary.',
            ].join(' '),
          },
          { role: 'user', content: trimmed },
        ],
      });
      const out = res.choices[0]?.message?.content?.trim();
      // Ordn-kontroll: om modellen gått omvägar (berrar paraphrase) behåll råtexten
      if (!out || out.length > trimmed.length * 2.5 || out.length < trimmed.length * 0.4) {
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
