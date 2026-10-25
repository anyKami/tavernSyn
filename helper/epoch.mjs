// Installed before ST modules without rewriting the installed public/index.html.
const COCKTAIL_MODULES = new Set(['/script.js', '/scripts/i18n.js', '/scripts/system-messages.js', '/scripts/extensions.js', '/scripts/welcome-screen.js']);
export function isReadOnlyScript(method, url) {
    if (!['GET', 'HEAD'].includes(method)) return false;
    if (['/api/plugins/cocktail-plus/early/bridge.js', '/api/plugins/cocktail-plus/sw.js'].includes(url.pathname)) return true;
    return url.pathname === '/api/plugins/cocktail-plus/module' && url.searchParams.getAll('path').length === 1
        && COCKTAIL_MODULES.has(url.searchParams.get('path'));
}
export const RESOURCE_EPOCH = '__tavernsyn_epoch';
export function epochResource(method, url, headers, epoch, origin) {
    if (!['GET', 'HEAD'].includes(method) || !/^\/api\/plugins\/[^/]+\//.test(url.pathname)
        || !['script', 'worker', 'sharedworker', 'serviceworker'].includes(headers['sec-fetch-dest'])
        || headers['sec-fetch-site'] !== 'same-origin'
        || (headers['x-tavernsyn-epoch'] !== undefined && headers['x-tavernsyn-epoch'] !== epoch)) return { allowed: false };
    const values = url.searchParams.getAll(RESOURCE_EPOCH);
    if (values.length) return { allowed: values.length === 1 && values[0] === epoch };
    // A module import inherits its parent's referrer, not its query string.
    // Redirect it once to an epoch-bearing URL so deeper imports retain proof.
    try {
        const parent = new URL(headers.referer);
        const local = new URL(origin);
        const localOrigin = parent.origin === origin || (parent.protocol === local.protocol && parent.port === local.port
            && ['127.0.0.1', 'localhost', '[::1]'].includes(parent.hostname));
        if (localOrigin && parent.searchParams.getAll(RESOURCE_EPOCH).length === 1
            && parent.searchParams.get(RESOURCE_EPOCH) === epoch) {
            const target = new URL(url); target.searchParams.set(RESOURCE_EPOCH, epoch);
            return { allowed: true, redirect: target.pathname + target.search };
        }
    } catch { /* Missing/foreign referrers do not establish an instance. */ }
    return { allowed: false };
}
export function browserEpoch(epoch) {
    return `;(${installEpoch.toString()})(${JSON.stringify(epoch)});`;
}
function installEpoch(epoch) {
    if (window.__TAVERNSYN__) return;
    const state = window.__TAVERNSYN__ = { epoch, pending: 0, lastWrite: 0 };
    function resourceUrl(input) {
        const url = new URL(String(input), location.href);
        if (url.origin !== location.origin || !/^\/api\/plugins\/[^/]+\//.test(url.pathname)) return input;
        url.searchParams.set('__tavernsyn_epoch', epoch); return url.href;
    }
    // Native resource loads do not use fetch/XHR. Bind their URL to the same
    // document epoch; their existing authentication is still enforced by ST.
    if (typeof HTMLScriptElement !== 'undefined') {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
        if (descriptor?.set) Object.defineProperty(HTMLScriptElement.prototype, 'src', { ...descriptor,
            set(value) { descriptor.set.call(this, resourceUrl(value)); },
        });
        const setAttribute = Element.prototype.setAttribute;
        Element.prototype.setAttribute = function (name, value) {
            return setAttribute.call(this, name, this instanceof HTMLScriptElement && String(name).toLowerCase() === 'src' ? resourceUrl(value) : value);
        };
        function bindScripts(node) {
            if (!node || typeof node !== 'object') return;
            for (const script of [node, ...(node.querySelectorAll?.('script[src]') ?? [])]) {
                if (script instanceof HTMLScriptElement && script.hasAttribute('src')) script.setAttribute('src', resourceUrl(script.getAttribute('src')));
            }
        }
        for (const name of ['appendChild', 'insertBefore', 'replaceChild']) {
            const original = Node.prototype[name];
            Node.prototype[name] = function (node, ...args) { bindScripts(node); return original.call(this, node, ...args); };
        }
        for (const name of ['append', 'prepend', 'before', 'after', 'replaceWith']) {
            const original = Element.prototype[name];
            if (original) Element.prototype[name] = function (...nodes) { nodes.forEach(bindScripts); return original.apply(this, nodes); };
        }
    }
    for (const name of ['Worker', 'SharedWorker']) if (typeof window[name] === 'function') {
        window[name] = new Proxy(window[name], { construct(target, args, constructor) {
            return Reflect.construct(target, [resourceUrl(args[0]), ...args.slice(1)], constructor);
        } });
    }
    if (globalThis.navigator?.serviceWorker?.register) {
        const original = navigator.serviceWorker.register;
        navigator.serviceWorker.register = function (url, options) { return original.call(this, resourceUrl(url), options); };
    }
    const nativeFetch = window.fetch;
    window.fetch = async function (input, options) {
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        const method = String(options?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
        const own = url.origin === location.origin;
        const write = own && !['GET', 'HEAD', 'OPTIONS'].includes(method) && !url.pathname.startsWith('/api/plugins/tavernsyn/');
        if (own) {
            options = { ...options, headers: new Headers(options?.headers ?? (input instanceof Request ? input.headers : undefined)) };
            options.headers.set('x-tavernsyn-epoch', epoch);
        }
        if (write) state.pending++;
        try { return await nativeFetch.call(this, input, options); }
        finally { if (write) { state.pending--; state.lastWrite = Date.now(); } }
    };
    const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__tavernsynOwn = new URL(url, location.href).origin === location.origin;
        this.__tavernsynWrite = this.__tavernsynOwn && !['GET', 'HEAD', 'OPTIONS'].includes(String(method).toUpperCase());
        return open.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
        if (this.__tavernsynOwn) this.setRequestHeader('x-tavernsyn-epoch', epoch);
        if (this.__tavernsynWrite) {
            state.pending++;
            this.addEventListener('loadend', () => { state.pending--; state.lastWrite = Date.now(); }, { once: true });
        }
        return send.apply(this, args);
    };
    addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
}
