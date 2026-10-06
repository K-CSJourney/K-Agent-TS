/**
 * 插件 SDK —— 插件可调用的接口全在此处导出。
 * 插件只需 `import { … } from '../../plugin-sdk.js'`，无需关心内部模块路径。
 */
export type { Plugin, PluginContext } from "./plugin";
export type { Tool } from "./tools.js";
