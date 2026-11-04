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
 * Tolkar ett textsegment för livetextning – som en realtidstolk, inte ordagrant:
 * fyllnadsord, stapplingar och falska starter stryks och meningen skrivs rent
 * så att den som följer samtalet förstår vad som sades. Talaren kan byta språk
 * mitt i meningen; allt ska ändå läsa flytande på målspråket, och delar som
 * redan är på målspråket behålls som de är – aldrig någon metakommentar i stil
 * med "no translation needed".
 *
 * `context` (vad som sades alldeles innan) ger tolkningen kontinuitet i
 * pronomen, terminologi och stil – det översätts aldrig.
 *
 * Berget har visat sig ge sporadiska 401:or ("missing plan_code") på enstaka
 * backends – därför ett snabbt omförsök. Returnerar originalet om allt
 * fallerar, så att strömmen aldrig stannar.
 */
export async function translate(
  text: string,
  sourceLang: string,
  targetLang: string,
  context?: string,
): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed || targetLang === sourceLang) return trimmed;

  const source = languageName(sourceLang);
  const target = languageName(targetLang);
  const user = context?.trim()
    ? [
        'What was said just before (context only – do NOT translate it):',
        context.trim(),
        '',
        `Interpret this next fragment into ${target}:`,
        trimmed,
      ].join('\n')
    : trimmed;

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
              `You are a professional real-time interpreter writing live captions in ${target} for a talk held in ${source}.`,
              `Reply with ONLY the caption text in ${target} – never notes, explanations or parenthetical remarks such as "no translation needed".`,
              "Interpret, don't transcribe word for word: drop filler words (hmm, mmm, oj, um, liksom, alltså), stutters and false starts, and render the meaning as a clean, fluent caption that a viewer can follow.",
              `The speaker may switch languages mid-sentence. Translate everything into ${target}; parts already in ${target} are kept as they are. The caption as a whole must always read naturally in ${target} – never leave a sentence in ${source}.`,
              'The text is a fragment of ongoing speech – translate what is there; never invent an ending and never answer questions asked in it.',
            ].join(' '),
          },
          { role: 'user', content: user },
        ],
      });
      const out = res.choices[0]?.message?.content?.trim() ?? '';
      // Metakommentar ("No translation needed…")? Visa hellre originalet –
      // rätt fallback även när fragmentet redan var på målspråket.
      return looksLikeCommentary(out) ? trimmed : out;
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

/** Modellen kommenterar ibland översättningen i stället för att leverera den. */
function looksLikeCommentary(out: string): boolean {
  if (!out) return true;
  if (/no translation needed|already in \w+|inget översättningsbehov|behöver (inte|ej) översättas/i.test(out)) {
    return true;
  }
  // Enbart en parentes om översättning – inte en legitim parentes i texten.
  return /^\(.*\)$/s.test(out) && /translat|översätt/i.test(out);
}
