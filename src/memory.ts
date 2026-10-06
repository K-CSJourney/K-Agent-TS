import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { registerTool, Tool } from "./tools";

const MEMORY_FILE = resolve(".kagent/memory.json");
/** 记忆条目按这个字符窗口切块；检索、返回都以块为单位，长条目也能精确定位到段。 */
const CHUNK_SIZE = 320;
/** 相邻块的字符重叠，避免一句结论恰好被切在块边界上。 */
const CHUNK_OVERLAP = 80;
/** 一次检索最多返回的命中条目数（同一记忆去重后），够用又不至于撑爆上下文。 */
const MAX_RESULTS = 5;
/** 单条记忆写入的最大长度；超长按码点截断，不会切断 emoji 等代理对。 */
const MAX_ENTRY_CHARS = 4000;
/** BM25 平滑参数：k1 越小对词频越敏感，b 越大对长度归一越弱。 */
const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** 查询里的虚词 / 常用字：命中再多也没有区分度，直接忽略。 */
export const STOPWORDS = new Set([
    "的",
    "了",
    "在",
    "是",
    "和",
    "一",
    "个",
    "也",
    "就",
    "都",
    "把",
    "被",
    "从",
    "到",
    "给",
    "与",
    "及",
    "这",
    "那",
    "并",
    "而",
    "等",
    "有",
    "没",
    "不",
    "我们",
    "一个",
    "可以",
]);

let items: string[] = [];

/** 一条记忆的一块：记录它属于哪条、条内第几段、原文偏移。 */
export interface Chunk {
    entry: number;
    index: number;
    start: number;
    text: string;
}

/**
 * 按固定窗口 + 重叠把条目切成块；短条目（不超过窗口）就是一块。
 * size 参数供 Day 14 的知识库按更大窗口切文档，省略时沿用记忆的默认窗口。
 */
export function chunkEntry(text: string, entry: number, size = CHUNK_SIZE): Chunk[] {
    if (text.length <= size) return [{ entry, index: 0, start: 0, text }];
    const chunks: Chunk[] = [];
    const step = size - CHUNK_OVERLAP;
    for (let start = 0; ; start += step) {
        chunks.push({ entry, index: chunks.length, start, text: text.slice(start, start + size) });
        if (start + size >= text.length) break;
    }
    return chunks;
}

/** 归一化：转小写、空白压成一个空格。查询词直接按子串匹配，省掉分词。 */
function norm(s: string): string {
    return s.toLowerCase().replace(/\s+/g, " ");
}

/**
 * 零依赖分词：中文连续段切成字符二元组（bigram），英文 / 数字保留整词。
 * 自然语言提问没有词边界，bigram 是换掉「必须空格分隔关键词」的最小代价。
 */
export function tokenize(text: string): string[] {
    const tokens: string[] = [];
    const runs = norm(text).match(/[一-龥]+|[a-z0-9]+/g) ?? [];
    for (const run of runs) {
        if (/[a-z0-9]/.test(run[0]) || run.length === 1) {
            tokens.push(run);
        } else {
            for (let i = 0; i + 2 <= run.length; i++) tokens.push(run.slice(i, i + 2));
        }
    }
    return tokens;
}

/** 统计 term 在 text 中连续出现的次数（不重叠计数）。 */
function termCount(text: string, term: string): number {
    let n = 0,
        i = 0;
    while ((i = text.indexOf(term, i)) >= 0) {
        n++;
        i += term.length;
    }
    return n;
}

/**
 * BM25-lite 打分：每个查询词按「tf × 平滑 idf」贡献分数，再用文档长度做归一。
 * 归一化文本和每个词的 df 各只算一次，整体 O(N × 词数)，不再逐块重复扫描全表。
 * 记忆检索与知识库检索共用这一份实现，保证打分口径一致。
 */
export function scoreChunks(query: string[], chunks: Chunk[]): { chunk: Chunk; score: number }[] {
    const docs = chunks.map((c) => ({ chunk: c, doc: norm(c.text) }));
    const n = docs.length;
    const avgdl = docs.reduce((s, d) => s + d.doc.length, 0) / n;
    const terms = [...new Set(query)];
    return docs.map(({ chunk, doc }) => {
        const dl = doc.length;
        let score = 0;
        for (const t of terms) {
            const df = docs.reduce((s, d) => s + (d.doc.includes(t) ? 1 : 0), 0);
            const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
            const tf = termCount(doc, t);
            const normed = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgdl)));
            score += idf * normed;
        }
        return { chunk, score };
    });
}

/** 打分检索：同一 entry 只保留得分最高的一块，重叠窗口不再互相挤占名额。 */
function topHits(query: string[], chunks: Chunk[]): Chunk[] {
    const best = new Map<number, { chunk: Chunk; score: number }>();
    for (const hit of scoreChunks(query, chunks)) {
        if (hit.score <= 0) continue;
        const prev = best.get(hit.chunk.entry);
        if (!prev || hit.score > prev.score) best.set(hit.chunk.entry, hit);
    }
    return [...best.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_RESULTS)
        .map((h) => h.chunk);
}

/** 把命中块排成「条目 #N，第 M 段：内容」的可读列表，模型和用户看同一份。 */
function formatHits(hits: Chunk[]): string {
    return hits.map((c, i) => `${i + 1}. （条目 #${c.entry + 1}，第 ${c.index + 1} 段）${c.text.trim()}`).join("\n");
}

/** 检索公共段：切块 → 打分 → 按条目取 top-k；没有记忆或没有命中返回 null。 */
function retrieve(keywords: string[]): Chunk[] | null {
    const chunks = items.flatMap((item, entry) => chunkEntry(item, entry));
    if (chunks.length === 0) return null;
    const hits = topHits(keywords, chunks);
    return hits.length > 0 ? hits : null;
}

/** 按 BM25 打分检索记忆块（手动调用）：自然语句或空格分隔的关键词都可以，内部统一分词。 */
export function searchMemory(query: string): string {
    const raw = query.trim();
    if (!raw) return "缺少参数 query";
    const keywords = tokenize(raw).filter((t) => !STOPWORDS.has(t));
    if (keywords.length === 0) return "关键词都是常用虚词，请换更具体的关键词再搜";
    const hits = retrieve(keywords);
    return hits ? `找到 ${hits.length} 条相关记忆：\n${formatHits(hits)}` : "没有找到相关记忆";
}

/**
 * 每轮对话前的自动唤起：把用户原话直接切成 bigram token 再检索，命中就以「自动唤起记忆」
 * 的形式拼进 system prompt——模型不用记得自己去查，提问的同时相关记忆已在案头。
 */
export function recallMemory(rawText: string): string {
    const keywords = tokenize(rawText).filter((t) => !STOPWORDS.has(t));
    if (keywords.length === 0) return "";
    const hits = retrieve(keywords);
    return hits ? `自动唤起 ${hits.length} 条相关记忆（供参考）：\n${formatHits(hits)}` : "";
}

/** 磁盘格式保持 string[] 不变，读、写、内存态三处一致；先写临时文件再 rename 原子替换，崩溃不会留下截断的 JSON。 */
async function saveToDisk(next: string[]): Promise<void> {
    await mkdir(dirname(MEMORY_FILE), { recursive: true });
    const tmp = `${MEMORY_FILE}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(tmp, MEMORY_FILE);
    items = next;
    recountBlocks();
}

/** 启动时从磁盘恢复长期记忆；文件不存在等同于还没有记忆。 */
export async function loadMemory(): Promise<void> {
    try {
        const value = JSON.parse(await readFile(MEMORY_FILE, "utf8")) as unknown;
        if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
            throw new Error("memory.json 必须是字符串数组");
        }
        items = value.map((item) => item.trim()).filter(Boolean);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            items = [];
            recountBlocks();
            return;
        }
        throw err;
    }
    recountBlocks();
}

/** 注册写记忆工具；模型判断某条信息值得跨会话保留时主动调用。 */
export function setupMemory(changed: () => void): void {
    const tools: Tool[] = [
        {
            name: "memory_write",
            description:
                "把值得跨会话保留的用户偏好、项目事实或重要决定写入长期记忆。支持存多段长文，检索时会按块命中、返回相关段落。不要记录临时任务进度或可随时从文件读到的内容。",
            parameters: {
                type: "object",
                properties: {
                    content: { type: "string", description: "一条脱离当前对话也能独立理解的事实，可以是一段长文" },
                },
                required: ["content"],
                additionalProperties: false,
            },
            run: async (args) => {
                const content = String(args.content ?? "").trim();
                if (!content) return "缺少参数 content";
                // 超长按码点截断（Array.from 不会把代理对从中间切开），emoji 也能完整保留
                const entry =
                    content.length <= MAX_ENTRY_CHARS
                        ? content
                        : Array.from(content).slice(0, MAX_ENTRY_CHARS).join("");
                if (items.includes(entry)) return "这条记忆已经存在";
                await saveToDisk([...items, entry]);
                changed();
                return entry.length < content.length ? `已记住（过长已截短）：${entry}` : `已记住：${entry}`;
            },
        },
        {
            name: "memory_search",
            description:
                "按 BM25 打分检索长期记忆，返回命中的记忆块（精确到段）。需要回忆用户偏好、项目事实或以前的决定时调用；query 可以是空格分隔的关键词，也可以直接写一句自然语言，如「博客 人称」或「我之前决定用什么人称写博客」。",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "检索内容：空格分隔的关键词或一句自然语言，越具体命中越准" },
                },
                required: ["query"],
                additionalProperties: false,
            },
            run: (args) => searchMemory(String(args.query ?? "")),
        },
    ];
    tools.forEach(registerTool);
}

/** 块总数缓存：只在载入 / 写入时重算，面板高频刷新不必对整个记忆库反复切块。 */
let blockCount = 0;

function recountBlocks(): void {
    blockCount = items.reduce((n, item) => n + chunkEntry(item, 0).length, 0);
}

/** 记忆块总数，供面板展示「N 条 / M 块」，让人一眼看到分块生效了。 */
export function memoryBlocks(): number {
    return blockCount;
}

export function listMemories(): readonly string[] {
    return items;
}
