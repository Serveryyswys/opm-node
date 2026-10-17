# @serveryyswys/opm

把 Operit 插件工程打成 `.toolpkg` 的构建器。**脱离 Operit 生态** —— 在普通的 Node 环境、
普通的编辑器里就能用，不依赖 Operit 运行时，也不依赖 AI 编程环境。

## 安装

```bash
npm i -D @serveryyswys/opm @serveryyswys/node.operit
```

两个都要装：`opm` 是构建器本身，`node.operit` 提供 `BUILTINS.json` 契约表 ——
重写规则的**唯一真源**，opm 不自带副本（副本一定会过期，而过期的契约会把构建带偏）。

## 用法

### 先把工程准备起来（可选，但推荐）

```bash
opm init                      # 在当前目录
opm init ./my-plugin          # 或指定目录
opm init --no-install         # 只写文件，不跑 npm install
```

它只管三件最容易写错的事：

1. `package.json` 补上 `scripts.build = "opm build"`，以及 `@serveryyswys/opm` /
   `@serveryyswys/node.operit` 两个 devDependency（**不覆盖**已有值）；
2. 没有 `manifest.json` 就生成一个骨架（toolpkg 的身份靠它；`toolpkg_id` 记得改成你自己的）；
3. 工程里有 `.ts` 才补 `tsconfig.json`，且 `outDir` 与 `manifest.main` 对齐。

默认会跑一次 `npm install`。**不指定 registry** —— 包从哪个源来，由你自己的 npm 配置决定
（用私有源的团队，装的就是私有源里的 `node.operit`）。

### 然后构建

两种完全等价：

```bash
opm build                      # 直接调
```

```json
// 工程的 package.json
"scripts": { "build": "opm build" }
```

```bash
npm run build                  # npm 会把 node_modules/.bin/opm 放进 PATH
```

其他命令：

```bash
opm build [项目目录] --out <名字> --dry-run [--no-install]
opm verify [项目目录] [--no-install]          # 出包前干跑校验，**不写任何文件**
opm version [项目目录]                        # 列版本：opm / 工程 / node.operit / toolpkg
opm help
```

`verify` 与 `build` 跑同一条流水线，区别是**完全不落盘**，所以适合放进 CI 当门禁。
它检查：manifest 字段（含 toolpkg_id 是否还是 `com.example.` 占位）、子包入口、
依赖与裸名归宿、资产齐全度，并给出归档文件数／体积／引入的包／node.operit 版本。

项目目录默认为当前目录。产物放在**项目目录的上一级**，名为 `<项目目录名>.toolpkg`。

## 它做什么

0. **补齐依赖**：`dependencies` 里声明了却没装的包，以及 `node.operit` 本身，先跑一次
   `npm install`（同样不指定 registry）。缺依赖硬做的结果是一句"解析不到"，
   对使用者没有指导性。要跳过自动安装用 `--no-install`（它会明确告诉你缺什么）。
1. 读 `manifest.json`，取可达种子：`main` + 每个 `subpackages[].entry`
2. 顺 `require` 链递归收集被引用的文件（**可达性裁剪** —— 只有真被引用到的才进包）
3. **裸名重写**为归档内的显式 `.js` 相对路径
4. **契约拦截**：`planned` / `unsupported` 的依赖直接让构建失败，不把问题带到运行期
5. 入口注入 `process` / `Buffer` 全局（Operit 沙盒没有这两个全局）
6. 压成 zip，写 `.toolpkg`

### 哪些文件会进包

规则照 OPM，**只有三类**：

| 类别 | 处理 |
| --- | --- |
| `manifest.json` | 原样 |
| `main` / `subpackages[].entry` / UI 模块 | 读入、重写裸名、顺 require 链递归收集 |
| `manifest.extra_files` 里列出的路径 | 文件直接收；目录**递归**收（跳过 `node_modules` 与点目录，深度上限 10） |

**不在 require 闭包里、也没写进 `extra_files` 的文件一律不进包。** 这包括工程里的
杂项（草稿、截图、临时配置）—— 归档内容因此是可解释的：闭包 + 入口 + 显式声明。

> 为什么改：早先这里是"非 JS 一律原样带上"，会把杂项一起打进包，包体不可控
> 也无法解释。对齐 OPM 的 `extra_files` 之后，"打了什么"完全由声明决定。

### PACKINFO（可选）

在 manifest 里写：

```json
"packinfo": { "enable": true }
```

就会在归档根生成一个无扩展名的 `PACKINFO`（YAML），供市场审核核对：

```yaml
name: 打包信息
description: 一句话说明
id: top.serveryyswys.yourpkg
version: 1.0.0
author: "甲, 乙"
license: Apache-2.0
dependencies:
  - "@serveryyswys/node.operit"
  - ms
```

- 字段顺序固定 `name → description → id → version → author → license → dependencies`，
  有才写、缺则跳过；
- `dependencies` 从**归档里实际收进的** `node_modules/<pkg>/...` 反推，
  所以因内建重写带进来的 `node.operit` 也会如实列出；
- `enable` 不为 `true` 时不生成该文件；
- 含 `@` / `,` / `:` 等字符的值会按 YAML 规则加双引号。

### 裸名重写的三条规则

| 请求 | 重写为 |
| --- | --- |
| `lodash` / `uuid` / `axios` | **保持原样**（运行时已内建） |
| Node 内建（`path`、`fs`…） | `<rel>/node_modules/@serveryyswys/node.operit/dist/<subpath>.js` |
| 第三方 npm 包 | 该包入口文件（解析 `main` / `exports`），归档内相对路径 |

**为什么必须显式带 `.js`**：Operit 运行时的 `buildCandidatePaths` 对命中 `/\.[a-z0-9]+$/i` 的名字
只试一个候选、不补扩展名。包名里的 `.operit` 正好命中那个正则，所以 `.../node.operit` 会被当成
完整路径而解析失败 —— 必须写成 `.../node.operit/dist/index.js`。

## 归档结构

`.toolpkg` 就是 zip，**文件直接放在归档根**（没有顶层目录），路径完全照 `manifest.json` 里写的来：

```
manifest.json
main.js
ui/xxx/index.ui.js
packages/*.js
node_modules/<被引用到的包>/**/*.js
node_modules/@serveryyswys/node.operit/dist/**/*.js
```

## 与 Operit 内那个 OPM 的关系

Operit 生态里也有一个 OPM（`com.operit.serveryyswys.opm`，ToolPkg 形态），提供
init / search / install / remove / manager / build / verify 七个工具。

本包是其中 **`build` / `version` 的"脱离 Operit"版本**：同样一条流水线、
同样读 `node.operit` 的契约表，但宿主是普通 Node（`fs` / `child_process`），
没有 `Tools.*` 依赖，因此可以在传统开发环境里跑。

## 许可

Apache-2.0。见 `LICENSE` 与 `NOTICE`。
