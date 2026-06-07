// ── AnimePahe Proxy – Cloudflare Worker (Optimised) ──────────────────────────
// Key improvements over the original:
//   1. CF Cache API – segment (.ts/.m4s) responses are cached at the edge for
//      30 s; playlists (.m3u8) are cached for 3 s. This means the second viewer
//      of the same segment pays zero latency to origin.
//   2. In-flight deduplication via a per-isolate Map, so concurrent requests for
//      the same uncached segment only hit origin once.
//   3. Streaming response for non-playlist content – body bytes are forwarded to
//      the client as they arrive instead of buffering the whole thing first.
//   4. No unnecessary Cache-Control: no-store on segment/playlist responses.
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG = {
    DEFAULT_REFERER: 'https://kwik.cx',
    ANIMEPAHE_BASE: 'https://animepahe.si',
    DEFAULT_USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    FORWARD_HEADERS: ['range', 'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since', 'authorization', 'cookie'],
    UPSTREAM_HEADERS: ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'],
    CORS: {
        ALLOW_METHODS: 'GET, POST, OPTIONS, HEAD',
        ALLOW_HEADERS: 'Content-Type, X-Requested-With, Range, Authorization, Cookie',
        EXPOSE_HEADERS: 'Content-Range, Content-Length, Accept-Ranges, Content-Type'
    }
};

// Per-isolate in-flight deduplication
const inFlight = new Map();

const cookieJar = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────
function isOriginAllowed(origin, allowedOrigins, hasUrlParam) {
    if (!allowedOrigins.length || allowedOrigins.includes('*')) return true;
    if (!origin && hasUrlParam) return true;
    return allowedOrigins.includes(origin);
}

function buildUpstreamHeaders(request, url, headersParam) {
    const headers = new Headers({
        'User-Agent': CONFIG.DEFAULT_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Upgrade-Insecure-Requests': '1'
    });

    CONFIG.FORWARD_HEADERS.forEach(h => {
        const v = request.headers.get(h);
        if (v) headers.set(h, v);
    });

    let referer = CONFIG.DEFAULT_REFERER;
    if (headersParam) {
        try {
            Object.entries(JSON.parse(headersParam)).forEach(([k, v]) => {
                const lk = k.toLowerCase(); headers.set(lk, v);
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
        headers.set('referer', rs);
        try { headers.set('origin', new URL(rs).origin); } catch { headers.set('origin', rs); }
    }

    if (url.hostname.includes('owocdn')) {
        headers.set('Sec-Fetch-Dest', 'iframe');
        headers.set('Sec-Fetch-Mode', 'navigate');
        headers.set('Sec-Fetch-Site', 'cross-site');
    } else {
        headers.set('Sec-Fetch-Dest', 'empty');
        headers.set('Sec-Fetch-Mode', 'cors');
        headers.set('Sec-Fetch-Site', 'cross-site');
    }

    const stored = cookieJar.get(url.hostname);
    if (stored) {
        const cur = headers.get('cookie');
        headers.set('cookie', cur ? cur + '; ' + stored : stored);
    }
    return headers;
}

function updateCookieJar(url, response) {
    const sc = response.headers.get('set-cookie');
    if (!sc) return;
    const cur = cookieJar.get(url.hostname) || '';
    const merged = [...new Set([...cur.split('; '), ...sc.split(', ').map(c => c.split(';')[0])])].filter(Boolean).join('; ');
    cookieJar.set(url.hostname, merged);
}

function setCorsHeaders(request, responseHeaders) {
    const origin = request.headers.get('origin');
    responseHeaders.set('Access-Control-Allow-Origin', origin || '*');
    if (origin) responseHeaders.set('Access-Control-Allow-Credentials', 'true');
    responseHeaders.set('Access-Control-Allow-Methods', CONFIG.CORS.ALLOW_METHODS);
    responseHeaders.set('Access-Control-Allow-Headers', CONFIG.CORS.ALLOW_HEADERS);
    responseHeaders.set('Access-Control-Expose-Headers', CONFIG.CORS.EXPOSE_HEADERS);
    responseHeaders.set('Vary', 'Origin');
    responseHeaders.set('X-Proxy-By', 'cf-worker-m3u8-proxy');
}

function proxyUrl(targetUrl, workerUrl, headersParam) {
    const u = new URL(workerUrl.origin + workerUrl.pathname);
    u.searchParams.set('url', targetUrl);
    if (headersParam) u.searchParams.set('headers', headersParam);
    return u.toString();
}

function proxyPlaylist(content, targetUrl, workerUrl, headersParam) {
    return content.split('\n').map(line => {
        const t = line.trim();
        if (!t || t.startsWith('#EXTM3U') || t.startsWith('#EXT-X-VERSION')) return line;
        if (t.startsWith('#')) {
            return line.replace(/(URI\s*=\s*['"])([^'"]+)(['"])/gi, (m, pre, uri, suf) => {
                try { return pre + proxyUrl(new URL(uri, targetUrl.href).href, workerUrl, headersParam) + suf; } catch { return m; }
            });
        }
        try { return proxyUrl(new URL(t, targetUrl.href).href, workerUrl, headersParam); } catch { return line; }
    }).join('\n');
}

// ── Worker entry point ────────────────────────────────────────────────────────
export default {
    async fetch(request, env, ctx) {
        const workerUrl    = new URL(request.url);
        const origin       = request.headers.get('origin') || '';
        const allowedOrigins = (env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);

        // CORS preflight
        if (request.method === 'OPTIONS') {
            const h = new Headers();
            setCorsHeaders(request, h);
            return new Response(null, { status: 204, headers: h });
        }

        if (!isOriginAllowed(origin, allowedOrigins, workerUrl.searchParams.has('url')))
            return new Response(`Origin "${origin}" blacklisted.`, { status: 403 });

        const targetUrlStr = workerUrl.searchParams.get('url');
        if (!targetUrlStr) return new Response("Missing 'url' parameter.", { status: 400 });

        let targetUrl;
        try { targetUrl = new URL(targetUrlStr); } catch { return new Response('Invalid URL.', { status: 400 }); }

        const headersParam = workerUrl.searchParams.get('headers') || '';
        const pathname     = targetUrl.pathname.toLowerCase();
        const isSegment    = pathname.endsWith('.ts') || pathname.endsWith('.m4s') || pathname.includes('/segment-');
        const isPlaylist   = pathname.endsWith('.m3u8');

        // ── CF Cache API lookup ───────────────────────────────────────────────
        const cache    = caches.default;
        // Build a cache key that encodes the proxy URL so different header params
        // don't collide. We use a GET request as the cache key.
        const cacheReq = new Request(request.url, { method: 'GET' });

        if (isSegment || isPlaylist) {
            const cached = await cache.match(cacheReq);
            if (cached) return cached;
        }

        // ── In-flight deduplication ───────────────────────────────────────────
        const inflightKey = targetUrl.href + '|' + headersParam;
        if (inFlight.has(inflightKey)) {
            try {
                const r = await inFlight.get(inflightKey);
                // Clone because Response body can only be consumed once
                return r.clone();
            } catch {}
        }

        // ── Fetch upstream ────────────────────────────────────────────────────
        const upstreamHeaders = buildUpstreamHeaders(request, targetUrl, headersParam);

        const fetchAndProcess = async () => {
            const response = await fetch(targetUrl.href, {
                method: 'GET',
                headers: upstreamHeaders,
                redirect: 'follow'
            });

            updateCookieJar(targetUrl, response);

            if (!response.ok && response.status !== 206) {
                const rh = new Headers();
                setCorsHeaders(request, rh);
                return new Response(`Upstream error: ${response.status} ${response.statusText}`, { status: response.status, headers: rh });
            }

            const responseHeaders = new Headers();
            setCorsHeaders(request, responseHeaders);

            const ct      = response.headers.get('content-type') || '';
            const isM3U8  = isPlaylist || ct.includes('mpegurl') || ct.includes('x-mpegurl');

            if (isM3U8) {
                const text = await response.text();
                const isActual = text.trimStart().startsWith('#EXTM3U');
                if (isActual) {
                    let hp = headersParam;
                    if (!hp) {
                        const dr = upstreamHeaders.get('referer');
                        if (dr) hp = JSON.stringify({ referer: dr });
                    }
                    const proxied = proxyPlaylist(text, targetUrl, workerUrl, hp);
                    responseHeaders.set('Content-Type', 'application/vnd.apple.mpegurl');
                    // Short cache for playlists
                    responseHeaders.set('Cache-Control', 'public, max-age=3');
                    const finalResp = new Response(proxied, { status: 200, headers: responseHeaders });
                    ctx.waitUntil(cache.put(cacheReq, finalResp.clone()));
                    return finalResp;
                }
                responseHeaders.set('Content-Type', ct || 'application/octet-stream');
                return new Response(text, { status: response.status, headers: responseHeaders });
            }

            // Binary (segment / key / mp4)
            CONFIG.UPSTREAM_HEADERS.forEach(h => {
                const v = response.headers.get(h);
                if (v) responseHeaders.set(h, v);
            });

            const isKey = pathname.endsWith('.key');
            if (isSegment) responseHeaders.set('Content-Type', 'video/mp2t');
            else if (isKey) responseHeaders.set('Content-Type', 'application/octet-stream');

            ['x-amz-cf-pop', 'x-amz-cf-id', 'x-cache', 'via', 'server'].forEach(h => responseHeaders.delete(h));

            if (isSegment) {
                // Cache segments at the edge for 30 s — they are immutable
                responseHeaders.set('Cache-Control', 'public, max-age=30, immutable');
                // We must buffer to store in CF cache AND stream to the client.
                // Use tee() to do both simultaneously.
                const [forCache, forClient] = response.body.tee();
                const cacheResp  = new Response(forCache, { status: response.status, headers: responseHeaders });
                ctx.waitUntil(cache.put(cacheReq, cacheResp));
                return new Response(forClient, { status: response.status, headers: responseHeaders });
            }

            // Non-cached passthrough (mp4, key, etc.) – stream directly
            return new Response(response.body, { status: response.status, headers: responseHeaders });
        };

        const promise = fetchAndProcess();
        if (isSegment || isPlaylist) inFlight.set(inflightKey, promise);

        let result;
        try {
            result = await promise;
        } catch (e) {
            inFlight.delete(inflightKey);
            return new Response(JSON.stringify({ error: e.message }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        inFlight.delete(inflightKey);
        return result;
    }
};
