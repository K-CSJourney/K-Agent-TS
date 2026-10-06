// 临时验证脚本：跑完即删
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHeadlessTui, execPluginCommand, listPluginCommands, loadPlugins, runPluginStart } from "../src/plugin";
import { connectMcpServers, mcpStatuses } from "../src/mcp";
import { execTool } from "../src/tools";
import { setupPermissions } from "../src/permissions";

// 备份权限配置（插件/MCP 策略写入会改它）
const cfgPath = ".kagent/KAgent.json";
const cfgBackup = await readFile(cfgPath, "utf8");
setupPermissions(
    { root: process.cwd(), tools: { get_current_time: "allow", rag_search: "allow" } },
    async () => true,
);

// 1. 插件加载 + 工具策略补齐
await loadPlugins();
const failed = await runPluginStart({
    tui: createHeadlessTui(),
    mode: "tui",
    reply: async () => {},
    handleCommand: async () => {},
});
console.log("1a. 启动失败插件:", failed.length === 0 ? "无" : failed.join(","));
console.log("1b. 插件命令:", listPluginCommands().map((c) => c.name).join(",") || "（无）");
const r = await execTool("echo_repeat", JSON.stringify({ text: "hi", times: 2 }));
console.log("1c. echo_repeat 不再被默认 deny:", !r.includes("权限拒绝"), "→", r.slice(0, 50));
await new Promise((r2) => setTimeout(r2, 300)); // 等 fire-and-forget 的策略写盘
console.log("1d. echo_repeat 策略已落盘:", (await readFile(cfgPath, "utf8")).includes("echo_repeat"));

// 2. MCP 旧路径兜底 + 失败不抛错 + 状态隔离
await mkdir(".geekagent", { recursive: true });
await writeFile(
    ".geekagent/mcp.json",
    JSON.stringify({ mcpServers: { broken: { command: "definitely-not-a-real-cmd-xyz" } } }),
    "utf8",
);
await connectMcpServers(); // 不应抛错
const st = mcpStatuses();
console.log("2a. 旧路径读取+失败隔离:", st.length === 1 ? `${st[0].server}(启动失败)` : JSON.stringify(st));
await rm(".geekagent", { recursive: true, force: true });

// 3. 插件命令执行
const out = await execPluginCommand(listPluginCommands()[0]?.name ?? "", "hello");
console.log("3. 插件命令输出:", String(out).slice(0, 40));

// 恢复权限配置
await writeFile(cfgPath, cfgBackup);
console.log("cleaned");
