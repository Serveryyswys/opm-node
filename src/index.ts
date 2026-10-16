'use strict';

/**
 * 库入口：给想在 Node 里直接调用（不走命令行）的场景。
 */

export { buildProject } from './lib/build';
export type { BuildOptions, BuildResult } from './lib/build';
export { describeVersions } from './lib/version';
export { initProject, OPM_PACKAGE } from './lib/init';
export type { InitOptions, InitResult } from './lib/init';
export { auditDependencies, installDependencies } from './lib/dependencies';
export type { DependencyAudit } from './lib/dependencies';
export type { VersionReport } from './lib/version';
export { createZip, readZip } from './lib/zip';
export type { ZipEntry } from './lib/zip';
export { findRequires } from './lib/js-requires';
export type { RequireSite } from './lib/js-requires';
export { findNodeOperitDir, loadContract, NODE_OPERIT_DIR, NODE_OPERIT_PACKAGE, RUNTIME_BUILTINS } from './lib/contract';
export type { Contract, BuiltinEntry, BuiltinStatus } from './lib/contract';
export { rewriteModule, resolveRelative } from './lib/rewrite';
export type { Diagnostic, RewriteEnv, RewriteOutcome } from './lib/rewrite';
