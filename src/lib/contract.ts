'use strict';

/**
 * BUILTINS.json 契约表 —— 重写规则的唯一真源。
 *
 * 表在 node.operit 包里（node_modules/@serveryyswys/node.operit/BUILTINS.json），
 * 不是本包自带的副本：那份副本一定会过期，而过期的契约会把构建带偏。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const NODE_OPERIT_PACKAGE = '@serveryyswys/node.operit';
export const NODE_OPERIT_DIR = 'node_modules/@serveryyswys/node.operit';

/** 运行时已内建、重写时必须保持原样的裸名。 */
export const RUNTIME_BUILTINS = ['lodash', 'uuid', 'axios'];

export type BuiltinStatus = 'ready' | 'partial' | 'planned' | 'unsupported';

export interface BuiltinEntry {
    subpath: string;
    status: BuiltinStatus;
    note?: string;
}

export interface Contract {
    package: string;
    distDir: string;
    subpathTemplate: string;
    installDir: string;
    builtins: Record<string, BuiltinEntry>;
}

export class ContractError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ContractError';
    }
}

/** 找到项目里安装的 node.operit 包目录；找不到就给出可操作的提示。 */
export function findNodeOperitDir(projectDir: string): string {
    const candidates = [
        join(projectDir, NODE_OPERIT_DIR),
        // pnpm / 提升安装时可能落在更上层
        join(projectDir, '..', NODE_OPERIT_DIR)
    ];
    for (const candidate of candidates) {
        if (existsSync(join(candidate, 'BUILTINS.json'))) {
            return candidate;
        }
    }
    throw new ContractError(
        '找不到 ' + NODE_OPERIT_PACKAGE + '（在 ' + projectDir + ' 下找过 ' + NODE_OPERIT_DIR + '）。\n' +
        '它是重写规则的来源，必须先安装：npm install -D ' + NODE_OPERIT_PACKAGE
    );
}

export function loadContract(nodeOperitDir: string): Contract {
    const contractPath = join(nodeOperitDir, 'BUILTINS.json');
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(contractPath, 'utf8'));
    } catch (error) {
        throw new ContractError('读取契约表失败：' + contractPath + '\n' + String(error));
    }
    const record = raw as Partial<Contract> & { builtins?: Record<string, BuiltinEntry> };
    if (record.builtins === undefined || typeof record.builtins !== 'object') {
        throw new ContractError('契约表缺少 builtins 段：' + contractPath);
    }
    return {
        package: record.package === undefined ? NODE_OPERIT_PACKAGE : record.package,
        distDir: record.distDir === undefined ? 'dist' : record.distDir,
        subpathTemplate: record.subpathTemplate === undefined ? '<distDir>/<subpath>.js' : record.subpathTemplate,
        installDir: record.installDir === undefined ? NODE_OPERIT_DIR : record.installDir,
        builtins: record.builtins
    };
}
