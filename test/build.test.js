'use strict';

/**
 * opm 的测试。针对**移植后**的构建管线（commands/build.ts → build/*）。
 * 旧测试建在已删除的 lib/build.ts 上，随实现一起弃用。
 */

var fs = require('fs');
var path = require('path');
var os = require('os');
var lib = require('../dist/index.js');

var passed = 0;
var failed = 0;
var failures = [];

function ok(condition, label, detail) {
    if (condition) { passed += 1; return; }
    failed += 1;
    failures.push(label + (detail === undefined ? '' : '  [' + detail + ']'));
}
function equal(actual, expected, label) {
    ok(actual === expected, label, '实际 ' + JSON.stringify(actual) + ' / 期望 ' + JSON.stringify(expected));
}

var TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'opm-test-'));

function makeProject(name, files) {
    var dir = path.join(TMP, name);
    var c = path.join(dir, 'node_modules/@serveryyswys/node.operit');
    fs.mkdirSync(path.join(c, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(c, 'package.json'), JSON.stringify({ name: '@serveryyswys/node.operit', version: '0.1.7', license: 'Apache-2.0', author: 'serveryyswys' }));
    fs.writeFileSync(path.join(c, 'BUILTINS.json'), JSON.stringify({
        schema_version: 1, package: '@serveryyswys/node.operit', distDir: 'dist',
        installDir: 'node_modules/@serveryyswys/node.operit',
        builtins: {
            path: { subpath: 'path', status: 'ready', note: 't' },
            fs: { subpath: 'fs', status: 'ready', note: 't' },
            process: { subpath: 'process', status: 'ready', note: 't' },
            buffer: { subpath: 'buffer', status: 'ready', note: 't' },
            vm: { subpath: 'vm', status: 'unsupported', note: 'QuickJS 没有独立上下文' }
        }
    }));
    ['path.js', 'fs.js', 'process.js', 'buffer.js'].forEach(function (s) {
        fs.writeFileSync(path.join(c, 'dist', s), 'module.exports = {};\n');
    });
    Object.keys(files || {}).forEach(function (rel) {
        var full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, files[rel]);
    });
    return dir;
}

function manifest(extra) {
    return JSON.stringify(Object.assign({ schema_version: 1, toolpkg_id: 'top.serveryyswys.t', version: '1.0.0', main: 'main.js' }, extra || {}), null, 2);
}
function archive(p) {
    var zip = lib.readZip(fs.readFileSync(p));
    var map = {};
    zip.forEach(function (e) { map[e.path] = e.content; });
    return { names: zip.map(function (e) { return e.path; }), map: map };
}

async function run() {
    // 1. 正常构建
    var d1 = makeProject('basic', { 'manifest.json': manifest(), 'main.js': "const p = require('path');\nexports.registerToolPkg = function () { return p.sep; };\n" });
    var r1 = await lib.runBuild({ projectDir: d1 });
    ok(r1.ok, '基本工程构建成功', r1.message);
    if (r1.ok) {
        var a1 = archive(r1.toolpkgPath);
        ok(a1.names.indexOf('node_modules/@serveryyswys/node.operit/dist/path.js') >= 0, 'path.js 进包');
        ok(!a1.names.some(function (n) { return n.indexOf('..') >= 0; }), '没有 .. 路径');
        equal(r1.toolpkgPath.replace(/\\/g, '/').indexOf(d1.replace(/\\/g, '/') + '/opmbuild') >= 0, true, '默认落到 <项目根>/opmbuild');
        equal(fs.readFileSync(r1.toolpkgPath).readUInt16LE(8), 0, '第一个条目的压缩方法是 stored');
        // 归档内的首条目名直接从本地头读（readZip 会按名排序，不能用它判断顺序）
        var rawBuf = fs.readFileSync(r1.toolpkgPath);
        equal(rawBuf.subarray(30, 30 + rawBuf.readUInt16LE(26)).toString(), 'manifest.json', '归档首条目是 manifest.json');
    }

    // 2. dryRun 不落盘
    var d2 = makeProject('dry', { 'manifest.json': manifest({ toolpkg_id: 'top.real.dry' }), 'main.js': 'module.exports = 1;\n' });
    var r2 = await lib.runBuild({ projectDir: d2, dryRun: true });
    ok(r2.ok, 'dryRun 成功', r2.message);
    ok(!fs.existsSync(path.join(d2, 'opmbuild')), 'dryRun 不写产物目录');

    // 3. unsupported 裸名
    var d3 = makeProject('blocked', { 'manifest.json': manifest({ toolpkg_id: 'top.real.b' }), 'main.js': "require('vm');\n" });
    var r3 = await lib.runBuild({ projectDir: d3 });
    ok(!r3.ok, 'unsupported 裸名让构建失败');
    equal(r3.stage, 'contract-check', '失败阶段是契约拦截');

    // 4. extra_files
    var d4 = makeProject('extra', { 'manifest.json': manifest({ toolpkg_id: 'top.real.e' }), 'main.js': 'module.exports = 1;\n', 'resources/logo.svg': '<svg/>\n' });
    var r4 = await lib.runBuild({ projectDir: d4, extraFiles: ['resources'] });
    ok(r4.ok, '带 extra_files 成功', r4.message);
    if (r4.ok) { ok(archive(r4.toolpkgPath).names.indexOf('resources/logo.svg') >= 0, 'extra_files 目录递归收起'); }

    // 5. PACKINFO 的 license 取自 package.json
    var d5 = makeProject('packinfo', {
        'manifest.json': manifest({ toolpkg_id: 'top.real.p', version: '2.0.0' }),
        'package.json': JSON.stringify({ name: 'x', version: '2.0.0', license: 'GPL-3.0-or-later', author: 'someone' }),
        'main.js': 'module.exports = 1;\n'
    });
    var r5 = await lib.runBuild({ projectDir: d5, packinfo: { enable: true } });
    ok(r5.ok, 'PACKINFO 成功', r5.message);
    if (r5.ok) {
        var a5 = archive(r5.toolpkgPath);
        var text = a5.map['PACKINFO'] === undefined ? '' : a5.map['PACKINFO'].toString();
        ok(a5.names.indexOf('PACKINFO') >= 0, 'PACKINFO 在归档根');
        ok(text.indexOf('license: GPL-3.0-or-later') >= 0, 'license 取自 package.json', text.slice(0, 120));
        ok(text.indexOf('author: someone') >= 0, 'author 取自 package.json');
    }

    // 6. 动态 require 的前缀目录
    var d6 = makeProject('dyn', {
        'manifest.json': manifest({ toolpkg_id: 'top.real.d' }),
        'main.js': "var n = 'en.js';\nrequire('./libs/' + n);\n",
        'libs/en.js': 'module.exports = 1;\n',
        'libs/zh.js': 'module.exports = 2;\n'
    });
    var r6 = await lib.runBuild({ projectDir: d6 });
    ok(r6.ok, '有静态前缀的动态 require 能构建', r6.message);
    if (r6.ok) {
        var a6 = archive(r6.toolpkgPath);
        ok(a6.names.indexOf('libs/en.js') >= 0 && a6.names.indexOf('libs/zh.js') >= 0, '前缀目录整目录进归档');
    }

    // 7. 全局注入按需
    var d7 = makeProject('noglobals', { 'manifest.json': manifest({ toolpkg_id: 'top.real.ng' }), 'main.js': "// process Buffer 只在注释\nvar s = 'process';\nmodule.exports = s;\n" });
    var r7 = await lib.runBuild({ projectDir: d7 });
    ok(r7.ok, '仅注释提到 process 时成功', r7.message);
    if (r7.ok) {
        var a7 = archive(r7.toolpkgPath);
        ok(a7.names.indexOf('node_modules/@serveryyswys/node.operit/dist/process.js') < 0, '不因注释误判而注入');
        ok(a7.map['main.js'].toString().indexOf('__g.process') < 0, '入口无注入语句');
    }

    // 8. 模拟加载（simulate）
    var sim = require('../dist/commands/simulate.js');
    var mainWithReg = "exports.registerToolPkg = function () { return true; };\n";
    var reg = sim.simulateRegistration(mainWithReg);
    ok(reg.hasRegisterFn === true || reg.issues.length > 0, '模拟注册能识别 registerToolPkg（或给出原因）', JSON.stringify(reg.issues));
    var meta = [
        '/* METADATA',
        '{',
        '  "name": "demo",',
        '  "description": "示例",',
        '  "tools": [',
        '    { "name": "do_thing", "description": "做点事", "parameters": [] }',
        '  ]',
        '}',
        '*/',
        'function do_thing() { return 1; }'
    ].join('\n');
    var parsed = sim.simulateSubpackageMeta('packages/demo.js', meta);
    ok(parsed.hasMeta === true, '抽到 METADATA 块');
    ok(parsed.parsed === true, 'METADATA 能被 hjson 解析');
    equal(parsed.name, 'demo', 'METADATA 的 name');
    equal(parsed.toolCount, 1, 'METADATA 的 tool 数');
    var noMeta = sim.simulateSubpackageMeta('packages/x.js', 'module.exports = 1;\n');
    ok(noMeta.hasMeta === false, '没有 METADATA 时如实报告');

    console.log('');
    if (failures.length > 0) {
        console.log('失败样例:');
        failures.slice(0, 20).forEach(function (f) { console.log('  - ' + f); });
    }
    console.log('passed: ' + passed + ', failed: ' + failed);
    fs.writeFileSync(path.join(__dirname, 'last-run.txt'), 'passed: ' + passed + ', failed: ' + failed + '\n');
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exitCode = failed === 0 ? 0 : 1;
}

run().catch(function (e) { console.error(e); process.exitCode = 1; });
