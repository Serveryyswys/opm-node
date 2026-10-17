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
    /** require 的实参（已去引号、已解转义）；**动态形式为 null** */
    spec: string | null;
    /**
     * 无法静态分析（变量 / 模板串 / 字符串拼接 / 三元…）。
     *
     * 这类 require 打包器改不了，而 Operit 运行时对裸名**静默返回 {}** ——
     * 于是依赖在业务里神秘失效。所以必须显式报错，不能放过。
     */
    dynamic: boolean;
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
                            // 字面量后面若还跟着运算（'a' + x / 'a' ? ...），实参其实是表达式。
                            // 以前这里会把它当成 'a' 去重写 —— 截断比忽略更糟，必须区分。
                            let after = cursor + 1;
                            while (after < length && /\s/.test(source[after])) {
                                after += 1;
                            }
                            const trailing = source[after];
                            const isExpression = trailing === '+' || trailing === '?' || trailing === '|' || trailing === '&';
                            sites.push({
                                spec: isExpression ? null : value,
                                dynamic: isExpression,
                                start: start,
                                end: cursor
                            });
                            index = cursor + 1;
                            previousMeaningful = quote;
                            continue;
                        }
                    } else {
                        // 实参不是字符串字面量：变量 / 模板串 / 三元 / 函数调用…全部无法静态改写
                        sites.push({ spec: null, dynamic: true, start: cursor, end: cursor });
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
