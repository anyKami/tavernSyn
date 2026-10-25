// Cancellation safety is narrower than the browser epoch gate. In particular,
// an arbitrary GET, a thumbnail cache miss, or a plugin script can still write.
const PUBLIC_FILES = new Set(['/', '/index.html', '/login.html', '/favicon.ico', '/lib.js', '/manifest.json',
    '/robots.txt', '/script.js', '/st-launcher.ico', '/st.ico', '/style.css']);
const FILE_PREFIXES = ['/css/', '/error/', '/img/', '/lib/', '/locales/', '/scripts/', '/sounds/', '/webfonts/',
    '/backgrounds/', '/characters/', '/User%20Avatars/', '/assets/', '/user/images/', '/user/files/'];
const OWN_READS = new Set(['/api/plugins/tavernsyn/status', '/api/plugins/tavernsyn/wait', '/api/plugins/tavernsyn/configuration']);
const OWN_TABS = '/api/plugins/tavernsyn/tabs';
const SAMPLE_LIMIT = 6;

function rawPath(target) {
    if (typeof target !== 'string') return null;
    const pathname = target.split('?', 1)[0];
    // WHATWG URL normalization can hide the Express route actually reached by
    // targets such as /proxy/../css/file.css. Classify the original target only.
    if (!pathname.startsWith('/') || pathname.startsWith('//') || /[\\#\x00-\x20\x7f]/.test(pathname)
        || /%(?:2f|5c)/i.test(pathname)) return null;
    try {
        const decoded = decodeURIComponent(pathname);
        if (/[\\\x00-\x1f\x7f]/.test(decoded) || /%[a-f0-9]{2}/i.test(decoded)
            || decoded.split('/').some(segment => segment === '.' || segment === '..')) return null;
    } catch { return null; }
    return pathname;
}

function classification(request) {
    const method = request.method;
    const pathname = rawPath(request.url);
    const headers = request.headers ?? {};
    let route = '/<other>';
    if (pathname) {
        if (PUBLIC_FILES.has(pathname)) route = pathname;
        else if (OWN_READS.has(pathname) || pathname === OWN_TABS) route = pathname;
        else if (pathname.startsWith('/api/plugins/')) route = '/api/plugins/*';
        else if (pathname.startsWith('/api/')) route = '/api/*';
        else if (pathname === '/thumbnail' || pathname.startsWith('/thumbnail/')) route = '/thumbnail';
        else if (pathname.startsWith('/proxy/')) route = '/proxy/*';
        else {
            const prefix = FILE_PREFIXES.find(prefix => pathname.startsWith(prefix));
            if (prefix) route = `${prefix}*`;
        }
    }
    const contentType = typeof headers['content-type'] === 'string' ? headers['content-type'] : '';
    // ST's global multer middleware also accepts multipart GET/HEAD requests.
    // Even a user-file read must therefore have no request body to be exempt.
    const bodyless = headers['transfer-encoding'] === undefined
        && (headers['content-length'] === undefined || headers['content-length'] === '0')
        && !/^multipart\//i.test(contentType);
    const fileRead = pathname && (PUBLIC_FILES.has(pathname) || FILE_PREFIXES.some(prefix => pathname.startsWith(prefix)));
    const safe = !!pathname && ((['GET', 'HEAD'].includes(method) && bodyless && (fileRead || OWN_READS.has(pathname)))
        // This endpoint only refreshes an in-memory tab lease. Require JSON so
        // the global upload middleware cannot write an avatar before it runs.
        || (method === 'POST' && pathname === OWN_TABS && /^application\/json(?:\s*;|$)/i.test(contentType)));
    return { method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method) ? method : 'OTHER', route, safe };
}

export function createDrainTracker(state, { now = Date.now } = {}) {
    state.active ??= 0; state.uncertain ??= false;
    const active = new Set(), uncertain = [];
    let uncertainCount = 0, safeAborts = 0;
    const sample = record => ({ method: record.method, route: record.route, ageMs: Math.max(0, now() - record.started) });
    function summary() {
        return { active: state.active, uncertain: state.uncertain, uncertainCount, safeAborts,
            activeSamples: [...active].slice(0, SAMPLE_LIMIT).map(sample), uncertainSamples: uncertain.map(sample) };
    }
    function failure() {
        if (!state.active && !state.uncertain) return null;
        const detail = summary();
        const samples = [...detail.uncertainSamples, ...detail.activeSamples].slice(0, SAMPLE_LIMIT)
            .map(record => `${record.method} ${record.route} (${Math.ceil(record.ageMs / 1000)} 秒)`).join('；');
        return { code: 'DRAIN', message: `请求未能安全排空：仍在处理 ${detail.active} 个，取消后状态不明 ${detail.uncertain ? Math.max(1, detail.uncertainCount) : 0} 个。${samples ? `请求类型：${samples}。` : ''}酒馆保持运行，未强制停机。` };
    }
    function track(request, response) {
        const record = { ...classification(request), started: now() };
        state.active++; active.add(record);
        let finished = false;
        const settle = aborted => {
            if (finished) return;
            finished = true; state.active--; active.delete(record);
            if (!aborted) return;
            if (record.safe) safeAborts++;
            else {
                state.uncertain = true; uncertainCount++;
                if (uncertain.length < SAMPLE_LIMIT) uncertain.push(record);
            }
        };
        response.once('finish', () => settle(false));
        response.once('close', () => settle(true));
    }
    return { track, summary, failure };
}
