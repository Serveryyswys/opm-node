'use strict';

/**
 * 极简 zip 写入器（stored / deflate，零依赖）。
 *
 * 为什么自己写：.toolpkg 就是 zip，而 Node 只带 zlib（能 deflate）却没有 zip 容器。
 * 引第三方 zip 库会破坏"零依赖"这条线；调系统 zip/tar 则在 Windows / Linux 之间不可移植。
 *
 * 只实现打包需要的最小子集：无 zip64（单文件与总量 < 4GiB 足够）、无加密、无数据描述符。
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib';

export interface ZipEntry {
    /** 归档内路径，正斜杠分隔，不带前导斜杠 */
    path: string;
    /** 文件内容 */
    content: Buffer;
}

const CRC_TABLE = (function buildTable(): Uint32Array {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
        let value = index;
        for (let bit = 0; bit < 8; bit += 1) {
            value = (value & 1) !== 0 ? (0xedb88320 ^ (value >>> 1)) >>> 0 : (value >>> 1) >>> 0;
        }
        table[index] = value >>> 0;
    }
    return table;
})();

function crc32(buffer: Buffer): number {
    let value = 0xffffffff;
    for (let index = 0; index < buffer.length; index += 1) {
        value = (CRC_TABLE[(value ^ buffer[index]) & 0xff] ^ (value >>> 8)) >>> 0;
    }
    return (value ^ 0xffffffff) >>> 0;
}

/** MS-DOS 时间/日期（zip 的传统字段；固定值可让产物可复现）。 */
const DOS_TIME = 0;
const DOS_DATE = (40 << 9) | (1 << 5) | 1;

export interface ZipOptions {
    /** 归档内文件的修改时间是否写死（默认写死，保证同样的输入产出同样的字节） */
    reproducible?: boolean;
    /** 打包时刻（reproducible 为 false 时使用） */
    mtime?: Date;
}

// 归档内路径必须根相对：不能有 ..、不能以 / 开头、不能有反斜杠。
// 入口在 dist/ 下时到 node_modules 的相对写法是 ../node_modules/... ——
// 那个字符串一旦被当成归档路径写进 zip，Operit 就报 "Failed to parse toolpkg file"。
function assertArchivePath(entryPath: string): void {
    if (entryPath === '') {
        throw new Error('归档路径不能为空');
    }
    if (entryPath.indexOf('\\') >= 0) {
        throw new Error('归档路径不能用反斜杠：' + entryPath);
    }
    if (entryPath.charAt(0) === '/') {
        throw new Error('归档路径不能是绝对路径：' + entryPath);
    }
    for (const segment of entryPath.split('/')) {
        if (segment === '..') {
            throw new Error('归档路径不能包含 ..：' + entryPath);
        }
        if (segment === '.' || segment === '') {
            throw new Error('归档路径不能包含 . 或空段：' + entryPath);
        }
    }
}

export function createZip(entries: readonly ZipEntry[], options: ZipOptions = {}): Buffer {
    const reproducible = options.reproducible !== false;
    let dosTime = DOS_TIME;
    let dosDate = DOS_DATE;
    if (!reproducible) {
        const when = options.mtime === undefined ? new Date() : options.mtime;
        dosTime = (when.getHours() << 11) | (when.getMinutes() << 5) | (Math.floor(when.getSeconds() / 2));
        dosDate = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
    }

    const localParts: Buffer[] = [];
    const centralParts: Buffer[] = [];
    let offset = 0;

    // 不排序：保持调用方给的顺序，让 manifest.json 是**第一个**条目
    // （安装器通常先从首条目读清单）。
    const sorted = entries.slice();

    for (const entry of sorted) {
        assertArchivePath(entry.path);
        const nameBytes = Buffer.from(entry.path, 'utf8');
        // Java 的 ZipOutputStream 只对非 ASCII 文件名置 EFS 位；我们也只在这种情况下置
        const utf8Flag = /[^\x00-\x7f]/.test(entry.path) ? 0x0800 : 0;
        const crc = crc32(entry.content);
        // 一律 STORED（method 0），不压缩。
        //
        // 依据实测：OPM 的产物（走 Android 的 Tools.Files.zip）是 compression method=store，
        // Operit 装得上；而 deflate 的包**装不上**。归档里主要是 JS 文本，体积不是瓶颈，
        // 与能装上的格式保持一致比省几 KB 重要得多。
        const payload = entry.content;
        const method = 0;

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);            // version needed
        local.writeUInt16LE(utf8Flag, 6);      // flags: 仅文件名非 ASCII 时置 UTF-8 位
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(dosTime, 10);
        local.writeUInt16LE(dosDate, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(payload.length, 18);
        local.writeUInt32LE(entry.content.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        local.writeUInt16LE(0, 28);            // extra length
        localParts.push(local, nameBytes, payload);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);          // version made by
        central.writeUInt16LE(20, 6);          // version needed
        central.writeUInt16LE(utf8Flag, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(dosTime, 12);
        central.writeUInt16LE(dosDate, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(payload.length, 20);
        central.writeUInt32LE(entry.content.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt16LE(0, 30);          // extra
        central.writeUInt16LE(0, 32);          // comment
        central.writeUInt16LE(0, 34);          // disk number
        central.writeUInt16LE(0, 36);          // internal attrs
        central.writeUInt32LE(0, 38);          // external attrs
        central.writeUInt32LE(offset, 42);
        centralParts.push(central, nameBytes);

        offset += local.length + nameBytes.length + payload.length;
    }

    const centralBuffer = Buffer.concat(centralParts);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(sorted.length, 8);
    end.writeUInt16LE(sorted.length, 10);
    end.writeUInt32LE(centralBuffer.length, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);

    return Buffer.concat([Buffer.concat(localParts), centralBuffer, end]);
}

/**
 * 读取 zip（只解析本模块写出的那种：无 zip64、无加密）。
 * 有它才能在不依赖系统 unzip 的前提下自检产物 —— opm verify 与测试都靠这个。
 */
export function readZip(buffer: Buffer): ZipEntry[] {
    // 从尾部回扫 End of Central Directory
    let end = -1;
    for (let index = buffer.length - 22; index >= 0 && index > buffer.length - 66000; index -= 1) {
        if (buffer.readUInt32LE(index) === 0x06054b50) {
            end = index;
            break;
        }
    }
    if (end < 0) {
        throw new Error('不是 zip：找不到 End of Central Directory');
    }
    const count = buffer.readUInt16LE(end + 10);
    let cursor = buffer.readUInt32LE(end + 16);
    const entries: ZipEntry[] = [];

    for (let index = 0; index < count; index += 1) {
        if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
            throw new Error('不是 zip：中央目录项签名不对（第 ' + index + ' 项）');
        }
        const method = buffer.readUInt16LE(cursor + 10);
        const compressedSize = buffer.readUInt32LE(cursor + 20);
        const nameLength = buffer.readUInt16LE(cursor + 28);
        const extraLength = buffer.readUInt16LE(cursor + 30);
        const commentLength = buffer.readUInt16LE(cursor + 32);
        const localOffset = buffer.readUInt32LE(cursor + 42);
        const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

        const localNameLength = buffer.readUInt16LE(localOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        const payload = buffer.subarray(dataStart, dataStart + compressedSize);

        entries.push({
            path: name,
            content: method === 8 ? inflateRawSync(payload) : Buffer.from(payload)
        });
        cursor += 46 + nameLength + extraLength + commentLength;
    }

    return entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}
