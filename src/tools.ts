import { ChatCompletionTool } from "openai/resources/chat/completions";

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
];

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
