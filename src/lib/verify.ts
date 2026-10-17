'use strict';

/**
 * opm verify：出包前的干跑校验。
 *
 * 与 build 的区别**只在完全不写文件**，但报告更细：
 *   - manifest 的字段级校验（build 只保证"能读到 main"）；
 *   - 逐条 require 的归宿（内建 / npm 包 / 相对 / 保持原样）；
 *   - 资产是否齐全（resources / i18n / modules 一个都不能漏）；
 *   - 统计与提醒（被拉进来的包、声明了却没用的依赖、体积）。
 *
 * 一句话：build 关心"能不能出包"，verify 关心"这个包合不合理"。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildProject } from './build';
import { NODE_OPERIT_PACKAGE } from './contract';
import { Diagnostic } from './rewrite';

export interface VerifyCheck {
    name: string;
    ok: boolean;
    detail: string;
}

export interface VerifyStats {
    archiveFiles: number;
    totalBytes: number;
    builtin: number;
    package: number;
    relative: number;
    untouched: number;
    /** 被拉进归档的 npm 包名 */
    packages: string[];
    /** 原样带上的非代码资产 */
    assets: number;
    /** node.operit 的版本（契约来源） */
    nodeOperitVersion: string;
}

export interface VerifyReport {
    ok: boolean;
    checks: VerifyCheck[];
    errors: string[];
    warnings: string[];
    notes: string[];
    stats: VerifyStats;
    diagnostics: Diagnostic[];
}

interface ToolPkgManifestShape {
    schema_version?: unknown;
    toolpkg_id?: unknown;
    version?: unknown;
    main?: unknown;
    subpackages?: unknown;
}

function checkManifest(projectDir: string, checks: VerifyCheck[], errors: string[]): void {
    const manifestPath = join(projectDir, 'manifest.json');
    if (!existsSync(manifestPath)) {
        checks.push({ name: 'manifest 存在', ok: false, detail: manifestPath + ' 不存在' });
        errors.push('没有 manifest.json：这不是一个 Operit 工具包工程');
        return;
    }

    let manifest: ToolPkgManifestShape;
    try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ToolPkgManifestShape;
    } catch (error) {
        checks.push({ name: 'manifest 可解析', ok: false, detail: String(error) });
        errors.push('manifest.json 不是合法 JSON');
        return;
    }
    checks.push({ name: 'manifest 可解析', ok: true, detail: '合法 JSON' });

    const problems: string[] = [];
    if (typeof manifest.toolpkg_id !== 'string' || manifest.toolpkg_id.length === 0) {
        problems.push('缺少 toolpkg_id（市场唯一凭据，发布后不可改）');
    } else if (manifest.toolpkg_id.startsWith('com.example.')) {
        problems.push('toolpkg_id 还是占位 ' + manifest.toolpkg_id + '，发布前必须改');
    }
    if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
        problems.push('缺少 version');
    }
    if (typeof manifest.main !== 'string' || manifest.main.length === 0) {
        problems.push('缺少 main（没有入口就无法计算可达性）');
    }
    if (manifest.schema_version === undefined) {
        problems.push('缺少 schema_version');
    }
    checks.push({
        name: 'manifest 必需字段',
        ok: problems.length === 0,
        detail: problems.length === 0
            ? 'toolpkg_id / version / main / schema_version 齐备'
            : problems.join('；')
    });
    if (problems.length > 0) {
        errors.push(...problems);
    }

    if (Array.isArray(manifest.subpackages)) {
        const missing: string[] = [];
        for (const item of manifest.subpackages) {
            if (item === null || typeof item !== 'object') {
                continue;
            }
            const entry = (item as Record<string, unknown>).entry;
            if (typeof entry === 'string' && entry.length > 0 && !existsSync(join(projectDir, entry))) {
                missing.push(entry);
            }
        }
        checks.push({
            name: '子包入口',
            ok: missing.length === 0,
            detail: missing.length === 0
                ? '声明的 ' + manifest.subpackages.length + ' 个子包入口都在'
                : '这些入口不存在：' + missing.join(', ')
        });
    }
}

function readVersionOf(path: string): string {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown };
        return typeof parsed.version === 'string' ? parsed.version : '未知';
    } catch {
        return '未知';
    }
}

export function verifyProject(options: { projectDir: string; install?: boolean }): VerifyReport {
    const projectDir = resolve(options.projectDir);
    const checks: VerifyCheck[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];
    const notes: string[] = [];

    checkManifest(projectDir, checks, errors);

    // 干跑：与 build 同一条流水线，只是不落盘
    const built = buildProject({ projectDir, dryRun: true, install: options.install });
    notes.push(...built.notes);
    errors.push(...built.errors);

    checks.push({
        name: '依赖与裸名可解析',
        ok: built.errors.length === 0,
        detail: built.errors.length === 0
            ? '所有 require 都能落到归档内'
            : built.errors.length + ' 个问题（见 errors）'
    });
    checks.push({
        name: '额外文件（extra_files）',
        ok: true,
        detail: built.assets.length === 0
            ? 'manifest 没有声明 extra_files'
            : '按 extra_files 带上 ' + built.assets.length + ' 个文件'
    });

    const counted: Record<string, number> = { builtin: 0, package: 0, relative: 0, untouched: 0 };
    const packageNames = new Set<string>();
    for (const item of built.diagnostics) {
        counted[item.kind] = (counted[item.kind] ?? 0) + 1;
        if (item.kind === 'package') {
            const segments = item.target.split('/');
            packageNames.add(item.target.startsWith('node_modules/@') ? segments.slice(1, 3).join('/') : segments[1]);
        }
    }

    // 声明了却没被 require 到的依赖 —— 通常是拼错或已经不需要
    const packageJsonPath = join(projectDir, 'package.json');
    if (existsSync(packageJsonPath)) {
        try {
            const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { dependencies?: Record<string, unknown> };
            for (const name of Object.keys(manifest.dependencies ?? {})) {
                if (!packageNames.has(name)) {
                    warnings.push('package.json 声明了依赖 ' + name + '，但可达代码里没有 require 它（进不了包）');
                }
            }
        } catch {
            warnings.push('package.json 不是合法 JSON，跳过了未使用依赖的检查');
        }
    }

    const nodeOperitManifest = join(projectDir, 'node_modules', NODE_OPERIT_PACKAGE, 'package.json');
    return {
        ok: errors.length === 0,
        checks,
        errors,
        warnings,
        notes,
        stats: {
            archiveFiles: built.files.length,
            totalBytes: built.totalBytes,
            builtin: counted.builtin,
            package: counted.package,
            relative: counted.relative,
            untouched: counted.untouched,
            packages: Array.from(packageNames).sort(),
            assets: built.assets.length,
            nodeOperitVersion: existsSync(nodeOperitManifest) ? readVersionOf(nodeOperitManifest) : '未安装'
        },
        diagnostics: built.diagnostics
    };
}
