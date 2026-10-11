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

// Obs: reasoning-modeller (Qwen3.8, GLM-5.3-Flash) läcker chain-of-thought
// i chat-svaren – Gemma följer instruktionen och svarar rent.
const MODEL = process.env.TRANSLATE_MODEL ?? 'google/gemma-4-31B-it';

/**
 * Översätter ett textsegment för livetextning. Berget har visat sig ge
 * sporadiska 401:or ("missing plan_code") på enstaka backends – därför ett
 * snabbt omförsök. Returnerar originalet om allt fallerar, så att strömmen
 * aldrig stannar.
 */
export async function translate(
  text: string,
  sourceLang: string,
  targetLang: string,
): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed || targetLang === sourceLang) return trimmed;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await getClient().chat.completions.create({
        model: MODEL,
        temperature: 0,
        max_tokens: Math.max(64, trimmed.length * 2),
        messages: [
          {
            role: 'system',
            content: [
              `You are a live caption interpreter. Translate from ${languageName(sourceLang)} to ${languageName(targetLang)}.`,
              'Reply with ONLY the translation – no commentary, no quotes.',
              'The text comes in fragments from speech recognition; translate what is written, keep the meaning.',
            ].join(' '),
          },
          { role: 'user', content: trimmed },
        ],
      });
      return res.choices[0]?.message?.content?.trim() || trimmed;
    } catch (err) {
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      console.error('[translate] fel efter omförsök:', err);
      return trimmed;
    }
  }
  return trimmed;
}
