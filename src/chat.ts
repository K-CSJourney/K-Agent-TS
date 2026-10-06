import OpenAI from "openai";

export class Chat {
    private client: OpenAI;
    private model: string;
    private history: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
        [];

    constructor(
        baseURL: string,
        apiKey: string,
        model: string,
    ) {
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
    async *streamReply(
        userInput: string,
    ): AsyncGenerator<string> {
        this.history.push({
            role: "user",
            content: userInput,
        });
        try {
            const stream =
                await this.client.chat.completions.create(
                    {
                        model: this.model,
                        messages: this.history,
                        stream: true,
                    },
                );
            let answer = "";
            for await (const chunk of stream) {
                const delta =
                    chunk.choices[0]?.delta
                        ?.content ?? "";
                if (delta) {
                    answer += delta;
                    yield delta;
                }
            }
            this.history.push({
                role: "assistant",
                content: answer,
            });
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
