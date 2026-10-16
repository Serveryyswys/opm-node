'use strict';

/** opm version：列出版本信息（自身 / node.operit / 目标工程）。 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface VersionReport {
    opm: string;
    lines: string[];
    errors: string[];
}

function readVersion(path: string): string | null {
    if (!existsSync(path)) return null;
    try {
        const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; name?: unknown };
        return typeof manifest.version === 'string' ? manifest.version : null;
    } catch {
        return null;
    }
}

export function describeVersions(projectDir: string | undefined, opmVersion: string): VersionReport {
    const lines: string[] = [];
    const errors: string[] = [];
    lines.push('opm            ' + opmVersion);

    if (projectDir === undefined) {
        return { opm: opmVersion, lines, errors };
    }

    const dir = resolve(projectDir);
    if (!existsSync(dir)) {
        errors.push('目录不存在：' + dir);
        return { opm: opmVersion, lines, errors };
    }

    const projectVersion = readVersion(join(dir, 'package.json'));
    lines.push('工程           ' + (projectVersion === null ? '（无 package.json 或未声明 version）' : projectVersion));

    const nodeOperitVersion = readVersion(join(dir, 'node_modules/@serveryyswys/node.operit/package.json'));
    if (nodeOperitVersion === null) {
        errors.push('工程里没装 @serveryyswys/node.operit（opm build 需要它提供 BUILTINS.json 契约）');
    } else {
        lines.push('node.operit    ' + nodeOperitVersion);
    }

    const toolpkgManifest = join(dir, 'manifest.json');
    if (existsSync(toolpkgManifest)) {
        try {
            const parsed = JSON.parse(readFileSync(toolpkgManifest, 'utf8')) as { toolpkg_id?: unknown; version?: unknown };
            const id = typeof parsed.toolpkg_id === 'string' ? parsed.toolpkg_id : '（未声明 toolpkg_id）';
            const version = typeof parsed.version === 'string' ? parsed.version : '（未声明 version）';
            lines.push('toolpkg        ' + id + ' ' + version);
        } catch (error) {
            errors.push('manifest.json 不是合法 JSON：' + String(error));
        }
    } else {
        lines.push('toolpkg        （无 manifest.json，这不是一个 Operit 工具包工程）');
    }

    return { opm: opmVersion, lines, errors };
}
