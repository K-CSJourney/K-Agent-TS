import OpenAI from "openai";
import { execTool, toOpenAITools } from "./tools";

// 工具调用循环的最多轮数，防止进入死循环
const MAX_TOOL_TURNS = 5;

export class Chat {
    private client: OpenAI;
    private model: string;
    private history: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

    constructor(baseURL: string, apiKey: string, model: string) {
        this.client = new OpenAI({
            baseURL,
            apiKey,
        });
        this.model = model;
    }

    /**
     * 携带 history 发送用户输入，逐段增量产出回复内容；结束后把完整回答写入 history
     * @param userInput 用户输入
     */
    async *streamReply(userInput: string): AsyncGenerator<string> {
        this.history.push({
            role: "user",
            content: userInput,
        });
        try {
            for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
                const stream = await this.client.chat.completions.create({
                    model: this.model,
                    messages: this.history,
                    stream: true,
                    tools: toOpenAITools(),
                });
                let answer = "";
                const calls = new Map<number, { id: string; name: string; args: string }>();
                for await (const chunk of stream) {
                    const delta = chunk.choices[0]?.delta;
                    if (delta?.content) {
                        answer += delta.content;
                        yield delta.content;
                    }
                    for (const tc of delta?.tool_calls ?? []) {
                        let call = calls.get(tc.index);
                        if (!call) {
                            call = { id: "", name: "", args: "" };
                            calls.set(tc.index, call);
                        }
                        if (tc.id) call.id = tc.id;
                        if (tc.function?.name) call.name += tc.function.name;
                        if (tc.function?.arguments) call.args += tc.function.arguments;
                    }
                }

                const toolCalls = [...calls.values()];
                if (toolCalls.length > 0 && toolCalls.every((c) => c.name)) {
                    toolCalls.forEach((c, i) => {
                        if (!c.id) c.id = `call_${i}`;
                    });
                    this.history.push({
                        role: "assistant",
                        content: answer || null,
                        tool_calls: toolCalls.map((c) => ({
                            id: c.id,
                            type: "function" as const,
                            function: { name: c.name, arguments: c.args },
                        })),
                    });
                    for (const c of toolCalls) {
                        const result = await execTool(c.name, c.args);
                        yield `\n调用工具 ${c.name} → ${result}\n`;
                        this.history.push({ role: "tool", tool_call_id: c.id, content: result });
                    }
                    continue;
                }
                this.history.push({
                    role: "assistant",
                    content: answer,
                });
                return; // 没有工具调用，这就是最终回答，直接结束
            }
            // 轮次用尽仍未停下
            yield "\n[工具调用轮次过多，已停止]";
            this.history.push({ role: "assistant", content: `[工具调用轮次过多，已停止]` });
        } catch (e) {
            // 报错的话就回滚刚入队的用户信息，保持 history 干净
            this.history.pop();
            throw e;
        }
    }

    reset(): void {
        this.history = [];
    }
}
