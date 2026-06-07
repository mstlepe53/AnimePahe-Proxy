import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { CONFIG } from './config.js';
import { registerDownloadRoutes } from './download-handler.js';

const require = createRequire(import.meta.url);
const cloudscraper = require('cloudscraper');

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Cookie jar ────────────────────────────────────────────────────────────────
const cookieJar = new Map();

// ── Response cache ────────────────────────────────────────────────────────────
// Segment (.ts/.m4s) files are immutable once written — cache 30 s.
// Playlists (.m3u8) change every few seconds  — cache 3 s.
const CACHE_TTL_SEGMENT  = 30_000;
const CACHE_TTL_PLAYLIST =  3_000;
const responseCache = new Map();

function cacheGet(key) {
    const e = responseCache.get(key);
    if (!e) return null;
    if (Date.now() - e.ts > e.ttl) { responseCache.delete(key); return null; }
    return e;
}

function cacheSet(key, body, headers, ttl) {
    if (responseCache.size >= 200) {
        const del = Math.floor(responseCache.size * 0.2);
        let i = 0;
        for (const k of responseCache.keys()) { if (i++ >= del) break; responseCache.delete(k); }
    }
    responseCache.set(key, { body, headers, ts: Date.now(), ttl });
}

// ── In-flight deduplication ───────────────────────────────────────────────────
// If two requests for the same segment arrive at the same time,
// the second one awaits the first fetch instead of firing its own.
const inFlight = new Map();

// ── Error guards ──────────────────────────────────────────────────────────────
process.on('uncaughtException',  err => console.error('CRITICAL Uncaught:', err));
process.on('unhandledRejection', (r) => console.error('CRITICAL Rejection:', r));

// ── Helpers ───────────────────────────────────────────────────────────────────
function safeSender(res) {
    let sent = false;
    return (code, data) => { if (!sent && !res.headersSent) { sent = true; res.status(code).send(data); } };
}

function isOriginAllowed(origin, hasUrlParam) {
    const a = CONFIG.ALLOWED_ORIGINS;
    if (!a || !a.length || a.includes('*')) return true;
    if (!origin && hasUrlParam) return true;
    return a.includes(origin);
}

function buildUpstreamHeaders(req, url, headersParam) {
    const h = {
        'User-Agent': CONFIG.DEFAULT_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Upgrade-Insecure-Requests': '1'
    };
    CONFIG.FORWARD_HEADERS.forEach(k => { if (req.headers[k]) h[k] = req.headers[k]; });

    let referer = CONFIG.DEFAULT_REFERER;
    if (headersParam) {
        try {
            Object.entries(JSON.parse(headersParam)).forEach(([k, v]) => {
                const lk = k.toLowerCase(); h[lk] = v;
                if (lk === 'referer' || lk === 'referrer') referer = v;
            });
        } catch {}
    }

    if (referer) {
        let rs = decodeURIComponent(referer);
        if (url.hostname.includes('kwik') || url.hostname.includes('kwics')) {
            rs = CONFIG.ANIMEPAHE_BASE; if (!rs.endsWith('/')) rs += '/';
        } else if ((url.hostname.includes('owocdn') || url.hostname.includes('cdn')) && !rs.includes('kwik.cx')) {
            rs = CONFIG.DEFAULT_REFERER;
        }
        if (rs.includes('kwik.cx') && !rs.endsWith('/')) rs += '/';
        h['referer'] = rs;
        try { h['origin'] = new URL(rs).origin; } catch { h['origin'] = rs; }
    }

    if (url.hostname.includes('owocdn')) {
        h['Sec-Fetch-Dest'] = 'iframe'; h['Sec-Fetch-Mode'] = 'navigate'; h['Sec-Fetch-Site'] = 'cross-site';
    } else {
        h['Sec-Fetch-Dest'] = 'empty'; h['Sec-Fetch-Mode'] = 'cors'; h['Sec-Fetch-Site'] = 'cross-site';
    }
    const stored = cookieJar.get(url.hostname);
    if (stored) h['cookie'] = h['cookie'] ? h['cookie'] + '; ' + stored : stored;
    return h;
}

function updateCookieJar(url, resp) {
    const sc = resp.headers['set-cookie'];
    if (!sc) return;
    const cur = cookieJar.get(url.hostname) || '';
    const cookies = Array.isArray(sc) ? sc : [sc];
    const merged = [...new Set([...cur.split('; '), ...cookies.map(c => c.split(';')[0])])].filter(Boolean).join('; ');
    cookieJar.set(url.hostname, merged);
}

function setCorsHeaders(req, res) {
    const origin = req.headers.origin;
    const a = CONFIG.ALLOWED_ORIGINS;
    if (origin && (!a || !a.length || a.includes('*') || a.includes(origin))) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', CONFIG.CORS.ALLOW_METHODS);
    res.setHeader('Access-Control-Allow-Headers', CONFIG.CORS.ALLOW_HEADERS);
    res.setHeader('Access-Control-Expose-Headers', CONFIG.CORS.EXPOSE_HEADERS);
    res.setHeader('X-Proxy-By', 'm3u8-proxy');
    res.setHeader('X-Content-Type-Options', 'nosniff');
}

function proxyUrl(targetUrl, headersParam) {
    return '/m3u8-proxy?url=' + encodeURIComponent(targetUrl) + (headersParam ? '&headers=' + encodeURIComponent(headersParam) : '');
}

function proxyPlaylist(content, url, headersParam) {
    return content.split('\n').map(line => {
        const t = line.trim();
        if (!t || t.startsWith('#EXTM3U') || t.startsWith('#EXT-X-VERSION')) return line;
        if (t.startsWith('#')) {
            return line.replace(/(URI\s*=\s*")([^"]+)(")/gi, (m, pre, uri, suf) => {
                try { return pre + proxyUrl(new URL(uri, url.href).href, headersParam) + suf; } catch { return m; }
            });
        }
        try { return proxyUrl(new URL(t, url.href).href, headersParam); } catch { return line; }
    }).join('\n');
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.status(200).send('Welcome to site'));
app.options('/m3u8-proxy', (req, res) => { setCorsHeaders(req, res); res.status(204).end(); });

app.get('/m3u8-proxy', async (req, res) => {
    const send = safeSender(res);
    if (!isOriginAllowed(req.headers.origin || '', !!req.query.url))
        return send(403, `Origin "${req.headers.origin}" is not allowed.`);

    const urlStr = req.query.url;
    if (!urlStr) return send(400, { message: 'URL is required' });

    let url;
    try { url = new URL(urlStr); } catch { return send(400, { message: 'Invalid URL' }); }

    const headersParam = req.query.headers ? decodeURIComponent(req.query.headers) : '';
    const pathname     = url.pathname.toLowerCase();
    const isSegment    = pathname.endsWith('.ts') || pathname.endsWith('.m4s') || pathname.includes('/segment-');
    const isPlaylist   = pathname.endsWith('.m3u8');
    const isMP4        = pathname.endsWith('.mp4');
    const cacheKey     = url.href + '|' + headersParam;

    // ── Cache hit ─────────────────────────────────────────────────────────────
    if (isSegment || isPlaylist) {
        const hit = cacheGet(cacheKey);
        if (hit) {
            setCorsHeaders(req, res);
            Object.entries(hit.headers).forEach(([k, v]) => res.setHeader(k, v));
            res.setHeader('Cache-Control', isSegment ? 'public, max-age=30, immutable' : 'public, max-age=3');
            return res.status(200).send(hit.body);
        }
    }

    // ── In-flight deduplification ─────────────────────────────────────────────
    if (inFlight.has(cacheKey)) {
        try {
            const r = await inFlight.get(cacheKey);
            setCorsHeaders(req, res);
            Object.entries(r.headers).forEach(([k, v]) => res.setHeader(k, v));
            return res.status(r.status).send(r.body);
        } catch (e) { return send(502, { message: e.message }); }
    }

    // ── Upstream fetch ────────────────────────────────────────────────────────
    const upstream = (async () => {
        const resp = await cloudscraper({
            method: 'GET',
            url: url.href,
            headers: buildUpstreamHeaders(req, url, headersParam),
            encoding: null,
            resolveWithFullResponse: true,
            timeout: 20_000,
            strictSSL: !isMP4,
            // Socket keep-alive — reuse TCP connections to the same CDN host
            agentOptions: { keepAlive: true, maxSockets: 64, keepAliveMsecs: 15_000 }
        });

        updateCookieJar(url, resp);

        const ct = resp.headers['content-type'] || '';
        const isM3U8 = isPlaylist || ct.includes('mpegURL') || ct.includes('x-mpegurl');

        if (isM3U8) {
            const text  = resp.body.toString('utf8');
            const body  = proxyPlaylist(text, url, headersParam);
            const hdrs  = { 'Content-Type': 'application/vnd.apple.mpegurl' };
            cacheSet(cacheKey, body, hdrs, CACHE_TTL_PLAYLIST);
            return { body, headers: hdrs, status: 200 };
        }

        if (resp.statusCode >= 400) {
            const err = new Error('Upstream error');
            err.statusCode = resp.statusCode;
            err.body       = resp.body.toString('utf8').substring(0, 1000);
            throw err;
        }

        const hdrs = {};
        CONFIG.UPSTREAM_HEADERS.forEach(k => { if (resp.headers[k]) hdrs[k] = resp.headers[k]; });
        if (isSegment) cacheSet(cacheKey, resp.body, hdrs, CACHE_TTL_SEGMENT);
        return { body: resp.body, headers: hdrs, status: resp.statusCode };
    })();

    if (isSegment || isPlaylist) inFlight.set(cacheKey, upstream);

    let result;
    try {
        result = await upstream;
    } catch (err) {
        console.error('Upstream error:', err.message);
        inFlight.delete(cacheKey);
        if (err.statusCode) return send(err.statusCode, { message: 'Upstream error', upstreamStatus: err.statusCode, body: err.body });
        if (err.response)   return send(err.response.statusCode || 502, { message: 'Cloudscraper error', error: err.message });
        return send(500, { message: err.message });
    }
    inFlight.delete(cacheKey);

    setCorsHeaders(req, res);
    Object.entries(result.headers).forEach(([k, v]) => res.setHeader(k, v));
    res.setHeader('Cache-Control', isSegment ? 'public, max-age=30, immutable' : isPlaylist ? 'public, max-age=3' : 'no-store');
    res.writeHead(result.status);
    res.end(result.body);
});

registerDownloadRoutes(app);

const server = app.listen(CONFIG.PORT, () => console.log(`Server listening on PORT: ${CONFIG.PORT}`));
// Increase keep-alive so the server's own HTTP connections stay warm
server.keepAliveTimeout = 65_000;
server.headersTimeout    = 66_000;
