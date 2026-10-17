'use strict';

/**
 * opm build：把 Operit 插件工程打成 .toolpkg。
 *
 * 流程（与 node.operit 的契约配套）：
 *   1. 读 manifest.json，取可达种子（main + subpackages[].entry）；
 *   2. 顺 require 链递归收集被引用文件；
 *   3. 裸名重写（内建 → node.operit 子路径；npm 包 → 包入口；lodash/uuid/axios 原样）；
 *   4. 契约拦截：planned / unsupported 直接构建失败，不把问题带到运行期；
 *   5. 入口注入 process / Buffer 全局（沙盒没有这两个全局）；
 *   6. 压成 zip，产物放项目根的上一级，名为 <项目目录名>.toolpkg。
 */

import { renderPackInfo } from './packinfo';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep as path_sep } from 'node:path';
import { createZip, ZipEntry } from './zip';
import { findNodeOperitDir, loadContract, NODE_OPERIT_DIR } from './contract';
import { Diagnostic, RewriteEnv, rewriteModule } from './rewrite';
import { compileTypeScript, createLocator, planTypeScript } from './typescript';
import { auditDependencies, installDependencies } from './dependencies';

export interface BuildOptions {
    projectDir: string;
    /** 产物名（不含 .toolpkg），默认取项目目录名 */
    outName?: string;
    /** 只分析不产包 */
    dryRun?: boolean;
    /** 缺依赖时是否自动 npm install（默认 true；--no-install 关掉） */
    install?: boolean;
}

export interface BuildResult {
    ok: boolean;
    toolpkgPath: string;
    fileCount: number;
    /** 会进归档的归档路径清单 */
    files: string[];
    /** 这些文件的正文总字节数（未压缩） */
    totalBytes: number;
    /** 原样带上的非 JS 资产（归档路径） */
    assets: string[];
    diagnostics: Diagnostic[];
    errors: string[];
    notes: string[];
}

interface ToolPkgManifest {
    /** PACKINFO 的开关与补充信息（对齐 OPM） */
    packinfo?: Record<string, unknown>;
    /** 显式声明要额外进包的文件或目录（目录递归）；语义对齐 OPM 的 extra_files */
    extra_files?: string[];
    main?: unknown;
    subpackages?: unknown;
}

function toPosix(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function readManifest(projectDir: string, errors: string[]): ToolPkgManifest | null {
    const manifestPath = join(projectDir, 'manifest.json');
    if (!existsSync(manifestPath)) {
        errors.push('找不到 ' + manifestPath + '：.toolpkg 必须有 manifest.json（至少要声明 main）');
        return null;
    }
    try {
        return JSON.parse(readFileSync(manifestPath, 'utf8')) as ToolPkgManifest;
    } catch (error) {
        errors.push('manifest.json 不是合法 JSON：' + String(error));
        return null;
    }
}

/** 可达种子：main 与所有子包入口。 */
function collectSeeds(manifest: ToolPkgManifest, errors: string[]): string[] {
    const seeds: string[] = [];
    if (typeof manifest.main === 'string' && manifest.main.length > 0) {
        seeds.push(toPosix(manifest.main));
    } else {
        errors.push('manifest.json 缺少 main（字符串），没有入口就无从计算可达性');
    }
    if (Array.isArray(manifest.subpackages)) {
        for (const item of manifest.subpackages) {
            if (item === null || typeof item !== 'object') continue;
            const entry = (item as Record<string, unknown>).entry;
            if (typeof entry === 'string' && entry.length > 0) {
                seeds.push(toPosix(entry));
            }
        }
    }
    return seeds;
}

export function buildProject(options: BuildOptions): BuildResult {
    const projectDir = resolve(options.projectDir);
    const errors: string[] = [];
    const notes: string[] = [];
    const diagnostics: Diagnostic[] = [];

    const manifest = readManifest(projectDir, errors);
    if (manifest === null) {
        return { ok: false, toolpkgPath: '', fileCount: 0, files: [], totalBytes: 0, assets: [], diagnostics, errors, notes };
    }

    // 依赖补齐：重写器是在 node_modules 里找包的，依赖没装齐就会以"解析不到"收场，
    // 那个报错对使用者没有指导性，而一条 npm install 就能解决。所以先补齐再解析。
    // 不指定 registry —— 包从哪来由使用者自己的 npm 配置决定。
    const audit = auditDependencies(projectDir);
    if (audit.missing.length > 0) {
        if (options.install === false) {
            errors.push(
                '缺少依赖：' + audit.missing.join(', ') + '\n' +
                '    执行 npm install 补齐后重试（本次带了 --no-install，所以没有自动装）。'
            );
            return { ok: false, toolpkgPath: '', fileCount: 0, files: [], totalBytes: 0, assets: [], diagnostics, errors, notes };
        }
        notes.push('缺少依赖，正在安装：' + audit.missing.join(', '));
        const installed = installDependencies(projectDir);
        if (!installed.ok) {
            errors.push('npm install 失败：\n' + installed.output.trim());
            return { ok: false, toolpkgPath: '', fileCount: 0, files: [], totalBytes: 0, assets: [], diagnostics, errors, notes };
        }
        const afterInstall = auditDependencies(projectDir);
        if (afterInstall.missing.length > 0) {
            errors.push(
                'npm install 执行完了，但这些依赖仍然不在 node_modules 里：' + afterInstall.missing.join(', ') + '\n' +
                '    检查 package.json 的拼写，或你的 npm 源里有没有这些包。'
            );
            return { ok: false, toolpkgPath: '', fileCount: 0, files: [], totalBytes: 0, assets: [], diagnostics, errors, notes };
        }
        notes.push('依赖已补齐');
    }

    let nodeOperitDir: string;
    try {
        nodeOperitDir = findNodeOperitDir(projectDir);
    } catch (error) {
        errors.push(String(error instanceof Error ? error.message : error));
        return { ok: false, toolpkgPath: '', fileCount: 0, files: [], totalBytes: 0, assets: [], diagnostics, errors, notes };
    }
    const contract = loadContract(nodeOperitDir);

    // TS 模式：先编译，再按 outDir 建立「归档路径 -> 磁盘文件」映射。
    // 归档内路径始终是 manifest 视角，编译产物落在 outDir 由映射负责对上。
    const plan = planTypeScript(projectDir);
    if (plan.isTypeScript) {
        notes.push('TS 模式，使用 ' + plan.tsconfigPath);
        const compiled = compileTypeScript(projectDir, plan.tsconfigPath);
        if (!compiled.ok) {
            errors.push('tsc 编译失败：\n' + compiled.output.trim());
            return { ok: false, toolpkgPath: '', fileCount: 0, files: [], totalBytes: 0, assets: [], diagnostics, errors, notes };
        }
        if (compiled.output.trim().length > 0) {
            notes.push('tsc 输出：\n    ' + compiled.output.trim().split('\n').join('\n    '));
        }
        notes.push('编译产物目录：' + (plan.outDir === null ? '（与源码同目录）' : plan.outDir));
    } else {
        notes.push('JS 模式（无 tsconfig.json），以项目根为根打包');
    }

    const locate = createLocator(projectDir, plan.outDir);
    const env: RewriteEnv = { locate, contract, nodeOperitArchiveDir: NODE_OPERIT_DIR };

    const buildConfig = readBuildConfig(projectDir, errors);
    const seeds = collectSeeds(manifest, errors);

    // 入口要注入 process / Buffer 全局（沙盒没有这两个全局）。
    // 关键是：**注入必须在可达性遍历之前登记**，把被注入引用的这两个文件
    // 也当作种子。否则注入代码指向的 dist/process.js 不会进包，
    // 产物一加载就 "Cannot resolve module ./node_modules/.../dist/process.js" ——
    // 而且是每个用户代码自己没 require process 的包都这样。
    const entryPath = typeof manifest.main === 'string' ? toPosix(manifest.main) : '';
    let prelude = '';
    if (entryPath !== '') {
        const joined = toPosix(joinRelative(dirname(entryPath), NODE_OPERIT_DIR));
        const relative = joined.startsWith('.') ? joined : './' + joined;
        prelude =
            '/* opm: Operit 沙盒没有 process / Buffer 全局，入口先挂上（见 node.operit 的 BUILTINS.json） */\n' +
            "globalThis.process = require('" + relative + "/dist/process.js');\n" +
            "globalThis.Buffer = require('" + relative + "/dist/buffer.js').Buffer;\n";
        seeds.push(joined + '/dist/process.js');
        seeds.push(joined + '/dist/buffer.js');
    }

    const visited = new Set<string>();
    const rewritten = new Map<string, string>();
    const queue: string[] = [];

    for (const seed of seeds) {
        if (locate(seed) === null) {
            errors.push('入口不存在：' + seed + '（manifest 里写的是相对项目根的路径）');
            continue;
        }
        if (!visited.has(seed)) {
            visited.add(seed);
            queue.push(seed);
        }
    }

    while (queue.length > 0) {
        const archivePath = queue.shift() as string;
        const diskPath = locate(archivePath);
        if (diskPath === null) {
            errors.push('引用了不存在的文件：' + archivePath);
            continue;
        }
        const source = readFileSync(diskPath, 'utf8');
        const outcome = rewriteModule(env, archivePath, source);
        diagnostics.push(...outcome.diagnostics);
        errors.push(...outcome.errors);
        rewritten.set(archivePath, outcome.code);
        for (const discovered of outcome.discovered) {
            if (!visited.has(discovered)) {
                visited.add(discovered);
                queue.push(discovered);
            }
        }
    }

    // 注入正文（文件已在遍历阶段按种子收好，这里只贴前置代码）
    if (entryPath !== '' && prelude !== '' && rewritten.has(entryPath)) {
        rewritten.set(entryPath, prelude + rewritten.get(entryPath));
        notes.push('已向入口 ' + entryPath + ' 注入 process / Buffer 全局');
    }

    // 额外文件：只收 manifest.extra_files 里显式声明的（照 OPM 的语义）
    const archivePathSet = new Set(rewritten.keys());
    archivePathSet.add('manifest.json');
    const configExtra = Array.isArray(buildConfig.extra_files) ? buildConfig.extra_files as string[] : null;
    const manifestExtra = Array.isArray(manifest.extra_files) ? manifest.extra_files : [];
    const extraFiles = configExtra !== null ? configExtra : manifestExtra;
    const collected = collectExtraFiles(projectDir, extraFiles, archivePathSet);
    errors.push(...collected.errors);
    if (collected.assets.length > 0) {
        notes.push('按 extra_files 带上 ' + collected.assets.length + ' 个额外文件');
    }

    const outName = options.outName === undefined ? baseName(projectDir) : options.outName;
    const toolpkgPath = join(dirname(projectDir), outName + '.toolpkg');

    if (errors.length > 0) {
        return { ok: false, toolpkgPath, fileCount: rewritten.size, files: [...rewritten.keys()], totalBytes: 0, assets: collected.assets.map((asset) => asset.path), diagnostics, errors, notes };
    }
    if (options.dryRun === true) {
        notes.push('dry-run：未写产物');
        return { ok: true, toolpkgPath, fileCount: rewritten.size, files: [...rewritten.keys()], totalBytes: measureBytes(rewritten, collected.assets), assets: collected.assets.map((asset) => asset.path), diagnostics, errors, notes };
    }

    const entries: ZipEntry[] = [
        { path: 'manifest.json', content: readFileSync(join(projectDir, 'manifest.json')) }
    ];
    for (const [archivePath, code] of rewritten) {
        entries.push({ path: archivePath, content: Buffer.from(code, 'utf8') });
    }
    for (const asset of collected.assets) {
        entries.push({ path: asset.path, content: readFileSync(asset.disk) });
    }
    const archiveEntries = entries.slice().sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    let totalBytes = 0;
    for (const entry of archiveEntries) {
        totalBytes += entry.content.length;
    }
    // PACKINFO：仅在 manifest.packinfo.enable === true 时生成
    const configPackinfo = buildConfig.packinfo as Parameters<typeof renderPackInfo>[1];
    const packinfoOptions = (configPackinfo !== undefined && configPackinfo !== null
        ? configPackinfo
        : manifest.packinfo) as Parameters<typeof renderPackInfo>[1];
    const packinfoText = renderPackInfo(manifest as unknown as Record<string, unknown>, packinfoOptions, archiveEntries.map((entry) => entry.path));
    if (packinfoText !== null) {
        entries.push({ path: 'PACKINFO', content: Buffer.from(packinfoText, 'utf8') });
        archiveEntries.push({ path: 'PACKINFO', content: Buffer.from(packinfoText, 'utf8') });
        notes.push('已生成 PACKINFO（' + packinfoText.split('\n').length + ' 行）');
    }

    const archive = createZip(entries);
    mkdirSync(dirname(toolpkgPath), { recursive: true });
    writeFileSync(toolpkgPath, archive);

    return {
        ok: true,
        toolpkgPath,
        fileCount: entries.length,
        files: archiveEntries.map((entry) => entry.path),
        totalBytes,
        assets: collected.assets.map((asset) => asset.path),
        diagnostics,
        errors,
        notes
    };
}

/**
 * 额外文件收集 —— 照 OPM 的 extra_files 语义。
 *
 * OPM（src/build/extrafiles.ts）只收 manifest 显式列出的路径：
 *   - 是文件 → 收；
 *   - 是目录 → **递归**收集其下文件（跳过 node_modules 与点目录，深度上限 10）；
 *   - 不在列表里的一律不进归档。
 *
 * 之前这里写的是"非 JS 一律原样带上"，那是错的：它会把工程里的杂项
 * （草稿、截图、临时配置）一起打进包，包体不可控也不可解释。
 * 现在归档内容 = require 闭包 + manifest 声明的入口 + 显式 extra_files，没有别的。
 */
const EXTRA_SKIP_DIRS = new Set(['node_modules']);
const EXTRA_MAX_DEPTH = 10;

interface AssetEntry {
    /** 归档内路径 */
    path: string;
    /** 磁盘绝对路径 */
    disk: string;
}

function collectExtraFiles(
    projectDir: string,
    extraFiles: readonly string[],
    archivePaths: ReadonlySet<string>
): { assets: AssetEntry[]; errors: string[] } {
    const assets: AssetEntry[] = [];
    const errors: string[] = [];
    const seen = new Set<string>();

    const addFile = (archivePath: string): void => {
        const normalized = toPosix(archivePath).replace(/^\.\//, '');
        if (normalized === '' || seen.has(normalized) || archivePaths.has(normalized)) {
            return; // 已在 require 闭包里，不重复
        }
        const disk = resolve(projectDir, normalized);
        if (!existsSync(disk) || !statSync(disk).isFile()) {
            return;
        }
        seen.add(normalized);
        assets.push({ path: normalized, disk });
    };

    const walkDir = (relDir: string, depth: number): void => {
        if (depth <= 0) {
            return;
        }
        const absDir = resolve(projectDir, relDir);
        let entries;
        try {
            entries = readdirSync(absDir, { withFileTypes: true });
        } catch (error) {
            errors.push('读取目录失败：' + relDir + ' —— ' + String(error));
            return;
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.')) {
                continue; // 点目录/点文件不进包
            }
            const childRel = relDir === '' ? entry.name : relDir + '/' + entry.name;
            if (entry.isDirectory()) {
                if (EXTRA_SKIP_DIRS.has(entry.name)) {
                    continue;
                }
                walkDir(childRel, depth - 1);
                continue;
            }
            addFile(childRel);
        }
    };

    for (const raw of extraFiles) {
        const rel = toPosix(String(raw)).replace(/^\.\//, '');
        if (rel === '') {
            continue;
        }
        const abs = resolve(projectDir, rel);
        if (!existsSync(abs)) {
            errors.push('extra_files 里声明的路径不存在：' + rel);
            continue;
        }
        if (statSync(abs).isDirectory()) {
            walkDir(rel, EXTRA_MAX_DEPTH);
            continue;
        }
        addFile(rel);
    }

    return { assets, errors };
}

/** 归档正文的总字节（未压缩）：重写后的 JS + 额外文件。dry-run 也要能报出来。 */
function measureBytes(files: Map<string, string>, assets: readonly AssetEntry[]): number {
    let total = 0;
    for (const code of files.values()) {
        total += Buffer.byteLength(code, 'utf8');
    }
    for (const asset of assets) {
        try {
            total += statSync(asset.disk).size;
        } catch {
            // 读不到大小就不计它，不影响其余结论
        }
    }
    return total;
}

/**
 * 构建期清单（可选）：项目根的 manifest.opmbuild.json。
 *
 * 为什么不塞进 manifest.json：manifest.json 是**运行时**元数据（装到设备上给 Operit 读的），
 * 而"打哪些额外文件、要不要生成 PACKINFO"是**构建期**决策，混在一起会让运行时清单变脏。
 * 单独一个清单文件，职责清楚，也可以不提交（看团队习惯）。
 *
 * 形状：
 *   {
 *     "extra_files": ["resources", "i18n/zh-CN.js"],
 *     "packinfo": { "enable": true }
 *   }
 *
 * 兼容：manifest.json 里同名字段仍然生效（先看构建清单，再看 manifest）。
 */
const OPM_BUILD_CONFIG = 'manifest.opmbuild.json';

interface OpmBuildConfig {
    extra_files?: unknown;
    packinfo?: unknown;
}

function readBuildConfig(projectDir: string, errors: string[]): OpmBuildConfig {
    const configPath = join(projectDir, OPM_BUILD_CONFIG);
    if (!existsSync(configPath)) {
        return {};
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (error) {
        errors.push(OPM_BUILD_CONFIG + ' 不是合法 JSON：' + String(error));
        return {};
    }
    if (parsed === null || typeof parsed !== 'object') {
        errors.push(OPM_BUILD_CONFIG + ' 的顶层必须是对象');
        return {};
    }
    return parsed as OpmBuildConfig;
}

function baseName(value: string): string {
    const normalized = value.replace(/[\\/]+$/, '');
    const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
    return index < 0 ? normalized : normalized.slice(index + 1);
}

function joinRelative(fromDir: string, target: string): string {
    const fromParts = fromDir === '' || fromDir === '.' ? [] : fromDir.split('/');
    const targetParts = target.split('/');
    let common = 0;
    while (common < fromParts.length && common < targetParts.length && fromParts[common] === targetParts[common]) {
        common += 1;
    }
    const up = new Array(fromParts.length - common).fill('..');
    return up.concat(targetParts.slice(common)).join('/');
}
