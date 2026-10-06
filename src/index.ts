import { visibleWidth } from "@earendil-works/pi-tui";
import { Chat } from "./chat";
import { loadConfig } from "./config";
import { loadPermissions, permissionRoot, setupPermissions } from "./permissions";
import { Sessions } from "./sessions";
import { loadSessions, saveSessions } from "./storage";
import { setConfirmFn } from "./tools";
import { estimateTokens, TUI } from "./tui";
import { basename } from "path";
import { undo } from "./undo";
import { formatTodos, setupPlanning } from "./todos";
import { listMemories, loadMemory, memoryBlocks, recallMemory, setupMemory } from "./memory";
import { loadInstructions } from "./instructions";
import { activeSkill, listSkills, loadSkills, unuseSkill, useSkill } from "./skills";
import { addToRag, loadRag, ragStats, setupRag } from "./rag";
import { connectMcpServers, mcpStatuses, stopMcpServers } from "./mcp";
import {
    createHeadlessTui,
    execPluginCommand,
    listPluginCommands,
    listPlugins,
    loadPlugins,
    PluginBaseContext,
    runPluginExit,
    runPluginStart,
} from "./plugin";

// 模型上下文窗口（tokens）
const CONTEXT_WINDOW = 64000;
/** 面板内容宽 26 列；「根目录  」占 8 列，剩余 18 列优先留给最后一级目录。 */
const ROOT_DISPLAY_WIDTH = 18;

const mode = process.argv[2] ?? "tui";
if (mode !== "tui" && mode !== "web") {
    console.error(`未知启动模式：${mode}（可选：web）`);
    process.exit(1);
}
const webMode = mode === "web";

if (!webMode && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    console.error("Day 11 的 TUI 需要真实终端（TTY）；管道 / 重定向下请运行 day6。");
    process.exit(1);
}

const config = loadConfig();
let permissions;
try {
    permissions = await loadPermissions();
} catch (e) {
    console.error(`.kagent/KAgent.json 读取失败：${(e as Error).message}`);
    process.exit(1);
}
let instructions = "";
// 记忆与项目指令都是可选的便利数据：单个文件损坏只降级为空并告警，不阻断启动
try {
    await loadMemory();
} catch (e) {
    console.error(`长期记忆加载失败（按空记忆继续）：${(e as Error).message}`);
}
try {
    instructions = await loadInstructions(permissions.root);
} catch (e) {
    console.error(`项目指令（AGENTS.md）加载失败（忽略）：${(e as Error).message}`);
}
try {
    await loadRag();
} catch (e) {
    console.error(`知识库读取失败（按空知识库继续）：${(e as Error).message}`);
}
try {
    await connectMcpServers();
} catch (e) {
    console.error(`MCP 配置读取失败（跳过 MCP，继续启动）：${(e as Error).message}`);
}
const chat = new Chat(config.baseURL, config.apiKey, config.model, instructions);
const sessions = new Sessions();
await loadSkills();

/** 用量状态：live 是流式进行中按字符估算的增量；正式总数以接口 usage 为准。 */
const usage = { cum: 0, round: 0, live: 0 };

let busy = false;

// 服务模式没有真实终端：tui 直接用 headless 顶替——确认自动放行（ask 工具不会挂在
// 永不出现的终端上），输出落到控制台；web 插件对 ctx.tui.append 的劫持也因此与
// reply/handleCommand 写的是同一个对象，SSE 桥接照常工作
const tui = (webMode ? createHeadlessTui() : new TUI(onLine, onExit)) as TUI;
setupPlanning((task) => chat.delegate(task), updatePanel);
setupMemory(updatePanel);
setupRag(updatePanel);
setupPermissions(permissions, (prompt) => tui.confirm(prompt));
setConfirmFn((prompt) => tui.confirm(prompt));
chat.setUsageListener((u) => {
    usage.live = 0;
    usage.cum += u.total;
    usage.round += u.total;
    updatePanel();
});
await loadPlugins();
/** 插件钩子的运行时上下文：输出、运行模式和对话入口。 */
const pluginCtx: PluginBaseContext = { tui, mode, reply, handleCommand };
const failedPlugins = await runPluginStart(pluginCtx);
if (webMode && failedPlugins.includes("web")) process.exit(1);

/** 描述当前 MCP 接入情况：每个 server 的工具数或失败原因。 */
function mcpLine(): string {
    const statuses = mcpStatuses();
    if (statuses.length === 0) return "无";
    return statuses.map((s) => (s.error ? `${s.server}(启动失败)` : `${s.server}(${s.tools.length})`)).join("、");
}

// 右侧面板：模型、会话、上下文占用与本轮/累计 tokens
function buildPanel(): string[] {
    const window = CONTEXT_WINDOW;
    const ctx = estimateTokens(JSON.stringify(chat.exportHistory()));
    const root = permissionRoot();
    const shownRoot = visibleWidth(root) <= ROOT_DISPLAY_WIDTH ? root : `…/${basename(root)}`;
    const todos = formatTodos();
    return [
        `模型  ${config.model}`,
        `会话  ${sessions.currentId()}`,
        `根目录  ${shownRoot}`,
        `记忆  ${listMemories().length} 条 / ${memoryBlocks()} 块`,
        `指令  ${instructions ? "已加载" : "无"}`,
        `技能  ${activeSkill()?.name ?? "无"}`,
        `MCP  ${mcpLine()}`,
        `插件  ${
            listPlugins().length > 0
                ? listPlugins()
                      .map((p) => p.name)
                      .join("、")
                : "无"
        }`,
        "──── 上下文 ────",
        `${ctx} / ${window} tokens`,
        `${Math.ceil((ctx / window) * 100)}% used`,
        "──── 本轮 ────",
        `${usage.round + usage.live} tokens`,
        "──── 累计 ────",
        `${usage.cum} tokens`,
        "──── TODO ────",
        ...(todos.length > 0 ? todos : ["（暂无任务）"]),
    ];
}

function updatePanel(): void {
    tui.setPanel(buildPanel());
}

function describeActiveSkill(): string {
    const skill = activeSkill();
    if (!skill) return "无";
    const parts: string[] = [];
    if (skill.tools.length) parts.push(`自带工具：${skill.tools.map((t) => t.name).join("、")}`);
    if (skill.builtinTools.length) parts.push(`内置工具：${skill.builtinTools.join("、")}`);
    return parts.length ? `${skill.name}（${parts.join("；")}）` : skill.name;
}

function printHelp(): void {
    const pluginCmds = listPluginCommands()
        .map((c) => `  /${c.name}   ${c.description}`)
        .join("\n");
    tui.append(
        `可用命令：
  /help    显示帮助
  /compact 立即压缩旧对话摘要（不等自动触发）
  /undo    撤销最近一次 write / patch 写入
  /todos   查看 Agent 当前的 TODO 列表
  /memory  查看跨会话保留的长期记忆
  /mcp     查看已接入的 MCP server 与工具清单
  /rag     采集建库（/rag add <URL 或路径>）/查看知识库
  /skills  列出可用技能
  /use     加载技能（/use <名字>）
  /unuse   卸载当前技能
  /plugins 列出已加载插件与插件命令
  /save    保存全部会话到 .kagent/sessions.json
  /load    从 .kagent/sessions.json 恢复全部会话
  /new <id> 新建并切换到会话
  /open <id> 切换会话
  /sessions 列出内存中的会话
  /reset   清空当前会话历史（长期记忆保留）
  /exit    保存全部会话并退出（等价于 Ctrl+C / Ctrl+D）
${pluginCmds ? `插件命令：\n${pluginCmds}\n` : ""}工具权限由 .kagent/KAgent.json 的 allow / ask / deny 控制；文件工具只能访问 root 内的路径。
右侧面板实时显示本轮 / 累计 tokens 与上下文占用比例：消耗看得见，挤爆之前就知道该压缩了。`,
        "sys",
    );
}

async function saveAll(): Promise<{ count: number; file: string }> {
    const data = sessions.dump(chat.exportHistory());
    const file = await saveSessions(data);
    return { count: Object.keys(data.sessions).length, file };
}

async function handleCommand(line: string): Promise<void> {
    const [command, id] = line.split(/\s+/, 2);
    switch (command) {
        case "/help":
            printHelp();
            break;
        case "/reset":
            chat.reset();
            tui.append("（已清空对话记忆）", "sys");
            break;
        case "/compact":
            tui.append(`[${await chat.compact()}]`, "tool");
            break;
        case "/save":
            try {
                const { count, file } = await saveAll();
                tui.append(`（已保存 ${count} 个会话到 ${file}）`, "sys");
            } catch (e) {
                tui.append(`保存失败：${(e as Error).message}`, "sys");
            }
            break;
        case "/load":
            try {
                const { data, file } = await loadSessions();
                const messages = sessions.restore(data);
                chat.importHistory(messages);
                tui.append(
                    `（已从 ${file} 恢复 ${sessions.list(messages).length} 个会话，当前：${sessions.currentId()}）`,
                    "sys",
                );
            } catch (e) {
                tui.append(`读取失败：${(e as Error).message}`, "sys");
            }
            break;
        case "/new":
            if (!id) {
                tui.append("用法：/new <id>", "sys");
                break;
            }
            try {
                chat.importHistory(sessions.create(id, chat.exportHistory()));
                tui.append(`（已新建并切换到会话 ${id}）`, "sys");
            } catch (e) {
                tui.append(`新建失败：${(e as Error).message}`, "sys");
            }
            break;
        case "/sessions": {
            const lines = sessions
                .list(chat.exportHistory())
                .map((item) => `${item.current ? "*" : " "} ${item.id}（${item.count} 条消息）`);
            tui.append(`会话：\n${lines.join("\n")}`, "sys");
            break;
        }
        case "/open":
            if (!id) {
                tui.append("用法：/open <id>", "sys");
                break;
            }
            try {
                const messages = sessions.open(id, chat.exportHistory());
                chat.importHistory(messages);
                tui.append(`（已切换到会话 ${id}，${messages.length} 条消息）`, "sys");
            } catch (e) {
                tui.append(`打开失败：${(e as Error).message}`, "sys");
            }
            break;
        case "/undo":
            try {
                tui.append(`（${await undo()}）`, "sys");
            } catch (e) {
                tui.append(`撤销失败：${(e as Error).message}`, "sys");
            }
            break;
        case "/todos": {
            const todos = formatTodos();
            tui.append(todos.length > 0 ? `TODO：\n${todos.join("\n")}` : "（暂无 TODO）", "sys");
            break;
        }
        case "/memory": {
            const memories = listMemories();
            const lines = memories.map((item, i) => `${i + 1}. ${item}`);
            tui.append(lines.length > 0 ? `长期记忆：\n${lines.join("\n")}` : "（暂无长期记忆）", "sys");
            break;
        }
        case "/mcp": {
            const statuses = mcpStatuses();
            if (statuses.length === 0) {
                tui.append("（未接入 MCP server；在 .geekagent/mcp.json 里声明后重启生效）", "sys");
                break;
            }
            const lines = statuses.map((s) =>
                s.error
                    ? `× ${s.server}：${s.error}`
                    : `${s.server}（${s.tools.length} 个工具）\n${s.tools.map((t) => `  ${t}`).join("\n")}`,
            );
            tui.append(lines.join("\n"), "sys");
            break;
        }
        case "/rag": {
            const args = line.slice("/rag".length).trim();
            if (!args) {
                try {
                    tui.append(ragStats(), "sys");
                } catch (e) {
                    tui.append(`知识库统计失败：${(e as Error).message}`, "sys");
                }
            } else if (args.startsWith("add ")) {
                // 整个参数作为单一来源：按空白拆分会弄坏含空格的 Windows 路径
                const src = args.slice(4).trim();
                if (!src) {
                    tui.append("用法：/rag add <网页 URL 或文件路径>", "sys");
                } else {
                    try {
                        tui.append(`[${await addToRag(src)}]`, "tool");
                    } catch (e) {
                        tui.append(`采集失败：${(e as Error).message}`, "sys");
                    }
                }
            } else {
                tui.append("用法：/rag add <网页 URL 或文件路径> 采集建库；/rag 查看知识库", "sys");
            }
            break;
        }
        case "/skills": {
            const lines = listSkills().map(
                (s) => `${activeSkill()?.name === s.name ? "*" : " "} ${s.name} — ${s.description}`,
            );
            tui.append(
                lines.length > 0
                    ? `可用技能（skills/ 目录，/use 加载）：\n${lines.join("\n")}`
                    : "（skills/ 目录下暂无技能）",
                "sys",
            );
            break;
        }
        case "/use":
            if (!id) {
                tui.append("用法：/use <技能名>（/skills 查看可用技能）", "sys");
                break;
            }
            try {
                await useSkill(id);
                chat.setSkillInstructions(activeSkill()?.instructions ?? "");
                tui.append(`已加载技能 ${describeActiveSkill()}`, "tool");
            } catch (e) {
                tui.append(`加载失败：${(e as Error).message}`, "sys");
            }
            break;
        case "/unuse":
            unuseSkill();
            chat.setSkillInstructions("");
            tui.append("（已卸载技能，恢复默认行为）", "tool");
            break;
        case "/plugins": {
            const loaded = listPlugins();
            if (loaded.length === 0) {
                tui.append("（plugins/ 目录下暂无插件）", "sys");
                break;
            }
            const pluginLines = loaded.map((p) => {
                const cmds = (p.commands ?? []).map((c) => `/${c.name}`).join("、");
                return `${p.name} — ${p.description}${cmds ? `（命令：${cmds}）` : ""}`;
            });
            tui.append(`已加载插件（plugins/ 目录）：\n${pluginLines.join("\n")}`, "sys");
            break;
        }
        case "/exit":
            await onExit();
            break;
        default:
            if (command.startsWith("/")) {
                const cmdName = command.slice(1);
                const args = line.slice(command.length).trim();
                const result = await execPluginCommand(cmdName, args);
                if (result !== null) {
                    tui.append(result, "sys");
                    break;
                }
            }
            tui.append(`未知命令：${command}（输入 /help 查看）`, "sys");
    }
    updatePanel();
}

async function reply(line: string): Promise<void> {
    usage.round = 0;
    chat.setRecall(recallMemory(line)); // 自动唤起：用户一开口，相关记忆先进 system prompt
    try {
        tui.append("", "sys"); // 回复前空一行，把上一段对话隔开
        for await (const delta of chat.streamReply(line)) {
            // 进度行（工具调用 / 历史压缩）用黄色；流式期间按字符估算本轮增量
            if (delta.startsWith("\n[调用工具") || delta.startsWith("\n[历史压缩")) {
                usage.live = 0;
                tui.append(delta, "tool");
            } else {
                tui.appendInline(delta, "model");
                usage.live = estimateTokens(delta);
            }
            updatePanel();
        }
        usage.live = 0;
        tui.append("", "sys");
    } catch (e) {
        tui.append(`请求失败：${(e as Error).message}`, "sys");
    }
    updatePanel();
}

async function onLine(line: string): Promise<void> {
    if (busy) return; // TUI 已挡一道，这里再兜一次防止重入
    busy = true;
    tui.setBusy(true);
    if (line.startsWith("/")) {
        await handleCommand(line);
    } else {
        await reply(line);
    }
    busy = false;
    tui.setBusy(false);
    tui.ready(); // 恢复到输入状态，读下一行
}

async function onExit(): Promise<void> {
    stopMcpServers(); // 关掉 MCP server 子进程
    await runPluginExit(pluginCtx); // 退出前通知插件
    tui.stop(); // 恢复原来的终端内容后再用 console 打印
    try {
        const generatedId = sessions.nameDefault(chat.exportHistory());
        const { count, file } = await saveAll();
        console.log(`（退出前已保存 ${count} 个会话到 ${file}）`);
        if (generatedId) console.log(`（会话 ID：${generatedId}，重启后可用 /load 再用 /open ${generatedId} 打开）`);
    } catch (e) {
        console.error(`退出前保存失败：${(e as Error).message}`);
    }
    console.log("bye");
    process.exit(0);
}

if (webMode) {
    // 服务模式：插件已在 onStart 里起服务；挂住进程等 Ctrl+C
    process.once("SIGINT", () => void onExit());
    process.once("SIGTERM", () => void onExit());
    await new Promise(() => {});
} else {
    tui.start();
    updatePanel();
    tui.append("KAgent", "sys");
}
