/**
 * 打包器：把「归档文件集合」写进一个临时目录，再压成 .toolpkg。
 *
 * ToolPkg 归档 = zip，内部布局：
 *   manifest.json
 *   main.js
 *   ui/xxx/index.ui.js
 *   core/*.js
 *   packages/*.js
 *   node_modules/<被引用的包>/*.js
 *
 * 产物文件名：<项目根目录名>.toolpkg（放在项目根的同级目录）
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { createZip } from '../lib/zip';
import { ArchiveFile } from './reachability';

export interface PackOptions {
    /** 项目根目录（Android 侧绝对路径） */
    projectDir: string;
    /** 归档内路径 -> 文件内容 */
    files: Map<string, ArchiveFile>;
    /** manifest.json 的文本内容（由 build 命令生成/校验） */
    manifestText: string;
    /** 产物文件名（不含 .toolpkg），默认取项目根目录名 */
    outName?: string;
    /** 临时组装目录（绝对路径） */
    stageDir: string;
    /** 产物落盘目录（绝对路径），默认为项目根的上一级目录 */
    outDir?: string;
}

export interface PackResult {
    ok: boolean;
    /** 产物绝对路径 */
    toolpkgPath: string;
    /** 打进归档的文件数 */
    fileCount: number;
    message: string;
}

function join(a: string, b: string): string {
    if (!a) return b;
    if (!b) return a;
    return a.endsWith('/') ? a + b : a + '/' + b;
}

function baseName(p: string): string {
    return basename(String(p).replace(/\/+$/, ''));
}

/**
 * 组装 + 打包。
 */
export async function packToolpkg(opts: PackOptions): Promise<PackResult> {
    const stage = opts.stageDir;

    // 1. 清空并重建 stage 目录
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });

    // 2. 写 manifest.json
    await writeFile(join(stage, 'manifest.json'), opts.manifestText);

    // 3. 写全部归档文件
    let count = 0;
    for (const [relPath, file] of opts.files) {
        const abs = join(stage, relPath);
        const parent = dirname(abs);
        mkdirSync(parent, { recursive: true });
        // 二进制资源（base64）走 writeBinary，其余走文本 write
        if (file.binary !== undefined) {
            await writeBinaryFile(abs, file.binary);
        } else {
            await writeFile(abs, file.text);
        }
        count += 1;
    }

    // 4. 压成 .toolpkg（zip，不含顶层目录）
    const name = opts.outName || baseName(opts.projectDir);
    // 与 opm-operit 的唯一差异：默认落盘目录是 <项目根>/opmbuild，而不是项目根的上一级。
    const destDir = (opts.outDir && opts.outDir.trim())
        ? opts.outDir.replace(/\/+$/, '')
        : join(opts.projectDir.replace(/\/+$/, ''), 'opmbuild');
    // 确保落盘目录存在
    mkdirSync(destDir, { recursive: true });
    const toolpkgPath = join(destDir, name + '.toolpkg');

    const zipRes = await zipDir(stage, toolpkgPath);
    if (!zipRes.ok) {
        return {
            ok: false,
            toolpkgPath: toolpkgPath,
            fileCount: count,
            message: '压缩失败：' + zipRes.message
        };
    }
    // 清理组装临时目录
    rmSync(stage, { recursive: true, force: true });

    return {
        ok: true,
        toolpkgPath: toolpkgPath,
        fileCount: count,
        message: '已打包 ' + count + ' 个文件 -> ' + toolpkgPath
    };
}

async function zipDir(srcDir: string, destZip: string): Promise<{ ok: boolean; message: string }> {
    try {
        // 与 Tools.Files.zip 的 include_root_directory=false 等价：归档内直接是 manifest.json 等。
        // manifest.json 置首（安装器通常先读它）；按 name 字段排序。
        const entries: Array<{ path: string; content: Buffer }> = [];
        const walk = (absDir: string, relDir: string): void => {
            for (const entry of readdirSync(absDir, { withFileTypes: true })) {
                const rel = relDir === '' ? entry.name : relDir + '/' + entry.name;
                const abs = join(absDir, entry.name);
                if (entry.isDirectory()) {
                    walk(abs, rel);
                    continue;
                }
                entries.push({ path: rel, content: readFileSync(abs) });
            }
        };
        walk(srcDir, '');
        entries.sort((a, b) => (a.path === 'manifest.json' ? -1 : b.path === 'manifest.json' ? 1 : (a.path < b.path ? -1 : 1)));
        writeFileSync(destZip, createZip(entries));
        return { ok: true, message: 'ok' };
    } catch (e) {
        return { ok: false, message: String(e) };
    }
}

async function writeBinaryFile(path: string, base64: string): Promise<void> {
    writeFileSync(path, Buffer.from(base64, 'base64'));
}

async function writeFile(path: string, content: string): Promise<void> {
    writeFileSync(path, content, 'utf8');
}

function shq(s: string): string {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
}