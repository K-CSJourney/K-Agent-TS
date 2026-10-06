import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { registerTool, type Tool } from "./tools";
import { authorize, safePath } from "./permissions";
import { chunkEntry, scoreChunks, STOPWORDS, tokenize, type Chunk } from "./memory";
import { FetchCancelledError, fetchTextFromUrl, htmlToText } from "./tools";

const RAG_FILE = resolve(".kagent/rag/index.json");
/** 文档切块窗口：比记忆条目大（整篇文档），知识库检索的块粒度更粗。 */
const RAG_CHUNK_SIZE = 800;
/** 单篇文档入库上限，超出直接整篇弃掉，防失控。 */
const MAX_DOC_CHARS = 2 * 1024 * 1024;
/** 一次检索最多返回的命中块数。 */
const MAX_RESULTS = 4;

/** 知识库里的一个文档：标题、来源、切块后的段落。 */
interface RagDoc {
    title: string;
    source: string;
    addedAt: string;
    chunks: { start: number; text: string }[];
}

let docs: RagDoc[] = [];

/** 单条块数据的校验：坏块直接丢弃，不让手改 / 旧格式的数据炸掉检索与统计。 */
function toChunk(c: unknown): { start: number; text: string } | null {
    if (!c || typeof (c as { start: unknown }).start !== "number" || typeof (c as { text: unknown }).text !== "string")
        return null;
    return c as { start: number; text: string };
}

/** 启动时从磁盘恢复知识库；文件不存在等同于空库。 */
export async function loadRag(): Promise<void> {
    try {
        const value = JSON.parse(await readFile(RAG_FILE, "utf8")) as { docs?: unknown };
        docs = Array.isArray(value.docs)
            ? value.docs.filter((d): d is RagDoc => {
                  if (
                      !d ||
                      typeof (d as RagDoc).title !== "string" ||
                      typeof (d as RagDoc).source !== "string" ||
                      !Array.isArray((d as RagDoc).chunks)
                  )
                      return false;
                  (d as RagDoc).chunks = (d as RagDoc).chunks.map(toChunk).filter(
                      (c): c is { start: number; text: string } => c !== null,
                  );
                  return true;
              })
            : [];
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            docs = [];
            return;
        }
        throw err;
    }
}

/** 把 docs 整体写盘；先写临时文件再 rename 原子替换，崩溃不会留下截断的 JSON。 */
async function saveRag(next: readonly RagDoc[]): Promise<void> {
    await mkdir(dirname(RAG_FILE), { recursive: true });
    const tmp = `${RAG_FILE}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ docs: next }, null, 2)}\n`, "utf8");
    await rename(tmp, RAG_FILE);
}

/**
 * 采集一个网页（http/https）或本地文件进知识库。全文走内部通道，不经模型上下文；
 * 切块后连同一份索引落盘，之后按 rag_search 检索。重复来源直接跳过。
 */
export async function addToRag(source: string): Promise<string> {
    const target = source.trim();
    if (!target) return "缺少要采集的来源";
    if (!(await authorize("rag_add", `\n即将把以下内容加入知识库：\n${target}\n确认采集？`))) return "已取消采集";
    if (docs.some((d) => d.source === target)) return "已在知识库中，跳过（重复采集）";

    let title: string;
    let text: string;
    try {
        if (/^https?:\/\//i.test(target)) {
            // 复用 fetch 工具的共享抓取核心：手动重定向逐跳确认、字节上限、charset 解码
            const startHref = new URL(target).href;
            const { text: converted, raw, contentType } = await fetchTextFromUrl(target, async (url) => {
                if (url === startHref) return true; // 入口 URL 已在最上面确认过
                return authorize("rag_add", `\n采集重定向到：\n${url}\n确认继续？`);
            });
            text = converted;
            const m = /html/i.test(contentType) ? raw.match(/<title[^>]*>([^<]+)<\/title>/i) : null;
            title = m ? m[1].trim() : target;
        } else {
            const file = await safePath(target);
            text = await readFile(file, "utf8");
            if (text.includes("\0")) return "看起来是二进制文件，未入库";
            if (/\.html?$/i.test(target)) text = htmlToText(text);
            title = basename(file);
        }
    } catch (err) {
        const e = err as Error;
        if (e instanceof FetchCancelledError) return e.message;
        return `采集失败：${e.message}`;
    }

    if (!text.trim()) return "内容为空，未入库";
    if (text.length > MAX_DOC_CHARS) return `内容过大（${text.length} 字符，上限 2MB），未入库`;
    const chunks = chunkEntry(text, 0, RAG_CHUNK_SIZE);
    const doc: RagDoc = { title: title.slice(0, 120), source: target, addedAt: new Date().toISOString(), chunks };
    // 先落盘成功再更新内存态，写失败时两者不会分叉
    await saveRag([...docs, doc]);
    docs.push(doc);
    return `已加入知识库：《${title.slice(0, 120)}》共 ${text.length} 字符 / ${chunks.length} 块`;
}

/** 在知识库里按 BM25 检索相关段落：query 支持自然语言（内部切 bigram token）或空格分隔关键词。 */
export function ragSearch(query: string): string {
    const keywords = tokenize(query).filter((t) => !STOPWORDS.has(t));
    if (keywords.length === 0) return "没有命中任何知识块";
    const all: Chunk[] = docs.flatMap((doc, di) =>
        doc.chunks.map((c, ci) => ({ entry: di, index: ci, start: c.start, text: c.text })),
    );
    if (all.length === 0) return "知识库还是空的，先用 rag_add 或 /rag add 采集";
    const hits = scoreChunks(keywords, all)
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_RESULTS);
    if (hits.length === 0) return "没有命中任何知识块，换个更聚焦的说法再试";
    return `命中 ${hits.length} 块：\n${hits
        .map((h, i) => {
            const doc = docs[h.chunk.entry];
            return `${i + 1}. 《${doc.title}》第 ${h.chunk.index + 1} 段：${h.chunk.text.trim()}`;
        })
        .join("\n")}`;
}

/** 知识库总览：文档数、块数、字符数与文档清单，供 /rag 命令直接展示。 */
export function ragStats(): string {
    if (docs.length === 0) return "知识库还是空的（用 /rag add 采集，或让模型调用 rag_add）";
    const blocks = docs.reduce((n, d) => n + d.chunks.length, 0);
    const chars = docs.reduce((n, d) => n + d.chunks.reduce((m, c) => m + c.text.length, 0), 0);
    return `知识库共 ${docs.length} 个文档 / ${blocks} 块 / ${chars} 字符：\n${docs
        .map((d, i) => `${i + 1}. 《${d.title}》（${d.chunks.length} 块，${d.source}）`)
        .join("\n")}`;
}

/** 注册 rag 工具：采集（ask）与检索（allow）。 */
export function setupRag(changed: () => void): void {
    const tools: Tool[] = [
        {
            name: "rag_add",
            description:
                "把一个网页（http/https）或本地文件采集进知识库：全文切块、建索引，之后用 rag_search 按问检索。采集经过内部通道，正文不进入当前上下文，适合批量灌文档。回答涉及教程、资料前，若发现相关文档没入库，可先采集。默认 ask 策略。",
            parameters: {
                type: "object",
                properties: { source: { type: "string", description: "网页完整 URL（http/https）或仓库内文件路径" } },
                required: ["source"],
                additionalProperties: false,
            },
            run: (args) => addToRag(String(args.source ?? "").trim()),
            authorizes: true,
        },
        {
            name: "rag_search",
            description:
                "在知识库里按 BM25 检索相关段落，返回命中块与来源标题。回答涉及项目文档、教程、系列博客、本地资料等知识库内容之前，先调用它找到依据。query 直接用自然语言提问即可，也支持空格分隔关键词。",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "要检索的说法，直接写自然语言，如「这套教程 Day 5 做了什么」",
                    },
                },
                required: ["query"],
                additionalProperties: false,
            },
            run: (args) => ragSearch(String(args.query ?? "")),
        },
    ];
    tools.forEach(registerTool);
    changed();
}
