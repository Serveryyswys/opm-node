'use strict';

/**
 * 生成 build/ 下的发布产物。源仓库里改完代码跑这一条即可：
 *
 *     npm run package
 *
 * 做四件事：编译 -> 组装 build/package/ -> npm pack -> 写 build/PUBLISH.md（含校验值）。
 *
 * 与 node.operit 的打包脚本同构，几条踩过的经验都保留了：
 *   - 子进程输出走 stdio: 'inherit' / 文件描述符，不用管道（受限环境不允许管道捕获）；
 *   - 清 build/ 只删内容不删目录（Windows 上目录可能被别的进程占用，rmdir 会 EBUSY）；
 *   - 发布版 manifest 从源**派生**并删掉不该发布的字段（白名单会静默丢字段）；
 *   - 打完包**校验条目清单**，少文件就报错退出，而不是发一个残包。
 */

var fs = require('fs');
var path = require('path');
var zlib = require('zlib');
var crypto = require('crypto');
var childProcess = require('child_process');

var root = path.join(__dirname, '..');
var buildDir = path.join(root, 'build');
var pkgDir = path.join(buildDir, 'package');

function run(command, workdir) {
    var result = childProcess.spawnSync(command, { cwd: workdir, stdio: 'inherit', shell: true });
    if (result.status !== 0) {
        throw new Error('命令失败（退出码 ' + result.status + '）：' + command);
    }
}

function copyInto(from, to, names) {
    for (var i = 0; i < names.length; i += 1) {
        var source = path.join(from, names[i]);
        var target = path.join(to, names[i]);
        if (fs.statSync(source).isDirectory()) {
            fs.cpSync(source, target, { recursive: true });
        } else {
            fs.copyFileSync(source, target);
        }
    }
}

/** 极简 tar 目录解析（只读文件名），用来核对产物条目。 */
function listTarEntries(buffer) {
    var names = [];
    var offset = 0;
    while (offset + 512 <= buffer.length) {
        var header = buffer.subarray(offset, offset + 512);
        var allZero = true;
        for (var i = 0; i < 512; i += 1) {
            if (header[i] !== 0) { allZero = false; break; }
        }
        if (allZero) { break; }
        var name = header.subarray(0, 100).toString('utf8').replace(/\u0000[\s\S]*$/, '');
        var prefix = header.subarray(345, 500).toString('utf8').replace(/\u0000[\s\S]*$/, '');
        if (prefix.length > 0) { name = prefix + '/' + name; }
        var sizeText = header.subarray(124, 136).toString('utf8').replace(/\u0000[\s\S]*$/, '').trim();
        var size = parseInt(sizeText, 8) || 0;
        var typeFlag = String.fromCharCode(header[156]);
        if (typeFlag === '0' || typeFlag === '\u0000') { names.push(name); }
        offset += 512 + Math.ceil(size / 512) * 512;
    }
    return names;
}

function countFiles(dir) {
    var total = 0;
    var entries = fs.readdirSync(dir, { withFileTypes: true });
    for (var i = 0; i < entries.length; i += 1) {
        total += entries[i].isDirectory() ? countFiles(path.join(dir, entries[i].name)) : 1;
    }
    return total;
}


/**
 * 版本已经发布就拒绝打包；**无法确认时同样拒绝**
 * （宁可什么都不产出，也不覆盖已发布版本）。
 *
 * 查询用文件描述符重定向而不是管道：受限环境下管道捕获子进程输出会失败，
 * 结果就是"查询输出为空 → 误判为可发布"。这个坑踩过一次。
 * 跳过检查：OPM_ALLOW_PUBLISHED=1
 */
function assertVersionUnpublished(name, version) {
    if (process.env.OPM_ALLOW_PUBLISHED === '1') {
        console.log('（OPM_ALLOW_PUBLISHED=1：跳过版本已发布检查）');
        return;
    }
    var logPath = path.join(root, '..', '.publish-check-' + process.pid + '.txt');
    var fd = fs.openSync(logPath, 'w');
    var result;
    try {
        result = childProcess.spawnSync(
            'npm view ' + name + '@' + version + ' version --cache "' + path.join(root, '..', '.npm-cache') + '"',
            { cwd: root, stdio: ['ignore', fd, fd], shell: true }
        );
    } finally {
        fs.closeSync(fd);
    }
    var out = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    fs.rmSync(logPath, { force: true });

    var published = result.status === 0 && out.indexOf(version) >= 0;
    // npm 新版输出 "npm error 404"，旧版是 "E404" —— 两种都认
    var definitelyMissing = /E?404/.test(out);
    if (published) {
        throw new Error('版本 ' + name + '@' + version + ' 已经在注册表上了。已发布的版本号不能复用，\n' +
            '请先把 package.json 的 version 升上去，再重新打包。');
    }
    if (!definitelyMissing) {
        throw new Error('无法确认 ' + name + '@' + version + ' 是否已发布（查询未返回 E404）。\n' +
            '为避免覆盖已发布版本，打包中止。确认它确实未发布后，可设 OPM_ALLOW_PUBLISHED=1 跳过检查。\n' +
            '查询输出：' + out.trim().split('\n').slice(-3).join(' | '));
    }
}

function main() {
    var sourcePkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

    console.log('== 1/4 编译 ==');
    run('npm run build', root);

    console.log('');
    console.log('== 2/4 组装 ' + path.relative(root, pkgDir) + ' ==');
    // 只清内容不删目录：Windows 上 build/ 可能被别的进程占着句柄，rmdir 会 EBUSY
    if (fs.existsSync(buildDir)) {
        var stale = fs.readdirSync(buildDir);
        for (var i = 0; i < stale.length; i += 1) {
            fs.rmSync(path.join(buildDir, stale[i]), { recursive: true, force: true });
        }
    }
    fs.mkdirSync(pkgDir, { recursive: true });
    copyInto(root, pkgDir, ['dist', 'README.md', 'LICENSE', 'NOTICE']);

    // 发布版 manifest：从源派生，删掉安装方不需要的字段。
    // 白名单挑选会在新增字段时静默丢失（author 就这么丢过一次）。
    var published = Object.assign({}, sourcePkg);
    delete published.scripts;
    delete published.devDependencies;
    delete published.private;
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(published, null, 2) + '\n', 'utf8');

    console.log('');
    console.log('== 3/4 打包 ==');
    assertVersionUnpublished('@serveryyswys/opm', sourcePkg.version);
    run('npm pack --cache "' + path.join(root, '..', '.npm-cache') + '"', pkgDir);
    var produced = fs.readdirSync(pkgDir).filter(function (name) { return name.slice(-4) === '.tgz'; });
    if (produced.length !== 1) {
        throw new Error('npm pack 产出了 ' + produced.length + ' 个 tgz，期望 1 个');
    }
    var tgzName = produced[0];
    fs.renameSync(path.join(pkgDir, tgzName), path.join(buildDir, tgzName));
    var tgzPath = path.join(buildDir, tgzName);
    var size = fs.statSync(tgzPath).size;
    var buffer = fs.readFileSync(tgzPath);
    var sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    var sha1 = crypto.createHash('sha1').update(buffer).digest('hex');
    var integrity = 'sha512-' + crypto.createHash('sha512').update(buffer).digest('base64');
    var distFiles = countFiles(path.join(pkgDir, 'dist'));

    // 校验条目清单：少文件就当场炸，别发残包
    var entries = listTarEntries(zlib.gunzipSync(buffer));
    var required = [
        'package/package.json', 'package/README.md', 'package/LICENSE', 'package/NOTICE',
        'package/dist/cli.js', 'package/dist/index.js', 'package/dist/index.d.ts',
        'package/dist/lib/build.js', 'package/dist/lib/verify.js'
    ];
    var missing = required.filter(function (name) { return entries.indexOf(name) < 0; });
    var leaked = entries.filter(function (name) {
        return name.indexOf('package/src/') === 0 || name.indexOf('package/test/') === 0 || name.indexOf('package/tools/') === 0;
    });
    if (missing.length > 0) {
        throw new Error('产物缺少这些条目：' + missing.join(', ') + '\n实际：' + entries.slice(0, 12).join(', ') + ' …');
    }
    if (leaked.length > 0) {
        throw new Error('产物里混进了不该发布的目录：' + leaked.slice(0, 6).join(', '));
    }
    console.log('产物内容校验通过：' + entries.length + ' 个条目，未混入 src/ test/ tools/');

    console.log('');
    console.log('== 4/4 写 PUBLISH.md ==');
    var publish = [
        '# ' + published.name + ' ' + published.version + ' —— 发布',
        '',
        '本目录就是可直接发布的产物。',
        '',
        '| 路径 | 用途 |',
        '| --- | --- |',
        '| `package/` | **目录方式**：`cd package && npm publish --access public` |',
        '| `' + tgzName + '` | **tarball 方式**：`npm publish <tgz> --access public` |',
        '',
        '## 校验',
        '',
        '```',
        '文件名    ' + tgzName,
        '大小      ' + size + ' 字节（' + (size / 1024).toFixed(1) + ' KB）',
        '条目数    ' + entries.length,
        'SHA-1     ' + sha1,
        'SHA-256   ' + sha256,
        'integrity ' + integrity,
        'dist      ' + distFiles + ' 个文件（.js 与 .d.ts 成对）',
        '```',
        '',
        '发布后核对源的 `fileCount` 应为 **' + entries.length + '**、shasum 应为 **' + sha1 + '**。',
        '',
        '## 发布到哪里',
        '',
        '**公网 npm**：',
        '',
        '```bash',
        'npm publish --access public',
        '```',
        '',
        '需要 2FA 一次性密码（浏览器里过一道）。',
        '',
        '**辰锤源**：不是标准 npm registry —— 它走资源中心的投稿 API（`resource_center`），',
        '`npm publish --registry` 那条路对它是无效的。',
        '',
        '## 这个包是什么',
        '',
        '把 Operit 插件工程打成 `.toolpkg` 的构建器。使命只有一件：**构建，即出包**。',
        '脱离 Operit 生态，走普通 Node 环境；出包之后的调试归 Operit 的调试套件。',
        '',
        '两条用法等价：',
        '',
        '```bash',
        'opm build                  # 直接调',
        'npm run build              # 工程的 package.json 里写 "build": "opm build"',
        '```',
        '',
        '## 产物里没有的东西（刻意的）',
        '',
        '`src/`、`test/`、`tools/` 都不在包里 —— 安装方不需要。发布版也没有 `scripts`，',
        '安装方不会执行任何脚本；运行期只依赖 `typescript`（`opm build` 要用它编译 TS 工程）。'
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(buildDir, 'PUBLISH.md'), publish, 'utf8');

    console.log('');
    console.log('完成：');
    console.log('  ' + path.relative(root, pkgDir) + '/  (' + (countFiles(pkgDir)) + ' 个文件)');
    console.log('  ' + tgzName + '  ' + size + ' 字节 · ' + entries.length + ' 个条目');
    console.log('  SHA-1   ' + sha1);
    console.log('  SHA-256 ' + sha256);
}

main();
