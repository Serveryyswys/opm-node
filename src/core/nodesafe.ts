'use strict';

/**
 * 文本读取的安全封装。移植自 OPM 的 src/core/nodesafe.ts。
 *
 * 与 OPM 的唯一差异：OPM 在 require('fs') 不可用时回退 Tools.Files.read；
 * opm-node 跑在 Node 上，fs 一定可用，所以去掉该回退，其余（含 stripLineNumbers）逐字保留。
 */

import { readFileSync } from 'node:fs';

/**
 * 剥掉 read 工具可能附带的行号前缀（形如 `   12| 内容` 或 `12|内容`）。
 * 幂等：没有前缀时原样返回。
 */
export function stripLineNumbers(text: string): string {
    if (!text) return text;
    const lines = text.split('\n');
    let numbered = 0;
    let checked = 0;
    for (const line of lines) {
        if (!line) continue;
        if (checked >= 5) break;
        checked += 1;
        if (/^\s*\d+\|/.test(line)) numbered += 1;
    }
    if (checked === 0 || numbered < checked) return text;
    return lines
        .map((line) => {
            const m = /^\s*\d+\|(.*)$/.exec(line);
            return m ? m[1] : line;
        })
        .join('\n');
}

export function readTextSafe(path: string): string | null {
    try {
        return stripLineNumbers(String(readFileSync(path, 'utf8')));
    } catch (_e) {
        return null;
    }
}

export async function readTextSafeAsync(path: string): Promise<string | null> {
    try {
        return stripLineNumbers(String(readFileSync(path, 'utf8')));
    } catch (_e) {
        return null;
    }
}
