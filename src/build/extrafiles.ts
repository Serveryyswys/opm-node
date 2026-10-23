/**
 */

import { readdirSync, statSync, existsSync } from 'node:fs';

export function normalizePath(p: string): string {
    if (!p) return '';
    let s = String(p).replace(/\\/g, '/');
    const out: string[] = [];
    for (const seg of s.split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') { out.pop(); continue; }
        out.push(seg);
    }
    return out.join('/');
}

function join(a: string, b: string): string {
    if (!a) return b;
    if (!b) return a;
    return a.endsWith('/') ? a + b : a + '/' + b;
}

/** 判断归档内路径是否命中排除前缀 */
export function isExcluded(archivePath: string, excludePrefixes: string[]): boolean {
    const p = normalizePath(archivePath);
    for (const pre of excludePrefixes) {
        const norm = normalizePath(pre);
        if (!norm) continue;
        const withSlash = norm.endsWith('/') ? norm : norm + '/';
        if (p === norm || p.indexOf(withSlash) === 0) return true;
    }
    return false;
}
/**
 * 展开 extra_files 单个条目：
 *   - 若是目录 -> 递归收集其下全部文件（相对 projectDir 的路径）
 *   - 否则 -> 原样返回 [rel]（由调用方再判存在性）
 *
 * 目录判定用 node.operit 的 fs.statSync（javabridge -> java.io.File），
 * 明确给出 isFile / isDirectory，不必靠 list 返回结构去猜。
 * 注意：opm 打包时会把这个 `require('fs')` 重写成 node.operit 的 fs.js。
 */
export async function expandExtraEntry(
    projectDir: string,
    rel: string,
    excludePrefixes: string[]
): Promise<string[]> {
    const abs = join(projectDir, rel);

    const kind = probeKind(abs);
    if (kind === 'file') return [rel];
    if (kind === 'none') return [rel];  // 不存在：原样交回，由调用方报「文件不存在」

    // kind === 'dir'：递归收集
    const out: string[] = [];
    const walk = async (dirRel: string, depth: number): Promise<void> => {
        if (depth <= 0) return;
        let items: any[] = [];
        try {
            items = readdirSync(join(projectDir, dirRel), { withFileTypes: true })
                .map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
        } catch (_e) { return; }
        for (const it of items) {
            const name = it.name || it.fileName || '';
            if (!name) continue;
            const childRel = normalizePath(dirRel ? dirRel + '/' + name : name);
            if (isExcluded(childRel, excludePrefixes)) continue;
            const flag = it.isDirectory === true || it.type === 'directory' || it.directory === true;
            const childAbs = join(projectDir, childRel);
            const childKind = flag ? 'dir' : probeKind(childAbs);
            if (childKind === 'dir') {
                if (name === 'node_modules' || name.startsWith('.')) continue;
                await walk(childRel, depth - 1);
            } else if (childKind === 'file') {
                out.push(childRel);
            }
        }
    };
    await walk(rel, 10);

    // 空目录：返回空，由调用方报「空目录」
    return out;
}

/** 用 fs.statSync 判断路径类型：'file' / 'dir' / 'none' / 'unknown'。 */
function probeKind(abs: string): 'file' | 'dir' | 'none' | 'unknown' {
    try {
        if (!existsSync(abs)) return 'none';
        const st = statSync(abs);
        if (st.isDirectory()) return 'dir';
        if (st.isFile()) return 'file';
        return 'unknown';
    } catch (_e) {
        return 'none';
    }
}
