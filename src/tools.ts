import { exec } from "node:child_process";
import { Interface as Readline } from "node:readline/promises";
import { promisify } from "node:util";
import { ChatCompletionTool } from "openai/resources/chat/completions";
import { out } from "./color";

const execAsync = promisify(exec);

// 单条命令最长运行时间，超时直接杀进程
const SHELL_TIMEOUT_MS = 10_000;
// 命令输出超过这个数量就阶段，避免撑满上下文
const MAX_OUTPUT_CHARS = 2000;

/**
 * 工具的最小抽象：名称+描述+参数 JSON Schema + run
 */
export interface Tool {
    name: string;
    decription: string;
    parameters: Record<string, unknown>;
    run(args: Record<string, unknown>): Promise<string> | string;
}

/**
 * 全部已接入工具
 */

export const TOOLS: Tool[] = [
    {
        name: "get_current_time",
        decription: "获取当前本地时间(Asia/Shanghai)",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        run: () => new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
    },
    {
        name: "run_shell",
        decription: "在本地执行一条 shell 命令 (bash -c), 返回合并后的标准输出/错误。执行前会向用户确认",
        parameters: {
            command: {
                type: "string",
                description: "要执行的 shell 命令",
            },
            required: ["command"],
            additionalProperties: false,
        },
        run: async (args) => {
            const command = String(args.command ?? "").trim();
            if (!command) return "缺少参数 command";
            if (!(await confirm(`即将执行命令: ${command}`))) {
                return "已取消执行";
            }
            try {
                const { stdout, stderr } = await execAsync(command, {
                    timeout: SHELL_TIMEOUT_MS,
                    maxBuffer: MAX_OUTPUT_CHARS * 4,
                });
                return truncate([stdout, stderr].filter(Boolean).join("\n") || "(无输出)");
            } catch (e) {
                const err = e as { message: string; stdout?: string; stderr?: string };
                const partial = [err.stdout, err.stderr].filter(Boolean).join("\n");
                return truncate(`命令执行失败(${err.message})\n${partial}`);
            }
        },
    },
];

// 超出阈值就截断输出，并附上原长度提示
function truncate(text: string): string {
    if (text.length <= MAX_OUTPUT_CHARS) return text;
    return `${text.slice(0, MAX_OUTPUT_CHARS)}\n...(输出已截断, 原共 ${text.length} 字符)`;
}

/**
 * 执行前确认的抽象，设计成可注入的函数；后续的权限模型直接替换 setConfigFn 就行
 */
type ConfirmFn = (prompt: string) => Promise<boolean>;

let confirm: ConfirmFn = async () => false;

/**
 * 注入交互时确认逻辑，后面可以替换为权限模型
 */
export function setConfirmFn(fn: ConfirmFn): void {
    confirm = fn;
}

function buildCliConfirm(rl: Readline): ConfirmFn {
    return (prompt) =>
        new Promise<boolean>((resolve) => {
            const onLine = (raw: string) => {
                rl.removeListener("line", onLine);
                const answer = raw.trim().toLowerCase();
                resolve(answer === "y" || answer === "yes");
            };
            rl.on("line", onLine);
            rl.resume();
            out("tool", `${prompt} [y/N]`);
        });
}

/**
 * 用主 REPL 的 readline 接口安装 CLI 确认
 * @param rl Readline
 */
export function installCliConfirm(rl: Readline): void {
    setConfirmFn(buildCliConfirm(rl));
}

/**
 * 把内部 Tool 转换为 OpenAI Chat Completions 的 tools 参数格式
 */
export function toOpenAITools(): ChatCompletionTool[] {
    return TOOLS.map((tool) => ({
        type: "function",
        function: {
            name: tool.name,
            description: tool.decription,
            parameters: tool.parameters,
        },
    }));
}

/**
 * 按名字执行工具
 */
export async function execTool(name: string, argsJson: string): Promise<string> {
    const tool = TOOLS.find((t) => t.name == name);
    if (!tool) return `未知工具: ${name}`;

    let args: Record<string, unknown> = {};
    try {
        args = argsJson ? JSON.parse(argsJson) : {};
    } catch {
        return `参数是非法 JSON: ${argsJson}`;
    }

    try {
        return await tool.run(args);
    } catch (e) {
        return `工具执行失败: ${(e as Error).message}`;
    }
}
