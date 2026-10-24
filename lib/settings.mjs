import { requireThat } from './io.mjs';

export const DEVICE_POINTERS = [
    '/extension_settings/tavernsyn', '/power_user/movingUI', '/power_user/movingUIState',
    '/power_user/movingUIPreset', '/power_user/chat_width', '/power_user/font_scale',
];
function parts(pointer) {
    requireThat(typeof pointer === 'string' && pointer.startsWith('/') && !/~(?![01])/.test(pointer), 'POINTER', '本机字段应使用 JSON Pointer。');
    const result = pointer.slice(1).split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'));
    requireThat(result.every(p => p && !['__proto__', 'prototype', 'constructor'].includes(p)), 'POINTER', '不安全的 JSON Pointer。');
    return result;
}
function lookup(object, keys) {
    let value = object;
    for (const key of keys) { if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return { found: false }; value = value[key]; }
    return { found: true, value: structuredClone(value) };
}
function write(object, keys, item) {
    let cursor = object;
    for (const key of keys.slice(0, -1)) {
        if (!cursor[key] || typeof cursor[key] !== 'object') { if (!item.found) return; cursor[key] = {}; }
        cursor = cursor[key];
    }
    if (item.found) cursor[keys.at(-1)] = item.value; else delete cursor[keys.at(-1)];
}
export function sharedSettings(settings, pointers = DEVICE_POINTERS) {
    const result = structuredClone(settings);
    for (const pointer of pointers) write(result, parts(pointer), { found: false });
    return result;
}
export function preserveSettings(incoming, local, pointers = DEVICE_POINTERS) {
    const result = sharedSettings(incoming, pointers);
    for (const pointer of pointers) { const keys = parts(pointer); write(result, keys, lookup(local, keys)); }
    return result;
}
export function projectionMatches(settings, expected) {
    return Object.entries(expected).every(([key, value]) => JSON.stringify(settings[key]) === JSON.stringify(value));
}
