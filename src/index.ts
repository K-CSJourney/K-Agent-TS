import { createInterface } from "node:readline/promises";
import { Chat } from "./chat";
import { loadConfig } from "./config";
import { err, out, paint } from "./color";
import { installCliConfirm } from "./tools";
import { Sessions } from "./sessions";
import { loadSessions, saveSessions } from "./storage";

const config = loadConfig();
const chat = new Chat(config.baseURL, config.apiKey, config.model);
const sessions = new Sessions();

const rl = createInterface({ input: process.stdin, output: process.stdout });

// 用彩色提示符标识「用户输入」这一侧
rl.setPrompt(paint("user", "You >"));

let busy = false;

async function saveAll(): Promise<{ count: number; file: string }> {
    const data = sessions.dump(chat.exportHistory());
    const file = await saveSessions(data);
    return { count: Object.keys(data.sessions).length, file };
}

function printHelp(): void {
    out(
        "sys",
        `可用命令：
  /help   显示帮助
  /reset  清空本轮对话记忆
  /exit   退出（等价于 Ctrl+C / Ctrl+D）
输入任意内容即可与模型对话。`,
        true,
    );
}

installCliConfirm(rl);

rl.on("line", async (raw) => {
    if (busy) return; // 上一轮还在流式输出，忽略连发输入
    busy = true;

    const line = raw.trim();
    if (line) {
        if (line.startsWith("/")) {
            const [command, id] = line.split(/\s+/, 2);
            switch (command) {
                case "/help":
                    printHelp();
                    break;
                case "/reset":
                    chat.reset();
                    out("sys", "（已清空对话记忆）", true);
                    break;
                case "/compact":
                    out("sys", "\n"); // 压缩进度另起一行
                    out("tool", `[${await chat.compact()}]`, true);
                    break;
                case "/save":
                    try {
                        const { count, file } = await saveAll();
                        out("sys", `（已保存 ${count} 个会话到 ${file}）`, true);
                    } catch (e) {
                        err("sys", `保存失败：${(e as Error).message}`);
                    }
                    break;
                case "/load":
                    try {
                        const { data, file } = await loadSessions();
                        const messages = sessions.restore(data);
                        chat.importHistory(messages);
                        out(
                            "sys",
                            `（已从 ${file} 恢复 ${sessions.list(messages).length} 个会话，当前：${sessions.currentId()}）`,
                            true,
                        );
                    } catch (e) {
                        err("sys", `读取失败：${(e as Error).message}`);
                    }
                    break;
                case "/new":
                    if (!id) {
                        err("sys", "用法：/new <id>");
                        break;
                    }
                    try {
                        chat.importHistory(sessions.create(id, chat.exportHistory()));
                        out("sys", `（已新建并切换到会话 ${id}）`, true);
                    } catch (e) {
                        err("sys", `新建失败：${(e as Error).message}`);
                    }
                    break;
                case "/sessions": {
                    const list = sessions.list(chat.exportHistory());
                    const lines = list.map((item) => `${item.current ? "*" : " "} ${item.id}（${item.count} 条消息）`);
                    out("sys", `会话：\n${lines.join("\n")}`, true);
                    break;
                }
                case "/open":
                    if (!id) {
                        err("sys", "用法：/open <id>");
                        break;
                    }
                    try {
                        const messages = sessions.open(id, chat.exportHistory());
                        chat.importHistory(messages);
                        out("sys", `（已切换到会话 ${id}，${messages.length} 条消息）`, true);
                    } catch (e) {
                        err("sys", `打开失败：${(e as Error).message}`);
                    }
                    break;
                case "/exit":
                    rl.close();
                    return;
                default:
                    out("sys", `未知命令：${line}（输入 /help 查看）`, true);
            }
        } else {
            try {
                out("sys", "\n"); // 模型回复另起一行
                for await (const delta of chat.streamReply(line)) {
                    // 进度行（工具调用 / 历史压缩）用黄色，真正的回复用绿色
                    const isProgress = delta.startsWith("\n[调用工具") || delta.startsWith("\n[历史压缩");
                    out(isProgress ? "tool" : "model", delta);
                }
                out("sys", "\n");
            } catch (e) {
                err("sys", `\n请求失败：${(e as Error).message}`);
            }
        }
    }

    busy = false;
    rl.prompt();
});

rl.on("close", async () => {
    try {
        const generatedId = sessions.nameDefault(chat.exportHistory());
        const { count, file } = await saveAll();
        out("sys", `（退出前已保存 ${count} 个会话到 ${file}）`, true);
        if (generatedId) {
            out("sys", `（会话 ID：${generatedId}，重启后可用 /load 再用 /open ${generatedId} 打开）`, true);
        }
    } catch (e) {
        err("sys", `退出前保存失败：${(e as Error).message}`);
    }
    out("sys", "bye", true);
});

out("sys", `KAgent（模型：${config.model}，输入 /help 查看命令）`, true);
rl.prompt();
