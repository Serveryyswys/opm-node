'use strict';

/**
 * 产物验收闸门：node tools/accept-artifact.js <x.toolpkg>
 *
 * 存在理由（真实教训）：0.1.0–0.1.4 五个版本全部在 Operit 上**装不上**，
 * 而测试 129 条断言全绿 —— 因为测试只用自己的 readZip 读自己的 createZip，
 * 自证循环。真正发现问题的是一条外部命令：
 *
 *     file xxx.toolpkg
 *     → compression method=deflate   （OPM 的产物是 store）
 *
 * 所以这道闸门只用**外部**判定：
 *   1. .NET ZipArchive（与 Android 侧的 Java zip 同族）能完整打开；
 *   2. 全部条目 stored（CompressedLength == Length）—— 与 OPM 产物一致；
 *   3. 首条目是 manifest.json —— 安装器通常先读它；
 *   4. manifest.json 能被解析。
 * 任一条不过就以非 0 退出。
 */

var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');

function fail(message) {
    console.error('✗ ' + message);
    process.exitCode = 1;
}

function main() {
    var target = process.argv[2];
    if (!target) {
        console.error('用法：node tools/accept-artifact.js <x.toolpkg>');
        process.exitCode = 2;
        return;
    }
    var abs = path.resolve(target);
    if (!fs.existsSync(abs)) {
        fail('产物不存在：' + abs);
        return;
    }

    // 1-3 交给 .NET 的 ZipArchive（外部判定，不用本包自己的 readZip）
    var script = [
        'Add-Type -AssemblyName System.IO.Compression.FileSystem',
        '$z = [System.IO.Compression.ZipFile]::OpenRead("' + abs + '")',
        '"entries=" + $z.Entries.Count',
        '"first=" + $z.Entries[0].FullName',
        '$notStored = @($z.Entries | Where-Object { $_.CompressedLength -ne $_.Length })',
        '"uncompressed=$($notStored.Count)"',
        'try {',
        '  $m = $z.Entries | Where-Object { $_.FullName -eq "manifest.json" } | Select-Object -First 1',
        '  if ($m -eq $null) { "manifest=MISSING" } else {',
        '    $sr = New-Object System.IO.StreamReader($m.Open()); $t = $sr.ReadToEnd(); $sr.Close()',
        '    if ($t.Length -gt 1) { "manifest=OK" } else { "manifest=EMPTY" }',
        '  }',
        '} catch { "manifest=ERROR " + $_.Exception.Message }',
        '$z.Dispose()'
    ].join('; ');

    // 用文件描述符重定向而不是管道：受限环境/部分沙箱里管道捕获子进程输出会返回空，
    // 结果就是"读不到输出 → 误判为打不开"。这个坑今天已经踩过三次。
    var logPath = path.join(require('os').tmpdir(), 'opm-accept-' + process.pid + '.txt');
    var fd = fs.openSync(logPath, 'w');
    var result;
    try {
        result = childProcess.spawnSync('powershell', ['-NoProfile', '-Command', script], {
            stdio: ['ignore', fd, fd]
        });
    } finally {
        fs.closeSync(fd);
    }
    var out = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    fs.rmSync(logPath, { force: true });
    if (result.status !== 0) {
        fail('.NET ZipArchive 无法打开该归档：' + out.trim().slice(0, 300));
        return;
    }

    var entries = Number((out.match(/entries=(\d+)/) || [])[1]);
    var first = (out.match(/first=([^\r\n]+)/) || [])[1] || '';
    var uncompressed = Number((out.match(/uncompressed=(\d+)/) || [])[1] || '0');
    var manifest = (out.match(/manifest=([A-Z]+)/) || [])[1] || '';

    var ok = true;
    if (!(entries > 0)) { fail('归档为空'); ok = false; }
    if (uncompressed !== 0) { fail(uncompressed + ' 个条目不是 stored（与 OPM 产物不一致，Operit 可能装不上）'); ok = false; }
    if (first !== 'manifest.json') { fail('首条目不是 manifest.json（实际 ' + first + '）'); ok = false; }
    if (manifest !== 'OK') { fail('manifest.json 不可用（' + manifest + '）'); ok = false; }

    if (ok) {
        console.log('✓ 归档验收通过：' + entries + ' 个条目，全部 stored，manifest.json 置首');
    }
}

main();
