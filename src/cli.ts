#!/usr/bin/env node
'use strict';

/**
 * opm 命令行入口。
 *
 * 两种用法等价：
 *   opm build            —— 直接调
 *   npm run build        —— 工程的 package.json 里写 "build": "opm build"
 *                           （npm 会把 node_modules/.bin/opm 放进 PATH）
 *
 * 失败一律走 process.exitCode，不调 process.exit()：后者会和 stdout 刷新竞态，
 * 把最后的报错截掉（node.operit 上踩过这个坑）。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildProject } from './lib/build';
import { describeVersions } from './lib/version';
import { initProject } from './lib/init';
import { verifyProject } from './lib/verify';

function ownVersion(): string {
    try {
        const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version?: unknown };
        return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
    } catch {
        return '0.0.0';
    }
}

function usage(): string {
    return [
        '@serveryyswys/opm ' + ownVersion() + ' —— 把 Operit 插件工程打成 .toolpkg',
        '',
        '用法：',
        '  opm init [项目目录] [--no-install] [--overwrite]',
        '      把工程准备到能 build：补 scripts.build 与依赖声明、生成 manifest.json 骨架、',
        '      TS 工程补 tsconfig.json。默认跑一次 npm install（不指定 registry，走你自己的 npm 源）。',
        '',
        '  opm build [项目目录] [--out <名字>] [--dry-run] [--no-install]',
        '      计算可达性、重写裸名、拦截不支持的依赖，压成 .toolpkg',
        '      产物放在项目目录的上一级，名为 <项目目录名>.toolpkg',
        '',
        '  opm verify [项目目录] [--no-install]',
        '      出包前干跑校验：manifest 字段、入口、依赖、裸名归宿、资产齐全度、统计。',
        '      **完全不写文件**，所以可以在 CI 里当门禁用。',
        '',
        '  opm version [项目目录]',
        '      列出版本：opm 自身、目标工程、node.operit、toolpkg manifest',
        '',
        '  opm help | --version',
        '',
        '项目目录默认为当前目录。构建需要项目里已安装 @serveryyswys/node.operit —— ',
        '它的 BUILTINS.json 是重写规则的唯一真源。'
    ].join('\n');
}

function parseArgs(argv: string[]): { positional: string[]; flags: Map<string, string> } {
    const positional: string[] = [];
    const flags = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg.startsWith('--')) {
            const name = arg.slice(2);
            const next = argv[index + 1];
            if (next !== undefined && !next.startsWith('--')) {
                flags.set(name, next);
                index += 1;
            } else {
                flags.set(name, 'true');
            }
        } else {
            positional.push(arg);
        }
    }
    return { positional, flags };
}

function main(argv: string[]): number {
    const command = argv[0];
    const { positional, flags } = parseArgs(argv.slice(1));

    if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
        console.log(usage());
        return 0;
    }
    if (command === '--version' || command === '-v') {
        console.log(ownVersion());
        return 0;
    }

    if (command === 'init') {
        const projectDir = resolve(positional[0] === undefined ? process.cwd() : positional[0]);
        const result = initProject({
            projectDir,
            install: !flags.has('no-install'),
            overwrite: flags.has('overwrite')
        });

        for (const item of result.created) {
            console.log('  + ' + item);
        }
        for (const item of result.updated) {
            console.log('  ~ ' + item);
        }
        for (const item of result.unchanged) {
            console.log('  = ' + item + '（已存在，未改动）');
        }
        for (const note of result.notes) {
            console.log('  · ' + note);
        }
        if (!result.ok) {
            console.error('');
            console.error('init 未能完成：');
            for (const error of result.errors) {
                console.error('  ✗ ' + error);
            }
            return 1;
        }
        console.log('');
        console.log('下一步：');
        for (const step of result.nextSteps) {
            console.log('  ' + step);
        }
        return 0;
    }

    if (command === 'build') {
        const projectDir = resolve(positional[0] === undefined ? process.cwd() : positional[0]);
        const result = buildProject({
            projectDir,
            outName: flags.get('out'),
            dryRun: flags.has('dry-run'),
            install: !flags.has('no-install')
        });

        for (const note of result.notes) {
            console.log('  · ' + note);
        }
        if (result.diagnostics.length > 0) {
            const byKind = new Map<string, number>();
            for (const item of result.diagnostics) {
                byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
            }
            const summary = Array.from(byKind.entries()).map(([kind, count]) => kind + ' ' + count).join(' / ');
            console.log('  重写 ' + result.diagnostics.length + ' 处（' + summary + '）');
        }
        if (!result.ok) {
            console.error('');
            console.error('构建失败（' + result.errors.length + ' 个问题）：');
            for (const error of result.errors) {
                console.error('  ✗ ' + error);
            }
            return 1;
        }
        console.log('');
        console.log('✓ 已打包 ' + result.fileCount + ' 个文件');
        console.log('  ' + result.toolpkgPath);
        return 0;
    }

    if (command === 'verify') {
        const projectDir = resolve(positional[0] === undefined ? process.cwd() : positional[0]);
        const report = verifyProject({ projectDir, install: !flags.has('no-install') });

        console.log('检查项：');
        for (const check of report.checks) {
            console.log('  ' + (check.ok ? '✓' : '✗') + ' ' + check.name + ' —— ' + check.detail);
        }
        const stats = report.stats;
        console.log('');
        console.log('统计：');
        console.log('  归档文件   ' + stats.archiveFiles + ' 个（其中资产 ' + stats.assets + ' 个），共 ' + stats.totalBytes + ' 字节');
        console.log('  重写      内建 ' + stats.builtin + ' / npm 包 ' + stats.package + ' / 相对 ' + stats.relative + ' / 保持原样 ' + stats.untouched);
        console.log('  引入的包  ' + (stats.packages.length === 0 ? '（无）' : stats.packages.join(', ')));
        console.log('  node.operit ' + stats.nodeOperitVersion);
        for (const note of report.notes) {
            console.log('  · ' + note);
        }
        for (const warning of report.warnings) {
            console.log('  ! ' + warning);
        }
        if (!report.ok) {
            console.error('');
            console.error('校验未通过（' + report.errors.length + ' 个问题）：');
            for (const error of report.errors) {
                console.error('  ✗ ' + error);
            }
            return 1;
        }
        console.log('');
        console.log('✓ 校验通过（未写任何文件）');
        return 0;
    }

    if (command === 'version') {
        const report = describeVersions(positional[0], ownVersion());
        for (const line of report.lines) {
            console.log(line);
        }
        for (const error of report.errors) {
            console.error('  ! ' + error);
        }
        return report.errors.length > 0 ? 1 : 0;
    }

    console.error('未知命令：' + command);
    console.error('');
    console.error(usage());
    return 1;
}

process.exitCode = main(process.argv.slice(2));
