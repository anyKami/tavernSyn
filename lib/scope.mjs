import path from 'node:path';
import { requireThat } from './io.mjs';

export const CATEGORIES = { chats: ['chats', 'group chats', 'groups'], characters: ['characters'], worlds: ['worlds'] };
export function normalizeScope(scope) {
    if (scope === undefined || scope === null) return null;
    requireThat(Array.isArray(scope) && scope.length > 0 && scope.length <= 3
        && scope.every(name => typeof name === 'string' && Object.hasOwn(CATEGORIES, name)) && new Set(scope).size === scope.length,
    'INPUT', '请选择聊天记录、角色卡或世界书，不能提交空范围或其他类别。');
    return [...scope].sort();
}
export function scopedPaths(scope) {
    return normalizeScope(scope).flatMap(name => CATEGORIES[name].map(folder => `profile/${folder}`));
}
export function inScope(file, scope) { return scopedPaths(scope).some(root => file.startsWith(root + '/')); }
export function scopedRoots(device, scope) {
    return scopedPaths(scope).map(id => ({ id, path: path.join(device.dataRoot, device.profile, id.slice('profile/'.length)) }));
}
export function sameScope(left, right) { return JSON.stringify(normalizeScope(left)) === JSON.stringify(normalizeScope(right)); }
export function scopeLabel(scope) {
    const labels = { chats: '聊天记录（含群聊）', characters: '角色卡', worlds: '世界书' };
    return normalizeScope(scope).map(name => labels[name]).join('、');
}
