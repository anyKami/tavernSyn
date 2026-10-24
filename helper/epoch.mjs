// Installed before ST modules without rewriting the installed public/index.html.
const COCKTAIL_MODULES = new Set(['/script.js', '/scripts/i18n.js', '/scripts/system-messages.js', '/scripts/extensions.js', '/scripts/welcome-screen.js']);
export function isReadOnlyScript(method, url) {
    if (!['GET', 'HEAD'].includes(method)) return false;
    if (['/api/plugins/cocktail-plus/early/bridge.js', '/api/plugins/cocktail-plus/sw.js'].includes(url.pathname)) return true;
    return url.pathname === '/api/plugins/cocktail-plus/module' && url.searchParams.getAll('path').length === 1
        && COCKTAIL_MODULES.has(url.searchParams.get('path'));
}
export function browserEpoch(epoch) {
    return `;(${installEpoch.toString()})(${JSON.stringify(epoch)});`;
}
function installEpoch(epoch) {
    if (window.__TAVERNSYN__) return;
    const state = window.__TAVERNSYN__ = { epoch, pending: 0, lastWrite: 0 };
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
