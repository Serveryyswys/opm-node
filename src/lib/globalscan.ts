'use strict';

import * as acorn from 'acorn';

/**
 * 移植自 OPM 的 src/build/rewriter.ts（scanGlobalRefs 及其词法辅助函数），逐字，未改动。
 *
 * 用途：判定是否需要注入 process / Buffer 全局。
 * 与正则相比的关键区别：跳过注释与字符串、排除 `.process` 属性访问与 `process:` 对象键 ——
 * 少了这些判断，注释里出现一个 process 就会把 node.operit 整个拖进归档。
 */

function isIdentStart(c: string): boolean {
    return /[A-Za-z_$]/.test(c);
}
function isIdentPart(c: string): boolean {
    return /[A-Za-z0-9_$]/.test(c);
}
function skipString(code: string, start: number, quote: string): number {
    const n = code.length;
    let i = start + 1;
    while (i < n) {
        const c = code[i];
        if (c === '\\') { i += 2; continue; }
        if (c === quote) return i + 1;
        // 模板串里的 ${...} 不细究，整体当字符串直到匹配的闭引号
        i += 1;
    }
    return n;
}

/** 去掉引号并还原常见转义（只处理 require 参数会遇到的） */
export function scanGlobalRefs(code: string, names: string[]): string[] {
    const want = new Set(names);
    const hit = new Set<string>();
    const n = code.length;
    let i = 0;
    while (i < n) {
        const c = code[i];
        // 行注释
        if (c === '/' && code[i + 1] === '/') {
            i += 2;
            while (i < n && code[i] !== '\n') i += 1;
            continue;
        }
        // 块注释
        if (c === '/' && code[i + 1] === '*') {
            i += 2;
            while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i += 1;
            i += 2;
            continue;
        }
        // 字符串
        if (c === '"' || c === '\'' || c === '`') {
            i = skipString(code, i, c);
            continue;
        }
        // 标识符
        if (isIdentStart(c)) {
            const start = i;
            while (i < n && isIdentPart(code[i])) i += 1;
            const word = code.slice(start, i);
            if (want.has(word)) {
                // 前一非空白字符
                let p = start - 1;
                while (p >= 0 && /\s/.test(code[p])) p -= 1;
                const prevIsDot = (p >= 0 && code[p] === '.');
                // 后一非空白字符
                let q = i;
                while (q < n && /\s/.test(code[q])) q += 1;
                const nextIsColon = (q < n && code[q] === ':');
                if (!prevIsDot && !nextIsColon) hit.add(word);
            }
            continue;
        }
        i += 1;
    }
    return Array.from(hit);
}
/**
 * AST 版：判定是否**真的引用**了这些全局标识符。
 *
 * 词法版（scanGlobalRefs，OPM 原版）只看"前一个非空白不是点、后一个是冒号"——
 * 于是 `static process(item) { ... }` 这种**同名静态方法**会被误判成用到了 process，
 * 进而注入整个 process 垫片，把 node.operit 的十几个文件拖进归档。
 *
 * 返回 null 表示解析失败，调用方回退词法版。
 */
export function scanGlobalRefsAst(code: string, names: string[]): string[] | null {
    let ast: any;
    try {
        ast = acorn.parse(code, {
            ecmaVersion: 'latest',
            sourceType: 'script',
            allowReturnOutsideFunction: true,
            allowAwaitOutsideFunction: true
        });
    } catch (_e) {
        try {
            ast = acorn.parse(code, {
                ecmaVersion: 'latest',
                sourceType: 'module',
                allowReturnOutsideFunction: true,
                allowAwaitOutsideFunction: true
            });
        } catch (_e2) {
            return null;
        }
    }
    const want = new Set(names);
    const hit = new Set<string>();
    const walk = (node: any, key: string): void => {
        if (!node || typeof node !== 'object') {
            return;
        }
        if (node.type === 'Identifier' && want.has(node.name)) {
            // 排除：成员属性 a.process、对象键 { process: 1 }、标签
            if (key !== 'property' && key !== 'key' && key !== 'label') {
                hit.add(node.name);
            }
        }
        for (const k of Object.keys(node)) {
            if (k === 'loc' || k === 'start' || k === 'end') {
                continue;
            }
            const child = node[k];
            if (Array.isArray(child)) {
                for (const item of child) {
                    walk(item, k);
                }
            } else if (child && typeof child === 'object') {
                walk(child, k);
            }
        }
    };
    walk(ast, '');
    return Array.from(hit);
}
