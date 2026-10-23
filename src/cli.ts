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

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runBuild } from './commands/build';
import { simulateRegistration, simulateSubpackageMeta } from './commands/simulate';
import { auditDependencies, installDependencies } from './lib/dependencies';
import { describeVersions } from './lib/version';
import { initProject } from './lib/init';

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
        '      TS 工程补 tsconfig.json；默认装依赖。',
        '',
        '  opm build [项目目录] [--out <名字>] [--out-dir <目录>] [--skip-compile] [--dry-run] [--no-install]',
        '      计算可达性、重写裸名、拦截不支持的依赖，压成 .toolpkg',
        '      产物放在项目目录的上一级，名为 <项目目录名>.toolpkg',
        '',
        '  opm verify [项目目录] [--skip-compile] [--no-install]',
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

function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return bytes + ' B';
    }
    if (bytes < 1024 * 1024) {
        return (bytes / 1024).toFixed(1) + ' KB';
    }
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function readBuildConfig(projectDir: string): Record<string, unknown> | null {
    const configPath = resolve(projectDir, 'manifest.opmbuild.json');
    if (!existsSync(configPath)) {
        return {};
    }
    try {
        const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
        return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

async function main(argv: string[]): Promise<number> {
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
        if (flags.has('verbose')) {
            for (const note of result.notes) {
                console.log('  · ' + note);
            }
        }
        if (!result.ok) {
            console.error('');
            console.error('init 未能完成：');
            for (const error of result.errors) {
                console.error('  ✗ ' + error);
            }
            return 1;
        }
        if (result.nextSteps.length > 0) {
            console.log('');
            for (const step of result.nextSteps) {
                console.log('  ' + step);
            }
        }
        return 0;
    }

    if (command === 'build') {
        const projectDir = resolve(positional[0] === undefined ? process.cwd() : positional[0]);

        // 依赖补齐是 opm-node 在 OPM 之外加的一步：OPM 不装依赖，直接 fail。
        // 保留它，但只作为前置步骤，构建本身完全走 OPM 的 runBuild。
        const audit = auditDependencies(projectDir);
        if (audit.missing.length > 0) {
            if (flags.has('no-install')) {
                for (const name of audit.missing) {
                    console.error('✗ 缺少依赖：' + name);
                }
                return 1;
            }
            const installed = installDependencies(projectDir);
            if (!installed.ok) {
                console.error('✗ npm install 失败');
                return 1;
            }
        }

        const config = readBuildConfig(projectDir);
        if (config === null) {
            console.error('✗ manifest.opmbuild.json 不是合法 JSON');
            return 1;
        }

        const report = await runBuild({
            projectDir,
            skipCompile: flags.has('skip-compile') || config.skip_compile === true,
            outName: flags.get('out') !== undefined ? flags.get('out') : (typeof config.out_name === 'string' ? config.out_name : undefined),
            outDir: flags.get('out-dir') !== undefined ? flags.get('out-dir') : (typeof config.out_dir === 'string' ? config.out_dir : undefined),
            extraFiles: Array.isArray(config.extra_files) ? config.extra_files as string[] : [],
            packinfo: (config.PACKINFO !== undefined ? config.PACKINFO : config.packinfo) as never
        });

        if (!report.ok) {
            console.error('✗ ' + report.message);
            return 1;
        }
        console.log('✓ ' + report.toolpkgPath + '  (' + report.fileCount + ' 个文件)');
        return 0;
    }

    if (command === 'verify') {
        const projectDir = resolve(positional[0] === undefined ? process.cwd() : positional[0]);
        const config = readBuildConfig(projectDir);
        if (config === null) {
            console.error('✗ manifest.opmbuild.json 不是合法 JSON');
            return 1;
        }
        // verify = build 的前半段：走完全部检查与收集，不落盘。
        const report = await runBuild({
            projectDir,
            dryRun: true,
            skipCompile: flags.has('skip-compile') || config.skip_compile === true,
            outName: flags.get('out') !== undefined ? flags.get('out') : (typeof config.out_name === 'string' ? config.out_name : undefined),
            outDir: flags.get('out-dir') !== undefined ? flags.get('out-dir') : (typeof config.out_dir === 'string' ? config.out_dir : undefined),
            extraFiles: Array.isArray(config.extra_files) ? config.extra_files as string[] : [],
            packinfo: (config.PACKINFO !== undefined ? config.PACKINFO : config.packinfo) as never
        });
        if (!report.ok) {
            console.error('✗ ' + report.message);
            if (report.violations) {
                for (const item of report.violations) {
                    console.error('  ' + item.from + ' -> ' + item.name + '：' + item.reason);
                }
            }
            if (report.missing) {
                for (const item of report.missing) {
                    console.error('  ' + (item.from || '') + ' -> ' + item.name + '：' + item.reason);
                }
            }
            return 1;
        }
        // 模拟加载：复刻 Operit 加载期的静态检查（不执行脚本、不落盘）。
        // 依据 PackageManager.extractMetadataFromJs / ToolPkgMainRegistrationScriptParser。
        const manifestPath = join(projectDir, 'manifest.json');
        if (existsSync(manifestPath)) {
            let manifest: Record<string, unknown> = {};
            try {
                manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
            } catch {
                console.error('✗ manifest.json 解析失败');
                return 1;
            }
            const mainRel = typeof manifest.main === 'string' && manifest.main !== '' ? manifest.main : 'main.js';
            const mainPath = join(projectDir, mainRel);
            if (existsSync(mainPath)) {
                const reg = simulateRegistration(readFileSync(mainPath, 'utf8'));
                if (!reg.hasRegisterFn) {
                    console.log('! ' + mainRel + ' 未检出 registerToolPkg 定义（静态检查，可能是动态写法）');
                }
                for (const issue of reg.issues) {
                    console.log('! ' + mainRel + '：' + issue);
                }
            }
            const subs = Array.isArray(manifest.subpackages) ? manifest.subpackages : [];
            for (const sub of subs) {
                const entry = sub !== null && typeof sub === 'object' && typeof (sub as Record<string, unknown>).entry === 'string'
                    ? String((sub as Record<string, unknown>).entry) : '';
                if (entry === '') {
                    continue;
                }
                const entryPath = join(projectDir, entry);
                if (!existsSync(entryPath)) {
                    console.error('✗ 子包入口不存在：' + entry);
                    return 1;
                }
                const meta = simulateSubpackageMeta(entry, readFileSync(entryPath, 'utf8'));
                if (!meta.hasMeta) {
                    console.log('! ' + entry + ' 没有 METADATA 块');
                } else if (!meta.parsed) {
                    console.error('✗ ' + entry + ' 的 METADATA 解析失败');
                    return 1;
                }
                for (const issue of meta.issues) {
                    console.log('! ' + entry + '：' + issue.tool + ' — ' + issue.reason);
                }
            }
        }
        console.log('✓ ' + report.message);
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

main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
}).catch((error) => {
    console.error('✗ ' + (error && error.message ? error.message : String(error)));
    process.exitCode = 1;
});
