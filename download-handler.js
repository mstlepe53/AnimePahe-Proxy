import { CONFIG } from './config.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const cloudscraper = require('cloudscraper');

const DOWNLOAD_REFERER = 'https://kwik.cx/';
const FORWARDED_RESPONSE_HEADERS = [
    'content-type', 'content-length', 'content-range',
    'accept-ranges', 'last-modified', 'etag'
];

function downloadOriginAllowed(origin) {
    const a = CONFIG.ALLOWED_ORIGINS;
    if (!a || !a.length || a.includes('*')) return true;
    if (!origin) return true;
    return a.includes(origin);
}

function setDownloadCors(req, res) {
    const origin  = req.headers.origin || '';
    const allowAll = !CONFIG.ALLOWED_ORIGINS.length || CONFIG.ALLOWED_ORIGINS.includes('*');
    res.setHeader('Access-Control-Allow-Origin', allowAll ? '*' : origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, Content-Type, Content-Disposition');
    res.setHeader('Vary', 'Origin');
}

function buildContentDisposition(filename) {
    const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function handleDownload(req, res) {
    setDownloadCors(req, res);

    if (!downloadOriginAllowed(req.headers.origin || ''))
        return res.status(403).send(`Origin "${req.headers.origin}" not allowed`);

    const u = Array.isArray(req.query.u) ? req.query.u[0] : req.query.u;
    if (!u) return res.status(400).send("Missing 'u' parameter");

    let target;
    try {
        target = new URL(Buffer.from(u, 'base64url').toString('utf8'));
        if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error('bad protocol');
    } catch {
        return res.status(400).send('Invalid upstream URL');
    }

    let filename = decodeURIComponent(req.path.split('/').pop() || '') || 'video.mp4';
    filename = filename.replace(/[\r\n]/g, '');

    const headers = {
        'User-Agent': CONFIG.DEFAULT_USER_AGENT,
        'Referer': DOWNLOAD_REFERER,
        'Accept': '*/*',
        // Tell the server we accept compressed data – saves bandwidth/time
        'Accept-Encoding': 'gzip, deflate, br'
    };
    if (req.headers.range) headers['Range'] = req.headers.range;

    // Stream the response directly to the client without buffering the entire file
    const upstream = cloudscraper({
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        uri: target.href,
        headers,
        encoding: null,        // binary stream
        strictSSL: false,
        followAllRedirects: true,
        // Socket keep-alive for the download connection
        agentOptions: { keepAlive: true, maxSockets: 32, keepAliveMsecs: 15_000 }
    });

    let responded = false;

    upstream.on('response', (resp) => {
        responded = true;
        FORWARDED_RESPONSE_HEADERS.forEach(h => {
            const v = resp.headers[h];
            if (v) res.setHeader(h, v);
        });
        res.setHeader('Content-Disposition', buildContentDisposition(filename));
        // Allow the browser to cache the downloaded file on disk
        res.setHeader('Cache-Control', 'no-store');
        res.status(resp.statusCode);
    });

    upstream.on('error', (e) => {
        if (!responded && !res.headersSent) res.status(502).send(`Upstream fetch failed: ${e.message}`);
        else if (!res.writableEnded) res.destroy();
    });

    // Clean up upstream when client disconnects (saves bandwidth)
    res.on('close', () => { try { upstream.abort(); } catch {} });

    // Pipe streams directly – zero-copy transfer to the client
    upstream.pipe(res);
}

export function registerDownloadRoutes(app) {
    app.options('*', (req, res) => { setDownloadCors(req, res); res.status(204).end(); });
    app.get('*',  handleDownload);
    app.head('*', handleDownload);
}
