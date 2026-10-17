'use strict';

/**
 * 裸名重写：把 require 的目标改写成「归档内的显式 .js 相对路径」。
 *
 * 三条规则（与 node.operit 的 BUILTINS.json 契约一致）：
 *   1. 运行时已内建的裸名（lodash / uuid / axios）保持原样；
 *   2. 其余 Node 内建 -> node.operit 的 dist 子路径；status 为 planned/unsupported 的直接构建失败；
 *   3. 第三方 npm 包 -> 该包入口文件（解析 main / exports）。
 *
 * 为什么必须显式带 .js：运行时的 buildCandidatePaths 对命中扩展名正则的名字只试一个候选、
 * 不补扩展名。包名里的 ".operit" 正好命中那个正则，所以 ".../node.operit" 会被当成完整路径而解析失败。
 *
 * 全程在「归档路径空间」里工作：不传项目目录，也不需要知道磁盘布局 ——
 * 归档路径与磁盘路径的对应关系由 env.locate 负责，这样 TS 模式的产物目录映射能透明接进来。
 */

import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { Contract, RUNTIME_BUILTINS } from './contract';
import { findRequires } from './js-requires';

export interface Diagnostic {
    file: string;
    spec: string;
    kind: 'builtin' | 'package' | 'relative' | 'untouched';
    target: string;
}

export interface RewriteOutcome {
    code: string;
    diagnostics: Diagnostic[];
    errors: string[];
    /** 本次重写引入、需要继续处理的新文件（归档路径） */
    discovered: string[];
}

export interface RewriteEnv {
    /** 归档路径 -> 磁盘绝对路径；不存在返回 null */
    locate(archivePath: string): string | null;
    contract: Contract;
    /** node.operit 在归档内的安装目录（正斜杠） */
    nodeOperitArchiveDir: string;
}

const EXTENSION_RE = /\.[a-z0-9]+$/i;

function toPosix(value: string): string {
    return value.replace(/\\/g, '/');
}

/** 归档路径的目录部分（'' 表示归档根）。 */
function dirOf(archivePath: string): string {
    const index = archivePath.lastIndexOf('/');
    return index < 0 ? '' : archivePath.slice(0, index);
}

/** 相对引用 -> 归档路径。越界的 .. 直接丢弃，与运行时 normalizePath 的行为一致。 */
export function resolveRelative(fromArchive: string, spec: string): string {
    const joined = (dirOf(fromArchive) === '' ? '' : dirOf(fromArchive) + '/') + toPosix(spec);
    const stack: string[] = [];
    for (const part of joined.split('/')) {
        if (part === '' || part === '.') continue;
        if (part === '..') { stack.pop(); continue; }
        stack.push(part);
    }
    return stack.join('/');
}

/**
 * 目标文件相对当前文件的引用写法。
 *
 * 只有真正需要时才补 "./"：已经是 "../" 开头时再补会得到 "./../x"，
 * 运行时的 normalizePath 虽然能吃掉它，但产出会显得很不专业。
 */
function relativeSpec(fromArchive: string, target: string): string {
    const relative = toPosix(posix.relative(dirOf(fromArchive), target));
    return relative.startsWith('.') ? relative : './' + relative;
}

/** 依次尝试 原样 / .js / .json / /index.js；命中已存在的则返回归档路径。 */
function withCandidates(env: RewriteEnv, archivePath: string): string | null {
    const attempts = EXTENSION_RE.test(archivePath)
        ? [archivePath]
        : [archivePath, archivePath + '.js', archivePath + '.json', archivePath + '/index.js'];
    for (const attempt of attempts) {
        if (env.locate(attempt) !== null) {
            return attempt;
        }
    }
    return null;
}

function readJson(path: string): Record<string, unknown> | null {
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch {
        return null;
    }
}

/** 从 exports 的某个值里挑出 CommonJS 能用的那个（require > node > default > import）。 */
function pickCondition(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (value === null || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    for (const key of ['require', 'node', 'default', 'import']) {
        const picked = pickCondition(record[key]);
        if (picked !== null) return picked;
    }
    return null;
}

function resolveExports(exportsField: unknown, subpath: string): string | null {
    if (exportsField === undefined || exportsField === null) return null;
    if (typeof exportsField === 'string') {
        return subpath === '' ? exportsField : null;
    }
    if (typeof exportsField !== 'object') return null;
    const record = exportsField as Record<string, unknown>;
    const keys = Object.keys(record);
    if (!keys.some((key) => key.startsWith('.'))) {
        return subpath === '' ? pickCondition(exportsField) : null;
    }
    const wanted = subpath === '' ? '.' : './' + subpath;
    const direct = pickCondition(record[wanted]);
    if (direct !== null) return direct;
    for (const key of keys) {
        if (!key.includes('*')) continue;
        const starIndex = key.indexOf('*');
        const prefix = key.slice(0, starIndex);
        const suffix = key.slice(starIndex + 1);
        if (!wanted.startsWith(prefix) || !wanted.endsWith(suffix)) continue;
        const middle = wanted.slice(prefix.length, wanted.length - suffix.length);
        const template = pickCondition(record[key]);
        if (template !== null) return template.replace('*', middle);
    }
    return null;
}

/** 裸包名 -> 归档内的入口文件。 */
function resolvePackageEntry(env: RewriteEnv, spec: string): string | null {
    const segments = spec.split('/');
    const isScoped = spec.startsWith('@');
    const packageName = isScoped ? segments.slice(0, 2).join('/') : segments[0];
    const subpath = segments.slice(isScoped ? 2 : 1).join('/');
    const packageDir = 'node_modules/' + packageName;

    const manifestDisk = env.locate(packageDir + '/package.json');
    if (manifestDisk === null) {
        return null;
    }
    const manifest = readJson(manifestDisk);

    let relative = manifest === null ? null : resolveExports(manifest.exports, subpath);
    if (relative === null && subpath === '' && manifest !== null && typeof manifest.main === 'string') {
        relative = manifest.main;
    }
    if (relative === null) {
        relative = subpath === '' ? 'index.js' : subpath;
    }
    return withCandidates(env, packageDir + '/' + toPosix(relative));
}

export function rewriteModule(env: RewriteEnv, archivePath: string, source: string): RewriteOutcome {
    const sites = findRequires(source);
    const diagnostics: Diagnostic[] = [];
    const errors: string[] = [];
    const discovered: string[] = [];

    // 从后往前替换：前面的改动不影响后面的下标
    let output = source;
    for (let index = sites.length - 1; index >= 0; index -= 1) {
        const site = sites[index];
        if (site.dynamic) {
            // 动态 require 不在这里裁决：可分析性由 AST 扫描判断（build.ts 侧），
            // 有静态前缀就把前缀目录整目录收进归档，完全动态才失败。这里只跳过替换。
            continue;
        }
        const spec = site.spec as string;

        if (RUNTIME_BUILTINS.includes(spec)) {
            diagnostics.push({ file: archivePath, spec, kind: 'untouched', target: spec });
            continue;
        }

        if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) {
            const resolved = withCandidates(env, resolveRelative(archivePath, spec));
            if (resolved === null) {
                errors.push(archivePath + ' 里 require(\'' + spec + '\') 解析不到文件');
                continue;
            }
            diagnostics.push({ file: archivePath, spec, kind: 'relative', target: resolved });
            discovered.push(resolved);
            output = output.slice(0, site.start) + relativeSpec(archivePath, resolved) + output.slice(site.end);
            continue;
        }

        const builtin = env.contract.builtins[spec];
        if (builtin !== undefined) {
            if (builtin.status === 'planned' || builtin.status === 'unsupported') {
                errors.push(
                    archivePath + ' 依赖 ' + spec + '，契约里它是 ' + builtin.status + '，构建中止。\n' +
                    '    原因：' + (builtin.note === undefined ? '（契约未注明）' : builtin.note)
                );
                continue;
            }
            const target = env.nodeOperitArchiveDir + '/' + env.contract.distDir + '/' + builtin.subpath + '.js';
            if (env.locate(target) === null) {
                errors.push(archivePath + ' 依赖 ' + spec + '，但归档里找不到 ' + target + '（node.operit 装得不完整？）');
                continue;
            }
            diagnostics.push({ file: archivePath, spec, kind: 'builtin', target });
            discovered.push(target);
            output = output.slice(0, site.start) + relativeSpec(archivePath, target) + output.slice(site.end);
            continue;
        }

        const packageEntry = resolvePackageEntry(env, spec);
        if (packageEntry === null) {
            errors.push(
                archivePath + ' 里 require(\'' + spec + '\') 既不是 Node 内建、也不在 node_modules 里。\n' +
                '    契约表里没有这个名字，node_modules/' + spec + ' 也不存在。'
            );
            continue;
        }
        diagnostics.push({ file: archivePath, spec, kind: 'package', target: packageEntry });
        discovered.push(packageEntry);
        output = output.slice(0, site.start) + relativeSpec(archivePath, packageEntry) + output.slice(site.end);
    }

    return { code: output, diagnostics, errors, discovered };
}
