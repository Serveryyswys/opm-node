'use strict';

/**
 * PACKINFO：打包信息核对文件（归档根，文件名无扩展名，内容 YAML）。
 *
 * 语义对齐 OPM 的 src/build/packinfo.ts：
 *   - 仅当 manifest.packinfo.enable === true 时生成；否则不写这个文件；
 *   - 字段顺序固定 name → description → id → version → author → license → dependencies；
 *   - 每个字段「有才写、缺则跳过」；id / version 恒有（manifest 是构建前提）；
 *   - dependencies 从**归档内实际收进的路径**反推（node_modules/<pkg>/... → 包名），
 *     作用域粒度为 @scope/pkg，去重并保持首次出现顺序；
 *   - 不写 extra_files。
 */

export interface PackInfoOptions {
    /** 开关：仅 true 时生成 */
    enable?: unknown;
    name?: unknown;
    description?: unknown;
    version?: unknown;
    author?: unknown;
    license?: unknown;
}

/** 取本地化文本：优先 .zh，其次 .en，再次任意非空字符串。 */
function localized(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    if (value !== null && typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        if (typeof obj.zh === 'string' && obj.zh !== '') {
            return obj.zh;
        }
        if (typeof obj.en === 'string' && obj.en !== '') {
            return obj.en;
        }
        for (const key of Object.keys(obj)) {
            const candidate = obj[key];
            if (typeof candidate === 'string' && candidate !== '') {
                return candidate;
            }
        }
    }
    return '';
}

/** YAML 标量：含特殊字符时才加双引号。 */
function yamlScalar(value: string): string {
    const text = String(value);
    if (/^\s|\s$/.test(text) || /[:#"'\[\]{}&*!|>%@`,]/.test(text) || /\n/.test(text)) {
        return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
    }
    return text;
}

/**
 * 从归档路径集合推导依赖列表。
 *
 * 依据"实际进包的文件"而不是"解析到的裸名"：这样 node.operit 这类因内建重写
 * 而带进来的运行时也会被如实列为依赖 —— 它就是依赖。
 */
export function collectDependenciesFromArchive(archivePaths: Iterable<string>): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const prefix = 'node_modules/';
    for (const raw of archivePaths) {
        const path = String(raw === undefined ? '' : raw).replace(/\\/g, '/');
        if (path.indexOf(prefix) !== 0) {
            continue;
        }
        const segments = path.slice(prefix.length).split('/');
        let name = '';
        if (segments[0].charAt(0) === '@') {
            if (segments.length < 2 || segments[1] === '') {
                continue;
            }
            name = segments[0] + '/' + segments[1];
        } else {
            if (segments[0] === '') {
                continue;
            }
            name = segments[0];
        }
        if (seen.has(name)) {
            continue;
        }
        seen.add(name);
        out.push(name);
    }
    return out;
}

/** 生成 PACKINFO 文本；返回 null 表示不生成。 */
export function renderPackInfo(
    manifest: Record<string, unknown>,
    options: PackInfoOptions | null | undefined,
    archivePaths: Iterable<string>,
    packageJson?: { license?: unknown; author?: unknown } | null
): string | null {
    if (options === null || options === undefined || options.enable !== true) {
        return null;
    }

    const lines: string[] = [];

    const name = String(options.name === undefined ? '' : options.name) ||
        localized(manifest.display_name) || localized(manifest.displayName);
    if (name !== '') {
        lines.push('name: ' + yamlScalar(name));
    }

    const description = String(options.description === undefined ? '' : options.description) || localized(manifest.description);
    if (description !== '') {
        lines.push('description: ' + yamlScalar(description));
    }

    const id = String(manifest.toolpkg_id === undefined ? (manifest.id === undefined ? '' : manifest.id) : manifest.toolpkg_id);
    if (id !== '') {
        lines.push('id: ' + yamlScalar(id));
    }

    const version = String(options.version === undefined ? '' : options.version) || String(manifest.version === undefined ? '' : manifest.version);
    if (version !== '') {
        lines.push('version: ' + yamlScalar(version));
    }

    let author = String(options.author === undefined ? '' : options.author);
    if (author === '' && packageJson !== null && packageJson !== undefined && typeof packageJson.author === 'string' && packageJson.author !== '') {
        author = packageJson.author;
    }
    if (author === '') {
        const raw = manifest.author;
        if (Array.isArray(raw)) {
            author = raw.map((item) => String(item)).filter((item) => item !== '').join(', ');
        } else if (typeof raw === 'string') {
            author = raw;
        }
    }
    if (author !== '') {
        lines.push('author: ' + yamlScalar(author));
    }

    // 许可证以 package.json 为准（manifest 里不一定写）；顺序：显式参数 > package.json > manifest
    const license = String(options.license === undefined ? '' : options.license)
        || String(packageJson !== null && packageJson !== undefined && packageJson.license !== undefined ? packageJson.license : '')
        || String(manifest.license === undefined ? '' : manifest.license);
    if (license !== '') {
        lines.push('license: ' + yamlScalar(license));
    }

    const dependencies = collectDependenciesFromArchive(archivePaths);
    if (dependencies.length > 0) {
        lines.push('dependencies:');
        for (const dependency of dependencies) {
            lines.push('  - ' + yamlScalar(dependency));
        }
    }

    if (lines.length === 0) {
        return null;
    }
    return lines.join('\n') + '\n';
}
