import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { loadEnvFile } from 'node:process';

import QRCode from 'qrcode';
import { WebSocketServer, WebSocket as WsWebSocket } from 'ws';

import { isValidLanguage, LANGUAGES } from './languages.js';
import { createSession, getSession } from './session.js';

try {
  loadEnvFile();
} catch {
  /* ingen .env – då litar vi på miljövariabler utifrån */
}

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '');
const PUBLIC_DIR = new URL('../public', import.meta.url).pathname;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

if (!process.env.BERGET_API_KEY) {
  console.error('BERGET_API_KEY is missing – copy .env.example to .env and fill in your key.');
  process.exit(1);
}

function json(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  try {
    // ---- API ---------------------------------------------------------
    if (path === '/api/sessions' && req.method === 'POST') {
      const { sourceLang } = JSON.parse((await readBody(req)) || '{}');
      if (!isValidLanguage(sourceLang)) return json(res, 400, { error: 'Invalid source language' });

      const session = createSession(sourceLang);
      const listenUrl = `${PUBLIC_URL}/listen?id=${session.id}`;
      const broadcastUrl = `${PUBLIC_URL}/broadcast?id=${session.id}`;
      const qrDataUrl = await QRCode.toDataURL(listenUrl, { width: 480, margin: 2 });
      console.log(`[${session.id}] new session, source language ${sourceLang}`);
      return json(res, 201, {
        id: session.id,
        sourceLang,
        listenUrl,
        broadcastUrl,
        qrDataUrl,
      });
    }

    const sessionMatch = path.match(/^\/api\/sessions\/([\w-]+)$/);
    if (sessionMatch && req.method === 'GET') {
      const session = getSession(sessionMatch[1]);
      if (!session) return json(res, 404, { error: 'Stream not found' });
      const listenUrl = `${PUBLIC_URL}/listen?id=${session.id}`;
      return json(res, 200, {
        id: session.id,
        sourceLang: session.sourceLang,
        state: session.state,
        listeners: session.listenerCount,
        languages: LANGUAGES,
        listenUrl,
        listenQr: await QRCode.toDataURL(listenUrl, { width: 480, margin: 2 }),
      });
    }

    if (path === '/api/languages' && req.method === 'GET') {
      return json(res, 200, LANGUAGES);
    }

    if (path === '/healthz') {
      res.writeHead(200);
      return res.end('ok');
    }

    // ---- Static files ------------------------------------------------
    const alias: Record<string, string> = {
      '/': '/index.html',
      '/create': '/index.html',
      '/join': '/index.html',
      '/broadcast': '/broadcast.html',
      '/listen': '/listen.html',
      '/live': '/live.html',
    };
    const rel = alias[path] ?? alias[decodeURIComponent(path)] ?? path;
    const filePath = normalize(join(PUBLIC_DIR, rel));
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end();
    }
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ---- WebSocket ---------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/ws/broadcast') {
    const session = getSession(url.searchParams.get('id') ?? '');
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!session || !session.attachBroadcaster(ws)) {
        ws.send(JSON.stringify({ type: 'error', message: 'The stream is busy or does not exist' }));
        return ws.close();
      }
      ws.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'audio' && typeof msg.audio === 'string') {
            session.handleAudio(ws, msg.audio);
          }
        } catch {
          /* ignorera felaktiga meddelanden */
        }
      });
      ws.on('close', () => session.detachBroadcaster(ws));
    });
    return;
  }

  if (pathname === '/ws/listen') {
    const session = getSession(url.searchParams.get('id') ?? '');
    const lang = url.searchParams.get('lang') ?? 'en';
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!session || !isValidLanguage(lang)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Stream not found' }));
        return ws.close();
      }
      session.addListener(ws, lang);
      ws.on('close', () => session.removeListener(ws));
      ws.on('error', () => session.removeListener(ws));
    });
    return;
  }

  socket.destroy();
});

// Keep WebSocket connections alive behind proxies.
setInterval(() => {
  for (const ws of wss.clients) {
    if ((ws as WsWebSocket).readyState === WsWebSocket.OPEN) ws.ping();
  }
}, 30 * 1000).unref();

server.listen(PORT, () => {
  console.log(`LiveText is listening on http://localhost:${PORT}`);
  console.log(`Public URL used in QR codes: ${PUBLIC_URL}`);
});
