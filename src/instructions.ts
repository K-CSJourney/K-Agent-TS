import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// 读取项目根目录的 AGENTS.md；没有项目指令时返回空文本
export async function loadInstructions(root: string): Promise<string> {
    try {
        return (await readFile(resolve(root, "AGENTS.md"), "utf-8")).trim();
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw e;
    }
}
