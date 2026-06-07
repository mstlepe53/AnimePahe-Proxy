const REFERER = 'https://kwik.cx/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];

function getAllowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
}

function isOriginAllowed(origin, allowed) {
  if (!allowed.length || allowed.includes('*')) return true;
  if (!origin) return true; // top-level <a download> navigation sends no Origin
  return allowed.includes(origin);
}

function corsHeaders(origin, allowed) {
  const h = new Headers();
  const allowAll = !allowed.length || allowed.includes('*');
  h.set('Access-Control-Allow-Origin', allowAll ? '*' : origin);
  h.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Range');
  h.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, Content-Type, Content-Disposition');
  h.set('Vary', 'Origin');
  return h;
}

function decodeBase64Url(s) {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4);
  return atob(padded);
}

function buildContentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('origin') || '';
    const allowed = getAllowedOrigins(env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, allowed) });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }
    if (!isOriginAllowed(origin, allowed)) {
      return new Response(`Origin "${origin}" not allowed`, { status: 403 });
    }

    const u = url.searchParams.get('u');
    if (!u) return new Response("Missing 'u' parameter", { status: 400 });

    let target;
    try {
      target = new URL(decodeBase64Url(u));
      if (target.protocol !== 'https:' && target.protocol !== 'http:') throw 0;
    } catch {
      return new Response('Invalid upstream URL', { status: 400 });
    }

    let filename = decodeURIComponent(url.pathname.split('/').pop() || '') || 'video.mp4';
    filename = filename.replace(/[\r\n]/g, '');

    const upstreamHeaders = new Headers({
      'User-Agent': USER_AGENT,
      'Referer': REFERER,
      'Accept': '*/*',
    });
    const range = request.headers.get('range');
    if (range) upstreamHeaders.set('Range', range);

    let upstream;
    try {
      upstream = await fetch(target.href, {
        method: request.method,
        headers: upstreamHeaders,
        redirect: 'follow',
      });
    } catch (e) {
      return new Response(`Upstream fetch failed: ${e.message}`, { status: 502 });
    }

    const responseHeaders = corsHeaders(origin, allowed);
    FORWARDED_RESPONSE_HEADERS.forEach(h => {
      const v = upstream.headers.get(h);
      if (v) responseHeaders.set(h, v);
    });
    responseHeaders.set('Content-Disposition', buildContentDisposition(filename));
    responseHeaders.set('Cache-Control', 'no-store');

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  }
};
