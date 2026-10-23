'use strict';

/**
 * 移植自 OPM 的 src/build/globalshadow.ts，但只保留**接口**。
 *
 * OPM 在这一步镜像全局 npm 目录，作为依赖查找的兜底（Android 上没有正常的
 * node_modules 解析）。opm-node 跑在 Node 上，模块解析由 Node 自己负责，
 * 所以这里不需要镜像 —— 两个函数都退化为空操作，其余逻辑（build.ts）不变。
 */

export interface ShadowResult {
    shadowRoot: string | null;
    count: number;
    dir: string;
    message: string;
}

export function shadowDirOf(_projectDir: string): string {
    return '';
}

export async function prepareGlobalShadow(_projectDir: string): Promise<ShadowResult> {
    return { shadowRoot: null, count: 0, dir: '', message: '依赖来源：本地' };
}

export async function cleanupGlobalShadow(_projectDir: string): Promise<void> {
    // 无镜像可清
}
