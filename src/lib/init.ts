'use strict';

/**
 * opm init：把工程准备到"能 build"。
 *
 * 只管三件事（都是最容易写错的地方）：
 *   1. package.json 里补 scripts.build = "opm build"，以及两个 devDependency；
 *   2. 没有 manifest.json 就生成一个骨架（toolpkg 的身份靠它）；
 *   3. 工程里有 .ts 就补一个 tsconfig.json，且 outDir 与 manifest 的路径对得上。
 *
 * **不写死 registry**：依赖从哪来由使用者自己的 npm 配置决定。
 * 默认会跑一次 npm install（可用 --no-install 关掉），因为没装 node.operit 就 build 不了。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { NODE_OPERIT_PACKAGE } from './contract';
import { installDependencies } from './dependencies';

export const OPM_PACKAGE = '@serveryyswys/opm';

export interface InitOptions {
    projectDir: string;
    /** 是否跑 npm install（默认 true） */
    install?: boolean;
    /** 覆盖已存在的 package.json 字段（默认 false：只补不改） */
    overwrite?: boolean;
}

export interface InitResult {
    ok: boolean;
    created: string[];
    updated: string[];
    unchanged: string[];
    notes: string[];
    errors: string[];
    /** 建议使用者接着执行的命令 */
    nextSteps: string[];
}

function readJson(path: string): Record<string, unknown> | null {
    if (!existsSync(path)) {
        return null;
    }
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch {
        return null;
    }
}

function writeJson(path: string, value: unknown): void {
    writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/** 目录里有没有 .ts（跳过 node_modules）。 */
function hasTypeScript(projectDir: string): boolean {
    const stack = [projectDir];
    while (stack.length > 0) {
        const current = stack.pop() as string;
        let entries;
        try {
            entries = readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
                continue;
            }
            if (entry.isDirectory()) {
                stack.push(join(current, entry.name));
            } else if (entry.name.endsWith('.ts')) {
                return true;
            }
        }
    }
    return false;
}

export function initProject(options: InitOptions): InitResult {
    const projectDir = resolve(options.projectDir);
    const install = options.install !== false;
    const overwrite = options.overwrite === true;
    const created: string[] = [];
    const updated: string[] = [];
    const unchanged: string[] = [];
    const notes: string[] = [];
    const errors: string[] = [];
    const nextSteps: string[] = [];

    if (!existsSync(projectDir)) {
        mkdirSync(projectDir, { recursive: true });
        created.push(projectDir + '/');
    }

    const projectName = basename(projectDir);

    // ---- package.json
    const packagePath = join(projectDir, 'package.json');
    const existingPackage = readJson(packagePath);
    const manifest = existingPackage === null ? {} : existingPackage;
    let packageChanged = false;

    const scripts = manifest.scripts === null || typeof manifest.scripts !== 'object'
        ? {} as Record<string, unknown>
        : manifest.scripts as Record<string, unknown>;
    if (overwrite || typeof scripts.build !== 'string') {
        scripts.build = 'opm build';
        packageChanged = true;
    }
    manifest.scripts = scripts;

    const devDependencies = manifest.devDependencies === null || typeof manifest.devDependencies !== 'object'
        ? {} as Record<string, unknown>
        : manifest.devDependencies as Record<string, unknown>;
    for (const name of [OPM_PACKAGE, NODE_OPERIT_PACKAGE]) {
        if (overwrite || devDependencies[name] === undefined) {
            // 用 latest：版本由源上的最新决定，不在生成物里钉死一个会过期的号
            devDependencies[name] = 'latest';
            packageChanged = true;
        }
    }
    manifest.devDependencies = devDependencies;

    if (manifest.name === undefined) {
        manifest.name = projectName;
        packageChanged = true;
    }
    if (manifest.private === undefined) {
        manifest.private = true;
        packageChanged = true;
    }

    if (existingPackage === null) {
        writeJson(packagePath, manifest);
        created.push('package.json');
    } else if (packageChanged) {
        writeJson(packagePath, manifest);
        updated.push('package.json');
    } else {
        unchanged.push('package.json');
    }

    // ---- manifest.json（toolpkg 身份）
    const toolpkgPath = join(projectDir, 'manifest.json');
    if (!existsSync(toolpkgPath)) {
        // 目录名可能以 . 或 _ 开头（.e2e-opm / _probe），直接拼会得到 "com.example..e2e-opm"
        const safeName = projectName
            .replace(/[^A-Za-z0-9_.-]/g, '-')
            .replace(/^[^A-Za-z0-9]+/, '')
            .replace(/[^A-Za-z0-9]+$/, '');
        const toolpkgId = 'com.example.' + (safeName.length > 0 ? safeName : 'plugin');
        const hasTs = hasTypeScript(projectDir);
        writeJson(toolpkgPath, {
            schema_version: 1,
            toolpkg_id: toolpkgId,
            version: '0.1.0',
            api_version: '1.0.1',
            author: [''],
            main: hasTs ? 'dist/main.js' : 'main.js',
            display_name: { zh: projectName, en: projectName },
            description: { zh: '（待填写）', en: '(to be filled)' },
            subpackages: []
        });
        created.push('manifest.json');
        notes.push('manifest.json 里的 toolpkg_id 现在是 ' + toolpkgId + '，发布前请改成你自己的');
    } else {
        unchanged.push('manifest.json');
    }

    // ---- tsconfig.json（只在工程确实有 .ts 时生成，免得把纯 JS 工程推进 TS 模式）
    const tsconfigPath = join(projectDir, 'tsconfig.json');
    const wantsTypeScript = existsSync(tsconfigPath) || hasTypeScript(projectDir);
    if (wantsTypeScript && !existsSync(tsconfigPath)) {
        writeJson(tsconfigPath, {
            compilerOptions: {
                target: 'ES2020',
                module: 'node16',
                moduleResolution: 'node16',
                lib: ['ES2020'],
                rootDir: 'src',
                outDir: 'dist',
                strict: true,
                declaration: false,
                skipLibCheck: true,
                types: []
            },
            include: ['src/**/*.ts']
        });
        created.push('tsconfig.json');
        notes.push('tsconfig 的 outDir 是 dist、rootDir 是 src，所以 manifest.main 要写 dist/main.js');
    } else if (existsSync(tsconfigPath)) {
        unchanged.push('tsconfig.json');
    }

    // ---- 依赖
    let installOutput = '';
    if (install) {
        const installed = installDependencies(projectDir);
        installOutput = installed.output;
        if (!installed.ok) {
            errors.push('npm install 失败：\n' + installOutput.trim());
        } else {
            notes.push('已执行 npm install（源按你自己的 npm 配置，未指定 registry）');
        }
    } else {
        nextSteps.push('npm install');
    }

    nextSteps.push('npm run build');

    return { ok: errors.length === 0, created, updated, unchanged, notes, errors, nextSteps };
}
