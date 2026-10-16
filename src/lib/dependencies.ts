'use strict';

/**
 * 依赖补齐。
 *
 * 为什么 build 要管这件事：重写器是在 node_modules 里找包的，依赖没装齐就会直接
 * "既不是 Node 内建、也不在 node_modules 里" —— 那个报错对使用者没有指导性，
 * 而且明明一条 npm install 就能解决。所以 build 先补齐再解析。
 *
 * **不指定 registry**：包从哪来由使用者自己的 npm 配置决定（私有源的用户自然走私源）。
 */

import { existsSync, closeSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NODE_OPERIT_PACKAGE } from './contract';

export interface DependencyAudit {
    /** package.json 里声明了、但 node_modules 里没有的包 */
    missing: string[];
    /** 是否连 package.json 都没有 */
    hasManifest: boolean;
}

function readManifest(projectDir: string): Record<string, unknown> | null {
    const manifestPath = join(projectDir, 'package.json');
    if (!existsSync(manifestPath)) {
        return null;
    }
    try {
        return JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    } catch {
        return null;
    }
}

/** 判断一个包在不在 node_modules 里（看它自己的 package.json）。 */
function isInstalled(projectDir: string, name: string): boolean {
    return existsSync(join(projectDir, 'node_modules', name, 'package.json'));
}

/**
 * 审计依赖。
 *
 * 只查 dependencies，不查 devDependencies —— 进包的是运行期依赖，
 * 开发依赖被 require 到属于打包错误，应当让重写器如实报错，而不是默默装进来。
 * 例外是 node.operit：它是**构建期**的契约来源，无论写在哪一段都必须存在。
 */
export function auditDependencies(projectDir: string): DependencyAudit {
    const manifest = readManifest(projectDir);
    if (manifest === null) {
        // 没有 package.json 也可能是合法的 toolpkg 工程（纯 Operit 工程），
        // 所以这里仍然要如实检查 node.operit 装没装，不能一律判缺。
        return {
            missing: isInstalled(projectDir, NODE_OPERIT_PACKAGE) ? [] : [NODE_OPERIT_PACKAGE],
            hasManifest: false
        };
    }
    const names = new Set<string>([NODE_OPERIT_PACKAGE]);
    const dependencies = manifest.dependencies;
    if (dependencies !== null && typeof dependencies === 'object') {
        for (const name of Object.keys(dependencies as Record<string, unknown>)) {
            names.add(name);
        }
    }
    const missing: string[] = [];
    for (const name of names) {
        if (!isInstalled(projectDir, name)) {
            missing.push(name);
        }
    }
    missing.sort();
    return { missing, hasManifest: true };
}

/**
 * 跑 npm install。
 *
 * 输出重定向到临时文件而不是管道：与调 tsc 同一个理由（受限环境不允许管道，
 * 而这里必须拿到 npm 的日志才能报错）。
 */
export function installDependencies(projectDir: string): { ok: boolean; output: string } {
    const logPath = join(tmpdir(), 'opm-npm-' + process.pid + '-' + Date.now() + '.log');
    const logFd = openSync(logPath, 'w');
    let result;
    try {
        result = spawnSync('npm', ['install'], {
            cwd: projectDir,
            shell: true,
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
        return { ok: false, output: output + '\n无法启动 npm：' + result.error.message };
    }
    return { ok: result.status === 0, output };
}
