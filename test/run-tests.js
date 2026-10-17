'use strict';

/**
 * opm 的测试。
 *
 * 自包含：用一份最小的 mock 契约，不依赖旁边的 node.operit 检出 ——
 * 契约表的形态由 node.operit 自己的测试负责，这里只测"拿到契约之后怎么用"。
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
    failures.push({ label: label, detail: detail === undefined ? '' : String(detail) });
}
function equal(actual, expected, label) {
    var same = JSON.stringify(actual) === JSON.stringify(expected);
    ok(same, label, same ? '' : '实际 ' + JSON.stringify(actual) + ' / 期望 ' + JSON.stringify(expected));
}

var TMP = path.join(__dirname, '.tmp');
fs.rmSync(TMP, { recursive: true, force: true });

/** 造一个装了 mock 契约的工程目录。 */
function makeProject(name, files) {
    var dir = path.join(TMP, name);
    fs.mkdirSync(dir, { recursive: true });
    var contractDir = path.join(dir, 'node_modules/@serveryyswys/node.operit');
    fs.mkdirSync(path.join(contractDir, 'dist'), { recursive: true });
    // 真实安装里包一定有自己的 package.json —— 依赖审计就是按它判断"装没装"的
    fs.writeFileSync(path.join(contractDir, 'package.json'), JSON.stringify({
        name: '@serveryyswys/node.operit', version: '0.1.4', main: 'dist/index.js', license: 'Apache-2.0'
    }));
    fs.writeFileSync(path.join(contractDir, 'BUILTINS.json'), JSON.stringify({
        package: '@serveryyswys/node.operit',
        distDir: 'dist',
        subpathTemplate: '<distDir>/<subpath>.js',
        installDir: 'node_modules/@serveryyswys/node.operit',
        builtins: {
            path: { subpath: 'path', status: 'ready', note: '测试用' },
            fs: { subpath: 'fs', status: 'ready', note: '测试用' },
            process: { subpath: 'process', status: 'ready', note: '测试用' },
            buffer: { subpath: 'buffer', status: 'ready', note: '测试用' },
            vm: { subpath: 'vm', status: 'unsupported', note: 'QuickJS 没有独立上下文' }
        }
    }, null, 2));
    for (var stub of ['path.js', 'fs.js', 'process.js', 'buffer.js']) {
        fs.writeFileSync(path.join(contractDir, 'dist', stub), 'module.exports = {};\n');
    }
    for (var rel in files) {
        var target = path.join(dir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, files[rel]);
    }
    return dir;
}

// ---------------------------------------------------------------- findRequires

ok(JSON.stringify(lib.findRequires("require('a')")) === JSON.stringify([{ spec: 'a', dynamic: false, start: 9, end: 10 }]), 'findRequires 基本形态', JSON.stringify(lib.findRequires("require('a')")));
equal(lib.findRequires('require(name)').map(function (s) { return s.dynamic; }), [true], '变量实参标为动态');
equal(lib.findRequires("require('a' + x)").map(function (s) { return s.dynamic; }), [true], "拼接实参标为动态（不能截断成 'a'）");
equal(lib.findRequires('require(flag ? "a" : "b")').map(function (s) { return s.dynamic; }), [true], '三元实参标为动态');
equal(lib.findRequires('require("./x")').map(function (s) { return s.dynamic; }), [false], '纯字面量不算动态');
equal(lib.findRequires("// require('x')\n").length, 0, '行注释里的 require 不算');
equal(lib.findRequires('/* require("x") */').length, 0, '块注释里的 require 不算');
equal(lib.findRequires("var s = \"require('x')\";").length, 0, '字符串里的 require 不算');
equal(lib.findRequires("// 文档写 require('x')\nrequire('y');").map(function (s) { return s.spec; }), ['y'], '注释与真调用混在一起时只取真的');
equal(lib.findRequires('var re = /require\\(/; require("z")').map(function (s) { return s.spec; }), ['z'], '正则字面量里的 require 不算');
equal(lib.findRequires('require(\n  "multi"\n)').map(function (s) { return s.spec; }), ['multi'], '跨行的 require');
equal(lib.findRequires("myrequire('x')").length, 0, 'myrequire 不算（标识符边界）');

// ---------------------------------------------------------------- zip

var archive = lib.createZip([
    { path: 'main.js', content: Buffer.from('hello') },
    { path: 'a/b/c.js', content: Buffer.from('nested content') },
    { path: 'manifest.json', content: Buffer.from('{"main":"main.js"}') }
]);
ok(archive.length > 0, 'createZip 产出非空');
var read = lib.readZip(archive);
equal(read.map(function (entry) { return entry.path; }), ['a/b/c.js', 'main.js', 'manifest.json'], 'readZip 读回条目（且有序）');
equal(read.filter(function (e) { return e.path === 'a/b/c.js'; })[0].content.toString(), 'nested content', 'readZip 内容往返一致');
equal(lib.createZip([{ path: 'x.js', content: Buffer.from('a') }]).toString('hex'), lib.createZip([{ path: 'x.js', content: Buffer.from('a') }]).toString('hex'), '同样的输入产出同样的字节（可复现）');

// ---------------------------------------------------------------- rewrite

function envFor(projectDir) {
    return {
        locate: function (archivePath) {
            var disk = path.join(projectDir, archivePath);
            return fs.existsSync(disk) && fs.statSync(disk).isFile() ? disk : null;
        },
        contract: lib.loadContract(path.join(projectDir, 'node_modules/@serveryyswys/node.operit')),
        nodeOperitArchiveDir: 'node_modules/@serveryyswys/node.operit'
    };
}

var rewriteProject = makeProject('rewrite', {
    'main.js': '',
    'lib/helper.js': '',
    'node_modules/ms/package.json': JSON.stringify({ name: 'ms', version: '2.1.3', main: 'index.js' }),
    'node_modules/ms/index.js': ''
});
var env = envFor(rewriteProject);

var outcome = lib.rewriteModule(env, 'main.js',
    "require('path');\nrequire('ms');\nrequire('axios');\nrequire('./lib/helper');\n");
equal(outcome.errors, [], '重写无错误');
equal(outcome.code,
    "require('./node_modules/@serveryyswys/node.operit/dist/path.js');\n" +
    "require('./node_modules/ms/index.js');\n" +
    "require('axios');\n" +
    "require('./lib/helper.js');\n",
    '四类请求各自的改写结果');

var nested = lib.rewriteModule(env, 'lib/helper.js', "require('../main');\nrequire('fs');\n");
equal(nested.code,
    "require('../main.js');\n" +
    "require('../node_modules/@serveryyswys/node.operit/dist/fs.js');\n",
    '嵌套目录：相对引用与内建都按文件自身所在层解析', nested.code);

var blocked = lib.rewriteModule(env, 'main.js', "require('vm');\n");
ok(blocked.errors.length === 1, 'unsupported 依赖被拦截', JSON.stringify(blocked.errors));
ok(blocked.errors[0].indexOf('QuickJS 没有独立上下文') >= 0, '拦截信息带上契约里的原因', blocked.errors[0]);

var unknown = lib.rewriteModule(env, 'main.js', "require('not-installed-anywhere');\n");
ok(unknown.errors.length === 1, '未安装的包被拦截', JSON.stringify(unknown.errors));

var relativeMissing = lib.rewriteModule(env, 'main.js', "require('./nope');\n");
ok(relativeMissing.errors.length === 1, '解析不到的相对引用被拦截', JSON.stringify(relativeMissing.errors));

// ---------------------------------------------------------------- build

var project = makeProject('demo', {
    'manifest.json': JSON.stringify({ toolpkg_id: 'com.example.demo', version: '0.1.0', main: 'main.js', subpackages: [{ id: 'tool', entry: 'packages/tool.js' }] }),
    'main.js': "const path = require('path');\nconst ms = require('ms');\nconst axios = require('axios');\nconst helper = require('./lib/helper');\n",
    'lib/helper.js': "require('./deep');\n",
    'lib/deep.js': "module.exports = 1;\n",
    'lib/unreachable.js': "require('vm');\n",
    'packages/tool.js': "require('fs');\n",
    'node_modules/ms/package.json': JSON.stringify({ name: 'ms', version: '2.1.3', main: 'index.js' }),
    'node_modules/ms/index.js': "module.exports = function () {};\n"
});
var result = lib.buildProject({ projectDir: project });
ok(result.ok, 'build 成功', JSON.stringify(result.errors));
equal(result.errors, [], 'build 无错误');
equal(result.toolpkgPath, path.join(TMP, 'demo.toolpkg'), '产物落在项目目录的上一级');

// 归档自洽性：产物里每条相对 require 的目标必须真的在归档里。
//
// 这条是补出来的：曾经入口注入的 dist/process.js 没被算进可达集，
// 归档里因此少了它，产物一加载就 "Cannot resolve module"。
// 当时的测试只验证归档内容和重写文本，从不检查"引用是否闭合"，
// 所以完全没抓到 —— 而它影响的是每一个用户代码自己不 require process 的包。
function danglingRequires(zipPath) {
    var entries = lib.readZip(fs.readFileSync(zipPath));
    var present = new Set(entries.map(function (entry) { return entry.path; }));
    var dangling = [];
    entries.forEach(function (entry) {
        if (!/\.(js|cjs|mjs)$/.test(entry.path)) { return; }
        lib.findRequires(entry.content.toString('utf8')).forEach(function (site) {
            if (site.spec.charAt(0) !== '.') { return; }
            var target = path.posix.normalize(path.posix.join(path.posix.dirname(entry.path), site.spec));
            if (!present.has(target)) {
                dangling.push(entry.path + ' -> ' + site.spec);
            }
        });
    });
    return dangling;
}

var dangling = danglingRequires(result.toolpkgPath);
equal(dangling.length, 0, '归档内所有相对 require 都指向归档内存在的文件' + (dangling.length === 0 ? '' : ' —— ' + dangling.join('; ')));

var produced = lib.readZip(fs.readFileSync(result.toolpkgPath));
var names = produced.map(function (entry) { return entry.path; });
ok(names.indexOf('manifest.json') >= 0, '归档含 manifest.json');
ok(names.indexOf('main.js') >= 0 && names.indexOf('lib/helper.js') >= 0 && names.indexOf('lib/deep.js') >= 0, '可达文件都进包');
ok(names.indexOf('packages/tool.js') >= 0, '子包入口进包');
ok(names.indexOf('lib/unreachable.js') < 0, '不可达文件被裁剪掉（它依赖 vm，若进包会连带失败）');
ok(names.indexOf('node_modules/ms/index.js') >= 0, '被引用的 npm 包进包');
ok(names.some(function (n) { return n.indexOf('node_modules/@serveryyswys/node.operit/dist/path.js') >= 0; }), '被引用的 node.operit 子文件进包');
ok(!names.some(function (n) { return n.indexOf('node_modules/@serveryyswys/node.operit/dist/vm') >= 0; }), '没被引用的 node.operit 文件不进包');

var mainText = produced.filter(function (e) { return e.path === 'main.js'; })[0].content.toString();
// 锚点必须是改写后依然存在的文本（原来的 require('path') 已被改写成路径）
ok(mainText.indexOf('globalThis.process = require(') >= 0 &&
   mainText.indexOf('globalThis.process = require(') < mainText.indexOf('const path ='),
   '入口在用户代码之前注入 process 全局', mainText.slice(0, 160));
ok(mainText.indexOf('globalThis.Buffer = require(') >= 0, '入口注入 Buffer 全局');
ok(mainText.indexOf("require('./node_modules/@serveryyswys/node.operit/dist/path.js')") >= 0, '内建已重写');
ok(mainText.indexOf("require('axios')") >= 0, '运行时内建保持原样');

var blockedBuild = makeProject('blocked', {
    'manifest.json': JSON.stringify({ main: 'main.js' }),
    'main.js': "require('vm');\n"
});
var blockedResult = lib.buildProject({ projectDir: blockedBuild });
ok(!blockedResult.ok, '依赖 unsupported 时构建失败');
ok(blockedResult.errors.length === 1, '失败原因唯一且明确', JSON.stringify(blockedResult.errors));

var dryProject = makeProject('dry', {
    'manifest.json': JSON.stringify({ main: 'main.js' }),
    'main.js': "module.exports = 1;\n"
});
var dryResult = lib.buildProject({ projectDir: dryProject, dryRun: true });
ok(dryResult.ok && !fs.existsSync(path.join(TMP, 'dry.toolpkg')), 'dry-run 不写产物');

var noManifest = path.join(TMP, 'nomain');
fs.mkdirSync(noManifest, { recursive: true });
var noManifestResult = lib.buildProject({ projectDir: noManifest });
ok(!noManifestResult.ok && noManifestResult.errors[0].indexOf('manifest.json') >= 0, '缺 manifest.json 时明确报错');

// ---------------------------------------------------------------- TS 模式

/** 造一个 TS 工程。不需要在工程里装 typescript：opm 自带一份，解析时会兜到它。 */
function makeTsProject(name, files) {
    return makeProject(name, files);
}

var tsProject = makeTsProject('tsplugin', {
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2020', module: 'node16', moduleResolution: 'node16', strict: false, rootDir: 'src', outDir: '.opm_build' }, include: ['src/**/*.ts'] }),
    'manifest.json': JSON.stringify({ toolpkg_id: 'com.example.ts', version: '0.1.0', main: 'dist/main.js' }),
    'src/globals.d.ts': 'declare function require(name: string): any;\ndeclare const module: { exports: any };\n',
    'src/main.ts': "import { helper } from './lib/helper';\nconst path = require('path');\nexport const value = helper + path.sep;\n",
    'src/lib/helper.ts': "export const helper = 'hi';\n"
});
var tsResult = lib.buildProject({ projectDir: tsProject });
ok(tsResult.ok, 'TS 模式构建成功', JSON.stringify(tsResult.errors).slice(0, 300));

if (tsResult.ok) {
    var tsEntries = lib.readZip(fs.readFileSync(tsResult.toolpkgPath));
    var tsNames = tsEntries.map(function (entry) { return entry.path; });
    // 关键：归档内路径是 manifest 视角（dist/...），而磁盘上产物在 .opm_build/
    ok(tsNames.indexOf('dist/main.js') >= 0, '归档路径按 manifest 视角（dist/main.js），而不是 outDir', JSON.stringify(tsNames));
    ok(tsNames.indexOf('dist/lib/helper.js') >= 0, '被 import 的子模块也按 manifest 视角');
    ok(fs.existsSync(path.join(tsProject, '.opm_build/main.js')), '磁盘上产物确实在 outDir 里');
    var tsMain = tsEntries.filter(function (entry) { return entry.path === 'dist/main.js'; })[0].content.toString();
    // 不看引号：TS 对 import 语句发射双引号，对手写的 require 保留原引号
    ok(tsMain.indexOf('./lib/helper.js') >= 0, 'TS 编译出的 require 也被重写并补了 .js', tsMain.slice(0, 400));
    ok(tsMain.indexOf('../node_modules/@serveryyswys/node.operit/dist/path.js') >= 0, 'TS 里的内建也被重写', tsMain.slice(-300));
}

// 编译错误必须让构建失败，并且把编译器的原话带出来
var badTs = makeTsProject('badts', {
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2020', module: 'node16', moduleResolution: 'node16', strict: true, rootDir: 'src', outDir: '.opm_build' }, include: ['src/**/*.ts'] }),
    'manifest.json': JSON.stringify({ main: 'dist/main.js' }),
    'src/main.ts': 'export const value: number = "not a number";\n'
});
var badTsResult = lib.buildProject({ projectDir: badTs });
ok(!badTsResult.ok, 'TS 编译失败时构建失败');
ok(badTsResult.errors.join(' ').indexOf('tsc 编译失败') >= 0, '失败信息指明是 tsc 编译失败');
ok(badTsResult.errors.join(' ').indexOf('TS2322') >= 0, '把编译器错误码带出来了', badTsResult.errors.join(' ').slice(0, 200));

// ---------------------------------------------------------------- 构建期清单

// manifest.opmbuild.json 是构建期决策（打哪些额外文件 / 要不要 PACKINFO），
// 与运行时 manifest.json 分开；优先级更高。
var cfgProject = makeProject('opmbuildcfg', {
    'manifest.json': JSON.stringify({
        toolpkg_id: 'top.serveryyswys.cfg', version: '1.0.0', main: 'main.js',
        extra_files: ['ignored.md']      // 应被构建清单覆盖
    }),
    'manifest.opmbuild.json': JSON.stringify({
        extra_files: ['resources'],
        packinfo: { enable: true }
    }),
    'main.js': 'module.exports = 1;\n',
    'resources/logo.svg': '<svg></svg>\n',
    'ignored.md': 'x\n',
    'notes.md': 'y\n'
});
var cfgResult = lib.buildProject({ projectDir: cfgProject, install: false });
ok(cfgResult.ok, '带构建清单的工程构建成功', JSON.stringify(cfgResult.errors).slice(0, 300));
var cfgNames = lib.readZip(fs.readFileSync(cfgResult.toolpkgPath)).map(function (e) { return e.path; });
ok(cfgNames.indexOf('resources/logo.svg') >= 0, '构建清单里的目录被递归收起');
ok(cfgNames.indexOf('ignored.md') < 0, 'manifest.json 的 extra_files 被构建清单覆盖');
ok(cfgNames.indexOf('notes.md') < 0, '未声明的文件不进包');
ok(cfgNames.indexOf('PACKINFO') >= 0, '构建清单里的 packinfo.enable 生效');

// 坏 JSON 必须明确报错，不能静默忽略
var badCfgProject = makeProject('opmbuildbad', {
    'manifest.json': JSON.stringify({ toolpkg_id: 'top.real.bad', version: '1.0.0', main: 'main.js' }),
    'manifest.opmbuild.json': '{ not json',
    'main.js': 'module.exports = 1;\n'
});
var badCfgResult = lib.buildProject({ projectDir: badCfgProject, install: false });
ok(!badCfgResult.ok, '构建清单不是合法 JSON 时构建失败');
ok(badCfgResult.errors.join(' ').indexOf('manifest.opmbuild.json') >= 0, '报错点名是构建清单的问题');

// ---------------------------------------------------------------- 跨平台

// 大小写冲突：Windows 上 Res/a.js 与 res/A.js 是两个不同文件，
// 但归档路径 lowercase 后相同 —— 这种包在 Linux/macOS 上是歧义的。
var caseProject = makeProject('caseclash', {
    'manifest.json': JSON.stringify({ toolpkg_id: 'top.serveryyswys.case', version: '1.0.0', main: 'main.js' }),
    'manifest.opmbuild.json': JSON.stringify({ extra_files: ['Res', 'res'] }),
    'main.js': 'module.exports = 1;\n',
    'Res/a.js': '1;\n',
    'res/A.js': '2;\n'
});
var caseResult = lib.buildProject({ projectDir: caseProject, install: false });
ok(!caseResult.ok, '仅大小写不同的归档路径被拦下');
ok(caseResult.errors.join(' ').indexOf('仅大小写不同') >= 0, '报错指明是大小写冲突', caseResult.errors.join(' ').slice(0, 160));

// ---------------------------------------------------------------- OPM 对齐的参数

// PACKINFO 用大写键（OPM 的键名）
var upperProject = makeProject('packinfoupper', {
    'manifest.json': JSON.stringify({ toolpkg_id: 'top.real.upper', version: '1.0.0', main: 'main.js' }),
    'manifest.opmbuild.json': JSON.stringify({ PACKINFO: { enable: true } }),
    'main.js': 'module.exports = 1;\n'
});
var upperResult = lib.buildProject({ projectDir: upperProject, install: false });
ok(upperResult.ok, '大写 PACKINFO 键可用');
ok(lib.readZip(fs.readFileSync(upperResult.toolpkgPath)).some(function (e) { return e.path === 'PACKINFO'; }), '大写 PACKINFO 生效');

// outDir：产物落到指定目录
var outDirProject = makeProject('outdir', {
    'manifest.json': JSON.stringify({ toolpkg_id: 'top.real.outdir', version: '1.0.0', main: 'main.js' }),
    'main.js': 'module.exports = 1;\n'
});
var targetDir = path.join(TMP, 'custom-out');
var outDirResult = lib.buildProject({ projectDir: outDirProject, install: false, outDir: targetDir, outName: 'named' });
ok(outDirResult.ok, '指定 outDir 构建成功');
equal(outDirResult.toolpkgPath, path.join(targetDir, 'named.toolpkg'), '产物落在 outDir 且用 outName');

// skipCompile：TS 工程跳过编译时不跑 tsc（用一个没装 typescript 的工程验证不会被编译拖累）
var skipProject = makeProject('skipcompile', {
    'manifest.json': JSON.stringify({ toolpkg_id: 'top.real.skip', version: '1.0.0', main: 'dist/main.js' }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { outDir: 'dist' } }),
    'dist/main.js': 'module.exports = 1;\n'
});
var skipResult = lib.buildProject({ projectDir: skipProject, install: false, skipCompile: true });
ok(skipResult.ok, 'skipCompile 跳过编译后仍能构建', JSON.stringify(skipResult.errors).slice(0, 200));

// ---------------------------------------------------------------- PACKINFO

var packProject = makeProject('packinfo', {
    'manifest.json': JSON.stringify({
        schema_version: 1,
        toolpkg_id: 'top.serveryyswys.packinfo',
        version: '2.3.4',
        main: 'main.js',
        display_name: { zh: '打包信息', en: 'packinfo' },
        description: { zh: '验证 PACKINFO 生成', en: 'check' },
        author: ['甲', '乙'],
        license: 'Apache-2.0',
        packinfo: { enable: true }
    }),
    'main.js': "require('path');\nrequire('ms');\n",
    'node_modules/ms/package.json': JSON.stringify({ name: 'ms', version: '2.1.3', main: 'index.js' }),
    'node_modules/ms/index.js': 'module.exports = 1;\n'
});
var packResult = lib.buildProject({ projectDir: packProject, install: false });
ok(packResult.ok, 'PACKINFO 工程构建成功', JSON.stringify(packResult.errors).slice(0, 300));
var packZip = lib.readZip(fs.readFileSync(packResult.toolpkgPath));
var packEntry = packZip.filter(function (e) { return e.path === 'PACKINFO'; })[0];
ok(packEntry !== undefined, 'PACKINFO 写在归档根');
if (packEntry !== undefined) {
    var packText = packEntry.content.toString('utf8');
    var packLines = packText.split('\n');
    equal(packLines[0], 'name: 打包信息', 'PACKINFO 第一行是 name');
    equal(packLines[1], 'description: 验证 PACKINFO 生成', 'PACKINFO 第二行是 description');
    equal(packLines[2], 'id: top.serveryyswys.packinfo', 'PACKINFO 第三行是 id');
    equal(packLines[3], 'version: 2.3.4', 'PACKINFO 第四行是 version');
    equal(packLines[4], 'author: "甲, 乙"', 'PACKINFO 第五行是 author（数组用逗号连接，含逗号按 YAML 规则加引号）');
    equal(packLines[5], 'license: Apache-2.0', 'PACKINFO 第六行是 license');
    ok(packText.indexOf('dependencies:') >= 0, 'PACKINFO 有 dependencies');
    ok(packText.indexOf('  - ms') >= 0, 'dependencies 含 ms');
    ok(packText.indexOf('  - "@serveryyswys/node.operit"') >= 0, 'dependencies 含 node.operit（@ 触发 YAML 引号）');
    ok(packText.indexOf('extra_files') < 0, 'PACKINFO 不写 extra_files');
}

// 未 enable 时不得生成
var noPackProject = makeProject('packinfooff', {
    'manifest.json': JSON.stringify({ toolpkg_id: 'top.real.nopack', version: '1.0.0', main: 'main.js', packinfo: { enable: false } }),
    'main.js': 'module.exports = 1;\n'
});
var noPackResult = lib.buildProject({ projectDir: noPackProject, install: false });
ok(noPackResult.ok, '关掉 PACKINFO 也能构建');
var noPackNames = lib.readZip(fs.readFileSync(noPackResult.toolpkgPath)).map(function (e) { return e.path; });
ok(noPackNames.indexOf('PACKINFO') < 0, 'enable 不为 true 时不生成 PACKINFO');

// ---------------------------------------------------------------- 动态 require

// 打包器改不了动态 require，而运行时对裸名静默返回 {} —— 依赖会在业务里失效。
// 所以必须构建立刻失败，不能默认放过。
var dynamicProject = makeProject('dynamicreq', {
    'manifest.json': JSON.stringify({ toolpkg_id: 'com.real.dynamicreq', version: '1.0.0', main: 'main.js' }),
    'main.js': "var name = 'fs';\nrequire(name);\n"
});
var dynamicResult = lib.buildProject({ projectDir: dynamicProject, install: false });
ok(!dynamicResult.ok, '变量形式的 require 让构建失败');
ok(dynamicResult.errors.join(' ').indexOf('无法静态分析') >= 0, '报错指明是动态 require', dynamicResult.errors.join(' ').slice(0, 200));

// 拼接不能被截断成 'f' —— 截断比忽略更糟
var concatProject = makeProject('concatreq', {
    'manifest.json': JSON.stringify({ toolpkg_id: 'com.real.concatreq', version: '1.0.0', main: 'main.js' }),
    'main.js': "require('f' + 's');\n"
});
var concatResult = lib.buildProject({ projectDir: concatProject, install: false });
ok(!concatResult.ok, "require('f' + 's') 被判为动态（而不是截断成 f 去重写）");
ok(concatResult.errors.join(' ').indexOf('无法静态分析') >= 0, '拼接形式的报错正确');

// 模板串同样拦下
var tplProject = makeProject('tplreq', {
    'manifest.json': JSON.stringify({ toolpkg_id: 'com.real.tplreq', version: '1.0.0', main: 'main.js' }),
    'main.js': "var n = 'x';\nrequire('./lib/' + n + '.js');\n"
});
var tplResult = lib.buildProject({ projectDir: tplProject, install: false });
ok(!tplResult.ok, '模板/拼接式子路径也被拦下');

// 静态的形式必须照常放行（别过度拦截）
var staticProject = makeProject('staticreq', {
    'manifest.json': JSON.stringify({ toolpkg_id: 'com.real.staticreq', version: '1.0.0', main: 'main.js' }),
    'main.js': "require('path');\nrequire('./lib/a.js');\n",
    'lib/a.js': 'module.exports = 1;\n'
});
var staticResult = lib.buildProject({ projectDir: staticProject, install: false });
ok(staticResult.ok, '静态 require 仍然正常构建', JSON.stringify(staticResult.errors).slice(0, 200));

// ---------------------------------------------------------------- 资产保留

// resources / i18n / modules 不在 require 链里，必须原样带上；
// i18n 里的 .js 是数据不是模块，不能被"不可达 JS 裁剪"吃掉。
var assetProject = makeProject('assets', {
    'manifest.json': JSON.stringify({
        toolpkg_id: 'com.example.assets', version: '0.1.0', main: 'main.js',
        // OPM 语义：只有显式列出的才进包（目录递归展开）
        extra_files: ['resources', 'modules', 'i18n/zh-CN.js', 'i18n/en-US.js']
    }),
    'main.js': "module.exports = 1;\n",
    'resources/logo.svg': '<svg></svg>\n',
    'resources/pc_agent/agent.zip': 'PK fake',
    'i18n/zh-CN.js': "exports.hello = '你好';\n",
    'i18n/en-US.js': "exports.hello = 'hi';\n",
    'modules/core.wasm': '\0asm',
    'notes.md': '# notes\n',
    'package.json': JSON.stringify({ name: 'assets', private: true }),
    '.npmrc': 'registry=https://example.invalid/\n'
});
var assetResult = lib.buildProject({ projectDir: assetProject });
ok(assetResult.ok, '带资产的工程构建成功', JSON.stringify(assetResult.errors).slice(0, 300));
var assetNames = lib.readZip(fs.readFileSync(assetResult.toolpkgPath)).map(function (e) { return e.path; });
ok(assetNames.indexOf('resources/logo.svg') >= 0, 'resources/ 里的文件进包');
ok(assetNames.indexOf('resources/pc_agent/agent.zip') >= 0, 'resources/ 的子目录也进包');
ok(assetNames.indexOf('i18n/zh-CN.js') >= 0 && assetNames.indexOf('i18n/en-US.js') >= 0, 'i18n/*.js 作为数据整体保留（不能被可达性裁掉）');
ok(assetNames.indexOf('modules/core.wasm') >= 0, 'modules/ 里的 wasm 进包');
ok(assetNames.indexOf('notes.md') < 0, '没有声明在 extra_files 里的文件不进包');
ok(assetNames.indexOf('package.json') < 0 && assetNames.indexOf('.npmrc') < 0, '工程元数据不进包');
ok(assetNames.indexOf('i18n/en-US.js') >= 0, 'extra_files 里逐个列出的文件也进包');
ok(assetResult.assets.length >= 5, 'extra_files 展开了 ' + assetResult.assets.length + ' 个条目');
var content = lib.readZip(fs.readFileSync(assetResult.toolpkgPath)).filter(function (e) { return e.path === 'resources/logo.svg'; })[0].content.toString();
equal(content, '<svg></svg>\n', '资产内容原样未改');

// 规范目录之外的 JS 仍然按可达性裁剪
var deadProject = makeProject('deadjs', {
    'manifest.json': JSON.stringify({ toolpkg_id: 'com.example.dead', version: '0.1.0', main: 'main.js' }),
    'main.js': 'module.exports = 1;\n',
    'lib/dead.js': "require('vm');\n"
});
var deadResult = lib.buildProject({ projectDir: deadProject });
ok(deadResult.ok, '不可达的 JS 被裁掉，不牵连构建');
var deadNames = lib.readZip(fs.readFileSync(deadResult.toolpkgPath)).map(function (e) { return e.path; });
ok(deadNames.indexOf('lib/dead.js') < 0, '不可达 JS 不进包');

// ---------------------------------------------------------------- init 与依赖补齐

var initDir = path.join(TMP, 'initme');
var initResult = lib.initProject({ projectDir: initDir, install: false });
ok(initResult.ok, 'init 成功', JSON.stringify(initResult.errors));
ok(initResult.created.indexOf('package.json') >= 0, 'init 生成 package.json');
ok(initResult.created.indexOf('manifest.json') >= 0, 'init 生成 manifest.json');
ok(initResult.created.indexOf('tsconfig.json') < 0, '纯 JS 工程不生成 tsconfig.json（免得被推进 TS 模式）');

var initPkg = JSON.parse(fs.readFileSync(path.join(initDir, 'package.json'), 'utf8'));
ok(initPkg.scripts && initPkg.scripts.build === 'opm build', 'init 写入 scripts.build', JSON.stringify(initPkg.scripts));
ok(initPkg.devDependencies && initPkg.devDependencies['@serveryyswys/opm'] !== undefined, 'init 声明 opm 依赖');
ok(initPkg.devDependencies && initPkg.devDependencies['@serveryyswys/node.operit'] !== undefined, 'init 声明 node.operit 依赖');
var initManifest = JSON.parse(fs.readFileSync(path.join(initDir, 'manifest.json'), 'utf8'));
ok(typeof initManifest.toolpkg_id === 'string' && initManifest.toolpkg_id.length > 0, 'init 生成 toolpkg_id');
ok(!/\.\./.test(initManifest.toolpkg_id) && !/^[^A-Za-z0-9]/.test(initManifest.toolpkg_id.slice('com.example.'.length)),
    'toolpkg_id 不含双点、不以非字母数字开头', initManifest.toolpkg_id);
ok(initManifest.main === 'main.js', '纯 JS 工程的 manifest.main 是 main.js');

// 幂等：再跑一次不该覆盖已有值
fs.writeFileSync(path.join(initDir, 'package.json'), JSON.stringify({
    name: 'kept', private: true,
    scripts: { build: 'my-custom-build' },
    devDependencies: { '@serveryyswys/opm': '^9.9.9' }
}, null, 2));
var second = lib.initProject({ projectDir: initDir, install: false });
var afterSecond = JSON.parse(fs.readFileSync(path.join(initDir, 'package.json'), 'utf8'));
equal(afterSecond.scripts.build, 'my-custom-build', 'init 不覆盖已有的 scripts.build');
equal(afterSecond.devDependencies['@serveryyswys/opm'], '^9.9.9', 'init 不覆盖已有的依赖版本');
ok(second.created.length === 0, '第二次 init 不新建文件');

// TS 工程：要生成 tsconfig，且 main 指向 outDir
var initTs = path.join(TMP, 'initts');
fs.mkdirSync(path.join(initTs, 'src'), { recursive: true });
fs.writeFileSync(path.join(initTs, 'src', 'main.ts'), 'export const a = 1;\n');
var initTsResult = lib.initProject({ projectDir: initTs, install: false });
ok(initTsResult.created.indexOf('tsconfig.json') >= 0, 'TS 工程生成 tsconfig.json');
var initTsConfig = JSON.parse(fs.readFileSync(path.join(initTs, 'tsconfig.json'), 'utf8'));
equal(initTsConfig.compilerOptions.outDir, 'dist', 'tsconfig 的 outDir 是 dist');
var initTsManifest = JSON.parse(fs.readFileSync(path.join(initTs, 'manifest.json'), 'utf8'));
equal(initTsManifest.main, 'dist/main.js', 'TS 工程的 manifest.main 与 outDir 对齐');

// 依赖补齐
var auditOk = lib.auditDependencies(project);
equal(auditOk.missing, [], '依赖齐全时审计为空');
var auditMissing = lib.auditDependencies(initDir);
ok(auditMissing.missing.indexOf('@serveryyswys/node.operit') >= 0, '没装的包会被审计出来', JSON.stringify(auditMissing.missing));
var blockedByDeps = (function () {
    var dir = path.join(TMP, 'nodeps');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ main: 'main.js' }));
    fs.writeFileSync(path.join(dir, 'main.js'), 'module.exports = 1;\n');
    return lib.buildProject({ projectDir: dir, install: false });
})();
ok(!blockedByDeps.ok, '缺依赖且 --no-install 时构建失败');
ok(blockedByDeps.errors.join(' ').indexOf('npm install') >= 0, '失败信息告诉使用者执行 npm install', blockedByDeps.errors.join(' ').slice(0, 200));

// ---------------------------------------------------------------- verify

var verifyTarget = path.join(TMP, 'verifyok');
fs.mkdirSync(verifyTarget, { recursive: true });
fs.mkdirSync(path.join(verifyTarget, 'resources'), { recursive: true });
fs.mkdirSync(path.join(verifyTarget, 'node_modules/@serveryyswys/node.operit/dist'), { recursive: true });
fs.writeFileSync(path.join(verifyTarget, 'manifest.json'), JSON.stringify({ schema_version: 1, toolpkg_id: 'top.serveryyswys.verifyok', version: '1.0.0', main: 'main.js', extra_files: ['resources'] }));
fs.writeFileSync(path.join(verifyTarget, 'main.js'), "require('path');\nrequire('./lib/util');\n");
fs.mkdirSync(path.join(verifyTarget, 'lib'), { recursive: true });
fs.writeFileSync(path.join(verifyTarget, 'lib/util.js'), 'module.exports = 1;\n');
fs.writeFileSync(path.join(verifyTarget, 'resources/logo.svg'), '<svg></svg>\n');
fs.writeFileSync(path.join(verifyTarget, 'node_modules/@serveryyswys/node.operit/package.json'), JSON.stringify({ name: '@serveryyswys/node.operit', version: '9.9.9' }));
fs.writeFileSync(path.join(verifyTarget, 'node_modules/@serveryyswys/node.operit/BUILTINS.json'), JSON.stringify({
    package: '@serveryyswys/node.operit', distDir: 'dist', installDir: 'node_modules/@serveryyswys/node.operit',
    builtins: { path: { subpath: 'path', status: 'ready', note: 't' } }
}));
fs.writeFileSync(path.join(verifyTarget, 'node_modules/@serveryyswys/node.operit/dist/path.js'), 'module.exports = {};\n');
// 入口注入会 require 这两个，所以真包里一定有；fixture 也得有，否则是 fixture 不真实
fs.writeFileSync(path.join(verifyTarget, 'node_modules/@serveryyswys/node.operit/dist/process.js'), 'module.exports = {};\n');
fs.writeFileSync(path.join(verifyTarget, 'node_modules/@serveryyswys/node.operit/dist/buffer.js'), 'module.exports = {};\n');

var verifyReport = lib.verifyProject({ projectDir: verifyTarget, install: false });
ok(verifyReport.ok, 'verify 对健康工程通过', JSON.stringify(verifyReport.errors).slice(0, 300));
ok(!fs.existsSync(path.join(TMP, 'verifyok.toolpkg')), 'verify 不写任何产物文件');
equal(verifyReport.stats.assets, 1, 'verify 统计到 1 个资产');
equal(verifyReport.stats.nodeOperitVersion, '9.9.9', 'verify 报出 node.operit 版本');
ok(verifyReport.checks.every(function (c) { return c.ok; }), 'verify 所有检查项通过', JSON.stringify(verifyReport.checks.filter(function (c) { return !c.ok; })));

// toolpkg_id 占位必须被拦下
var placeholder = path.join(TMP, 'verifyph');
fs.mkdirSync(placeholder, { recursive: true });
fs.writeFileSync(path.join(placeholder, 'manifest.json'), JSON.stringify({ schema_version: 1, toolpkg_id: 'com.example.demo', version: '1.0.0', main: 'main.js' }));
fs.writeFileSync(path.join(placeholder, 'main.js'), 'module.exports = 1;\n');
var phReport = lib.verifyProject({ projectDir: placeholder, install: false });
ok(!phReport.ok, 'verify 拦下占位 toolpkg_id');
ok(phReport.errors.join(' ').indexOf('placeholder') >= 0 || phReport.errors.join(' ').indexOf('com.example.') >= 0, '报错指明是 toolpkg_id 占位', phReport.errors.join(' ').slice(0, 160));

// 不支持的依赖也要在 verify 阶段拦下
var vmProject = path.join(TMP, 'verifyvm');
fs.mkdirSync(path.join(vmProject, 'node_modules/@serveryyswys/node.operit/dist'), { recursive: true });
fs.writeFileSync(path.join(vmProject, 'manifest.json'), JSON.stringify({ schema_version: 1, toolpkg_id: 'com.real.vm', version: '1.0.0', main: 'main.js' }));
fs.writeFileSync(path.join(vmProject, 'main.js'), "require('vm');\n");
fs.writeFileSync(path.join(vmProject, 'node_modules/@serveryyswys/node.operit/package.json'), JSON.stringify({ name: '@serveryyswys/node.operit', version: '9.9.9' }));
fs.writeFileSync(path.join(vmProject, 'node_modules/@serveryyswys/node.operit/BUILTINS.json'), JSON.stringify({
    package: '@serveryyswys/node.operit', distDir: 'dist', installDir: 'node_modules/@serveryyswys/node.operit',
    builtins: { vm: { subpath: 'vm', status: 'unsupported', note: 'QuickJS 没有独立上下文' } }
}));
fs.writeFileSync(path.join(vmProject, 'node_modules/@serveryyswys/node.operit/dist/process.js'), 'module.exports = {};\n');
fs.writeFileSync(path.join(vmProject, 'node_modules/@serveryyswys/node.operit/dist/buffer.js'), 'module.exports = {};\n');
var vmReport = lib.verifyProject({ projectDir: vmProject, install: false });
ok(!vmReport.ok, 'verify 拦下 unsupported 依赖');
ok(vmReport.errors.join(' ').indexOf('独立上下文') >= 0, '把契约里的拒绝理由带出来', vmReport.errors.join(' ').slice(0, 200));

// ---------------------------------------------------------------- version

var report = lib.describeVersions(project, '9.9.9');
ok(report.lines[0].indexOf('9.9.9') >= 0, 'version 报告含自身版本');
ok(report.lines.some(function (l) { return l.indexOf('com.example.demo') >= 0; }), 'version 报告含 toolpkg 信息');
var noProject = lib.describeVersions(undefined, '9.9.9');
equal(noProject.errors, [], 'version 不传目录时不报错');

// ---------------------------------------------------------------- 汇总

fs.rmSync(TMP, { recursive: true, force: true });

console.log('');
if (failures.length > 0) {
    console.log('失败样例:');
    failures.slice(0, 12).forEach(function (failure) {
        console.log('  - ' + failure.label + (failure.detail ? '\n      ' + failure.detail : ''));
    });
    console.log('');
}
console.log('passed: ' + passed + ', failed: ' + failed);
process.exitCode = failed === 0 ? 0 : 1;
