'use strict';

/**
 * TS 模式：识别 TypeScript 工程，调项目的 tsc 编译，再给出「归档路径 -> 磁盘文件」的映射。
 *
 * 为什么需要映射：归档内的路径**始终以 manifest 视角为准**（manifest 写 dist/main.js，
 * 归档里就是 dist/main.js，一个字符不改），而编译产物落在 tsconfig 的 outDir（可能是 .opm_build/）。
 * 于是查找磁盘文件时要按 原样 -> 产物目录 -> 逐级剥前导段 依次尝试。
 * 这样项目结构可以"千姿百态"，manifest 里写 dist/main.js 还是 main.js 都能对上。
 */

import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

export interface TypeScriptPlan {
    /** 是否 TS 工程 */
    isTypeScript: boolean;
    /** tsconfig 的绝对路径（isTypeScript 为 false 时为空串） */
    tsconfigPath: string;
    /** 编译产物目录（绝对路径）；null 表示与源码同目录 */
    outDir: string | null;
}

/** 去掉 tsconfig 里允许的注释与尾逗号 —— JSON.parse 不认这些。 */
function parseJsonc(text: string): Record<string, unknown> {
    const withoutComments = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const withoutTrailingCommas = withoutComments.replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(withoutTrailingCommas) as Record<string, unknown>;
}

export function planTypeScript(projectDir: string): TypeScriptPlan {
    const tsconfigPath = join(projectDir, 'tsconfig.json');
    if (!existsSync(tsconfigPath)) {
        return { isTypeScript: false, tsconfigPath: '', outDir: null };
    }
    let outDir: string | null = null;
    try {
        const parsed = parseJsonc(readFileSync(tsconfigPath, 'utf8'));
        const options = parsed.compilerOptions;
        if (options !== null && typeof options === 'object') {
            const raw = (options as Record<string, unknown>).outDir;
            if (typeof raw === 'string' && raw.length > 0) {
                outDir = resolve(projectDir, raw);
            }
        }
    } catch (error) {
        // tsconfig 读不动就先当没配 outDir，编译那步会把真正的错误报出来
        outDir = null;
    }
    return { isTypeScript: true, tsconfigPath, outDir };
}

/**
 * 找 tsc 的入口。
 *
 * 优先级：**项目自己的 typescript** -> **opm 自带的那份**。
 * 优先项目那份是因为 tsconfig 的写法跟着编译器版本变（例如 moduleResolution=node10
 * 在 TS 7 里被移除），用项目锁定的版本才不会把本来能编译的工程弄坏；
 * opm 自带一份是为了让"项目没装 typescript"也能直接 build。
 */
function resolveTscEntry(projectDir: string): { entry: string; useNode: boolean } | null {
    // 只能先解析 package.json：typescript 的 exports 是有白名单的，
    // lib/tsc.js 这类内部路径不在白名单里，require.resolve 会直接拒绝（TS 7 就是如此）。
    // 拿包根之后按它的 bin 字段拼路径，TS 5 / TS 7 两种布局都能对上。
    const bases = [projectDir, __dirname];
    for (const base of bases) {
        let manifestPath: string;
        try {
            manifestPath = require.resolve('typescript/package.json', { paths: [base] });
        } catch {
            continue; // 这个基准下没有 typescript
        }
        let relative: string | null = null;
        try {
            const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin?: unknown };
            const bin = manifest.bin;
            if (typeof bin === 'string') {
                relative = bin;
            } else if (bin !== null && typeof bin === 'object') {
                const tsc = (bin as Record<string, unknown>).tsc;
                if (typeof tsc === 'string') {
                    relative = tsc;
                }
            }
        } catch {
            relative = null;
        }
        const candidates = (relative === null ? [] : [relative]).concat(['lib/tsc.js', 'bin/tsc']);
        for (const candidate of candidates) {
            const absolute = join(dirname(manifestPath), candidate.replace(/^\.\//, ''));
            if (!existsSync(absolute)) {
                continue;
            }
            const head = readFileSync(absolute).subarray(0, 64).toString('utf8');
            // 带 shebang 或以 .js 结尾的就是 JS 入口，交给 node 跑；否则当原生可执行直接跑
            return { entry: absolute, useNode: absolute.endsWith('.js') || head.startsWith('#!') };
        }
    }
    return null;
}

/**
 * 调用 tsc 编译。
 *
 * 输出重定向到**临时文件**而不是管道：某些受限环境不允许通过管道捕获子进程输出
 * （会直接 EPERM），而这里必须拿到编译日志才能报错。临时文件两边都能用。
 */
export function compileTypeScript(projectDir: string, tsconfigPath: string): { ok: boolean; output: string } {
    const resolved = resolveTscEntry(projectDir);
    if (resolved === null) {
        return {
            ok: false,
            output: '找不到 typescript 的编译器。opm 把它作为依赖自带了一份，正常安装不该出现这个错；\n' +
                '如果项目里也装了 typescript，会优先用项目那一份（版本由你的项目决定）。'
        };
    }

    const logPath = join(tmpdir(), 'opm-tsc-' + process.pid + '-' + Date.now() + '.log');
    const logFd = openSync(logPath, 'w');
    let result;
    try {
        const command = resolved.useNode ? process.execPath : resolved.entry;
        const args = resolved.useNode ? [resolved.entry, '-p', tsconfigPath] : ['-p', tsconfigPath];
        result = spawnSync(command, args, {
            cwd: projectDir,
            stdio: ['ignore', logFd, logFd]
        });
    } finally {
        closeSync(logFd);
    }

    let output = '';
    try {
        output = readFileSync(logPath, 'utf8');
    } catch {
        output = '';
    }
    try {
        unlinkSync(logPath);
    } catch {
        // 清不掉临时日志不影响结论
    }

    if (result.error !== undefined && result.error !== null) {
        return { ok: false, output: output + '\n无法启动 tsc：' + result.error.message };
    }
    return { ok: result.status === 0, output };
}

/** 归档路径 -> 磁盘文件；按 原样 -> 产物目录 -> 逐级剥前导段 依次尝试。 */
export function createLocator(projectDir: string, outDir: string | null): (archivePath: string) => string | null {
    return (archivePath: string): string | null => {
        const attempts: string[] = [join(projectDir, archivePath)];
        if (outDir !== null) {
            attempts.push(join(outDir, archivePath));
            const parts = archivePath.split('/');
            for (let index = 1; index < parts.length; index += 1) {
                attempts.push(join(outDir, parts.slice(index).join('/')));
            }
        }
        for (const attempt of attempts) {
            if (existsSync(attempt) && statSync(attempt).isFile()) {
                return attempt;
            }
        }
        return null;
    };
}

export { dirname };
