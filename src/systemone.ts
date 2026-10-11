const ENDPOINT = 'https://api.berget.ai/v1/systemone';
// berget/bev förstår svenska klart bättre än laya-latest på att bedöma
// naturliga brytpunkter i talad text (mätt: 0.81–0.93 säker separation på
// mitt-i-mening vs avslutad tanke, mot laya 0.25–0.40 brus).
const MODEL = process.env.SYSTEMONE_MODEL ?? 'berget/bev';

export interface BreakJudgement {
  /** Förväntat värde på skalan 0–2 (0=mitt i mening, 1=mening slut, 2=tanke slut). */
  score: number;
  /** Sannolikhet för "en avslutad tanke/tema slutar här". */
  thoughtEnd: number;
}

/**
 * Frågar System One (berget/bev) om pausen efter `context` är en naturlig
 * plats för styckebrytning i livetextning. Returnerar null vid fel – anropet
 * får aldrig stoppa textflödet (kort timeout + omförsök).
 */
export async function judgeBreakPoint(context: string): Promise<BreakJudgement | null> {
  // Berget ger just nu sporadiska 401:or ("missing plan_code") på enstaka
  // backends – några snabba omförsök jämnar ut det.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${process.env.BERGET_API_KEY}`,
          'content-type': 'application/json',
        },
        signal: AbortSignal.timeout(800),
        body: JSON.stringify({
          model: MODEL,
          state: context,
          questions: {
            cut: {
              type: 'score',
              instructions:
                'This is the end of a live speech transcript cut at a pause in speech. Rate what the text is doing at the cut.',
              criteria: [
                'stops mid-sentence, more words clearly follow',
                'a sentence ends but the same thought continues',
                'a complete thought or topic ends',
              ],
            },
          },
        }),
      });
      if (!res.ok) {
        if (attempt < 3) await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      const data = await res.json();
      const cut = data?.answers?.cut;
      if (cut?.type !== 'score') return null;
      return { score: cut.score, thoughtEnd: cut.probabilities?.['2'] ?? 0 };
    } catch {
      if (attempt < 3) await new Promise((r) => setTimeout(r, 150));
    }
  }
  return null;
}
