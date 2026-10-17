'use strict';

/**
 * 从 JS 源码里找出所有 require(...) 调用点。
 *
 * 必须跳过注释与字符串 —— 否则文档注释里写一个 require 例子就会被当成真依赖，
 * 把一个不存在的模块拖进归档、或者让构建直接失败。
 *
 * 状态机而不是正则：正则没法同时正确处理 \` 模板串、字符串里的引号逃逸、
 * 以及 "// require('x')" 这种情况。
 */

export interface RequireSite {
    /** require 的实参（已去引号、已解转义） */
    spec: string;
    /** spec 在源码里的起止下标（不含引号），替换时用 */
    start: number;
    end: number;
}

const QUOTES = new Set(["'", '"', '\`']);

export function findRequires(source: string): RequireSite[] {
    const sites: RequireSite[] = [];
    let index = 0;
    const length = source.length;

    // 上一个有意义字符，用于区分正则字面量与除号
    let previousMeaningful = '';

    while (index < length) {
        const char = source[index];

        // 行注释
        if (char === '/' && source[index + 1] === '/') {
            const newline = source.indexOf('\n', index);
            index = newline < 0 ? length : newline + 1;
            continue;
        }
        // 块注释
        if (char === '/' && source[index + 1] === '*') {
            const close = source.indexOf('*/', index + 2);
            index = close < 0 ? length : close + 2;
            continue;
        }
        // 字符串 / 模板串
        if (QUOTES.has(char)) {
            const quote = char;
            index += 1;
            while (index < length) {
                if (source[index] === '\\') {
                    index += 2;
                    continue;
                }
                if (source[index] === quote) {
                    index += 1;
                    break;
                }
                index += 1;
            }
            previousMeaningful = quote;
            continue;
        }
        // 正则字面量：出现在"期待操作数"的位置时才是正则，否则是除号
        if (char === '/' && (previousMeaningful === '' || '(,=:[!&|?{};+-*%~^<>'.includes(previousMeaningful))) {
            index += 1;
            let inClass = false;
            while (index < length) {
                const c = source[index];
                if (c === '\\') {
                    index += 2;
                    continue;
                }
                if (c === '[') {
                    inClass = true;
                } else if (c === ']') {
                    inClass = false;
                } else if (c === '/' && !inClass) {
                    index += 1;
                    break;
                } else if (c === '\n') {
                    break;
                }
                index += 1;
            }
            previousMeaningful = '/';
            continue;
        }

        if (char === 'r' && source.startsWith('require', index)) {
            const before = index === 0 ? '' : source[index - 1];
            const isIdentifierChar = /[A-Za-z0-9_$]/.test(before);
            if (!isIdentifierChar) {
                let cursor = index + 'require'.length;
                while (cursor < length && /\s/.test(source[cursor])) {
                    cursor += 1;
                }
                if (source[cursor] === '(') {
                    cursor += 1;
                    while (cursor < length && /\s/.test(source[cursor])) {
                        cursor += 1;
                    }
                    const quote = source[cursor];
                    if (quote === "'" || quote === '"') {
                        cursor += 1;
                        const start = cursor;
                        let value = '';
                        while (cursor < length && source[cursor] !== quote) {
                            if (source[cursor] === '\\') {
                                const escaped = source[cursor + 1];
                                value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped;
                                cursor += 2;
                                continue;
                            }
                            value += source[cursor];
                            cursor += 1;
                        }
                        if (cursor < length) {
                            sites.push({ spec: value, start: start, end: cursor });
                            index = cursor + 1;
                            previousMeaningful = quote;
                            continue;
                        }
                    }
                }
            }
        }

        if (!/\s/.test(char)) {
            previousMeaningful = char;
        }
        index += 1;
    }

    return sites;
}
