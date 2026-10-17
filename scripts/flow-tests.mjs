// Flow tests – server-semantiker + hela kedjan (transkribering → översättning)
// Köra: node scripts/flow-tests.mjs [base-url]   (default http://localhost:3000)
// Kräver /tmp/two-voices.wav för pipeline-testet (annars hoppas det över).
import { readFileSync, existsSync } from 'node:fs';
import WebSocket from 'ws';

const BASE = process.argv[2] || 'http://localhost:3000';
const WS_BASE = BASE.replace(/^http/, 'ws');
const WAV = '/tmp/two-voices.wav';

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${extra ? ' – ' + extra : ''}`); }
};
const j = (r) => r.json();
const waiter = (ws, pred, ms, label) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(null), ms);
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (pred(m)) { clearTimeout(t); resolve(m); }
  });
});

async function main() {
  console.log(`\n— HTTP/API mot ${BASE} —`);
  {
    const r = await fetch(`${BASE}/api/sessions/BADCODE`);
    ok('GET okänt rum → 404', r.status === 404, `status ${r.status}`);
    const r2 = await fetch(`${BASE}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const d = await j(r2);
    ok('POST {} → 201 sv', r2.status === 201 && d.sourceLang === 'sv' && /^[A-Z0-9]{6}$/.test(d.id), JSON.stringify(d).slice(0, 80));
    ok('svaret har rätt fält', ['id', 'sourceLang', 'listenUrl', 'qrDataUrl'].every(k => k in d) && !('broadcastUrl' in d));
    const ids = new Set();
    for (let i = 0; i < 10; i++) ids.add((await j(await fetch(`${BASE}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))).id);
    ok('10 creates → 10 unika id:n', ids.size === 10, `${ids.size}`);
  }

  let id;
  {
    const r = await fetch(`${BASE}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    id = (await j(r)).id;
  }
  console.log(`\n— WS-semantik på session ${id} —`);

  const open = (path) => new Promise((res, rej) => {
    const w = new WebSocket(path);
    w.on('open', () => res(w));
    w.on('error', rej);
  });

  { // bad id on both endpoints
    const w1 = new WebSocket(`${WS_BASE}/ws/broadcast?id=NOSUCH`);
    const m1 = await waiter(w1, m => m.type === 'error', 3000, 'err');
    ok('broadcast till okänd kod → error', !!m1);
    w1.close();
    const w2 = new WebSocket(`${WS_BASE}/ws/listen?id=NOSUCH&lang=en`);
    const m2 = await waiter(w2, m => m.type === 'error', 3000, 'err');
    ok('listen till okänd kod → error', !!m2);
    w2.close();
    const w3 = new WebSocket(`${WS_BASE}/ws/listen?id=${id}&lang=klingon`);
    const m3 = await waiter(w3, m => m.type === 'error', 3000, 'err');
    ok('ogiltigt lyssnarspråk → error', !!m3);
    w3.close();
  }

  { // rollclaim: första broadcaster får rollen, andra avvisas; första kan fortsätta
    const b1 = await open(`${WS_BASE}/ws/broadcast?id=${id}`);
    const b2p = new Promise((res) => { const w = new WebSocket(`${WS_BASE}/ws/broadcast?id=${id}`); w.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.type === 'error') res(m); }); });
    ok('2:a broadcaster avvisas', !!(await b2p));
    ok('1:a broadcaster fortsatt öppen', b1.readyState === 1);
    b1.close();

    await new Promise(r => setTimeout(r, 300));
    const b3 = await open(`${WS_BASE}/ws/broadcast?id=${id}`);
    ok('rollen frigörs efter close', b3.readyState === 1, b3.readyState);
    b3.close();
  }

  console.log(`\n— Ingest (INGEST_API_KEY ${process.env.INGEST_API_KEY ? 'satt' : 'osatt'}) —`);
  const KEY = process.env.INGEST_API_KEY;
  const post = (p, body, key) => fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });

  if (!KEY) {
    const r = await post(`/api/sessions/${id}/segments`, { text: 'hej' });
    ok('ingest avstängd utan nyckel → 404', r.status === 404, `status ${r.status}`);
    const r2 = await post(`/api/sessions/${id}/insights`, { kind: 'note', text: 'hej' });
    ok('insights avstängt utan nyckel → 404', r2.status === 404, `status ${r2.status}`);
  } else {
    ok('saknad auth → 401', (await post(`/api/sessions/${id}/segments`, { text: 'hej' })).status === 401);
    ok('fel nyckel → 401', (await post(`/api/sessions/${id}/segments`, { text: 'hej' }, 'fel-nyckel')).status === 401);
    ok('saknad text → 400', (await post(`/api/sessions/${id}/segments`, { speaker: 'X' }, KEY)).status === 400);
    ok('okänd session → 404', (await post('/api/sessions/NOSUCH/segments', { text: 'hej' }, KEY)).status === 404);
    ok('segment >4000 tecken → 400', (await post(`/api/sessions/${id}/segments`, { text: 'x'.repeat(4001) }, KEY)).status === 400);
    ok('insight >1000 tecken → 400', (await post(`/api/sessions/${id}/insights`, { kind: 'note', text: 'x'.repeat(1001) }, KEY)).status === 400);
    { // trasig JSON ska ge 400, inte sväljas som 404
      const r = await fetch(`${BASE}/api/sessions/${id}/segments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: '{inte json',
      });
      ok('trasig JSON → 400', r.status === 400, `status ${r.status}`);
    }

    // Lyssnare på källspråket (sv) – då kortsluts översättningen och testet
    // behöver varken BERGET_API_KEY eller nätverk mot api.berget.ai.
    const lw = await open(`${WS_BASE}/ws/listen?id=${id}&lang=sv`);

    const seg1P = waiter(lw, m => m.type === 'final' && m.speakerName === 'Magnus', 4000);
    const rSeg = await post(`/api/sessions/${id}/segments`, { speaker: 'Magnus', text: 'Vi börjar med budgeten.' }, KEY);
    ok('segment ingest → 202', rSeg.status === 202, `status ${rSeg.status}`);
    const seg1 = await seg1P;
    ok('lyssnare fick final med speakerName', !!seg1 && seg1.text === 'Vi börjar med budgeten.');
    ok('namnbyte → nytt stycke + speaker-flagga', seg1?.gapBefore === true && seg1?.speaker === true);

    const seg2P = waiter(lw, m => m.type === 'final' && m.text.includes('aktieägarna'), 4000);
    await post(`/api/sessions/${id}/segments`, { speaker: 'Magnus', text: 'Nästa punkt gäller aktieägarna.' }, KEY);
    const seg2 = await seg2P;
    ok('samma talare → inget nytt stycke', seg2?.gapBefore === false && seg2?.speaker === false && seg2?.speakerName === 'Magnus');

    const seg3P = waiter(lw, m => m.type === 'final' && m.speakerName === 'Isabelle', 4000);
    await post(`/api/sessions/${id}/segments`, { speaker: 'Isabelle', text: 'Jag tar den punkten.' }, KEY);
    const seg3 = await seg3P;
    ok('ny talare → nytt stycke igen', seg3?.gapBefore === true && seg3?.speaker === true);

    // Insights: broadcast, upsert på key, replay till sen anslutning
    const ins1P = waiter(lw, m => m.type === 'insight' && m.key === 'a1', 4000);
    const rIns = await post(`/api/sessions/${id}/insights`, { kind: 'action', text: 'Magnus bokar demo', key: 'a1' }, KEY);
    const insBody = await j(rIns);
    ok('insight ingest → 202 med key', rIns.status === 202 && insBody.key === 'a1', `status ${rIns.status}`);
    ok('lyssnare fick insight', (await ins1P)?.text === 'Magnus bokar demo');

    const ins2P = waiter(lw, m => m.type === 'insight' && m.key === 'a1' && m.text.includes('fredag'), 4000);
    await post(`/api/sessions/${id}/insights`, { kind: 'action', text: 'Magnus bokar demo på fredag', key: 'a1' }, KEY);
    ok('upsert på samma key ersätter', !!(await ins2P));

    const ins3P = waiter(lw, m => m.type === 'insight' && m.kind === 'note', 4000);
    await post(`/api/sessions/${id}/insights`, { kind: 'klingon', text: 'Ogiltig kind blir note' }, KEY);
    ok('ogiltig kind → note', !!(await ins3P));

    const late = await open(`${WS_BASE}/ws/listen?id=${id}&lang=sv`);
    // Båda waiters måste sättas upp direkt – replayen kommer i samma svep.
    const replaySegP = waiter(late, m => m.type === 'final' && m.speakerName === 'Isabelle', 4000);
    const replayInsP = waiter(late, m => m.type === 'insight' && m.key === 'a1', 4000);
    ok('sen anslutning: segment replayas med speakerName', !!(await replaySegP));
    ok('sen anslutning: insights replayas (uppdaterad text)', (await replayInsP)?.text === 'Magnus bokar demo på fredag');
    late.close();
    lw.close();
  }

  if (existsSync(WAV)) {
    console.log(`\n— Pipeline: 3 samtidiga lyssnare på olika språk + sen anslutning —`);
    const pcm = readFileSync(WAV).subarray(44);
    const langs = ['sv', 'en', 'de'];
    const finals = Object.fromEntries(langs.map(l => [l, []]));
    const listeners = langs.map(lang => {
      const w = new WebSocket(`${WS_BASE}/ws/listen?id=${id}&lang=${lang}`);
      w.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.type === 'final') finals[lang].push(m); });
      return w;
    });
    await Promise.all(listeners.map(w => new Promise(r => w.on('open', r))));

    const bc = await open(`${WS_BASE}/ws/broadcast?id=${id}`);
    await waiter(bc, m => m.type === 'state' && m.state === 'ready', 25000, 'ready')
      .then(m => ok('transkriberare redo', !!m));
    const t0 = Date.now();
    const CHUNK = 9600;
    for (let off = 0; off < pcm.length; off += CHUNK) {
      bc.send(JSON.stringify({ type: 'audio', audio: pcm.subarray(off, off + CHUNK).toString('base64') }));
      await new Promise(r => setTimeout(r, 200));
      if (Date.now() - t0 > 25000) break;
    }
    await new Promise(r => setTimeout(r, 6000)); // slutspurt av finals
    for (const lang of langs)
      ok(`${lang}-lyssnare fick finals`, finals[lang].length >= 1, `${finals[lang].length} st`);
    ok('olika språk i utdata', (finals.sv[0]?.text || '') !== (finals.en[0]?.text || ''));

    // Sen anslutning ska få historik replay direkt
    const late = new WebSocket(`${WS_BASE}/ws/listen?id=${id}&lang=en`);
    const replay = await waiter(late, m => m.type === 'final', 4000, 'replay');
    ok('sen anslutning får historik direkt', !!replay);
    late.close();

    // Stäng broadcaster, alla wss fortsätter existera krashfritt
    bc.close();
    listeners.forEach(w => w.close());
    console.log('  ', langs.map(l => `${l}: ${finals[l].map(f => f.text.slice(0, 40)).join(' / ')}`).join('\n   '));
  } else {
    console.log(`\n— (hoppade pipeline-test: ${WAV} saknas) —`);
  }

  console.log(`\n==> ${passed} PASS, ${failed} FAIL\n`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
