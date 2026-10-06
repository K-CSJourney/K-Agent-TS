import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hasTool, registerTool, setVisibleTools, Tool, unregisterTool } from "./tools";
import { access, readdir, readFile } from "node:fs/promises";
import { ensureToolPolicy } from "./permissions";

const SKILLS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "skills");

export interface Skill {
    name: string;
    description: string;
    instructions: string;
    /** 技能目录路径；自带工具延迟到 /use 时才从这里的 tools.ts 加载。 */
    dir: string;
    /** 技能自带工具：激活时注册、卸载时移除，只在技能生效期间可调用。 */
    tools: Tool[];
    /** SKILL.md 头部声明的内置工具白名单；空数组 = 不收敛工具。 */
    builtinTools: string[];
}

let skills: Skill[] = [];
let active: Skill | null = null;

/** 解析 SKILL.md：头部 `---` 块里放 description / tools 列表，第二条 `---` 之后是指令正文。 */
function parseSkill(dir: string, name: string, raw: string): Skill {
    const lines = raw.split("\n");
    let description = "";
    const builtinTools: string[] = [];
    let body = lines;
    if (lines[0]?.trim() === "---") {
        const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
        if (end > 0) {
            let section = "";
            for (const line of lines.slice(1, end)) {
                const text = line.trim();
                if (text.startsWith("description:")) {
                    description = text.slice("description:".length).trim();
                    section = "description";
                } else if (text.startsWith("tools:")) {
                    section = "tools";
                } else if (text.startsWith("-") && section === "tools") {
                    // 只把 tools: 键下的列表项当白名单；其余键的折行、列表不受影响
                    builtinTools.push(text.replace(/^-\s*/, "").trim());
                }
            }
            body = lines.slice(end + 1);
        }
        // 头部块缺第二条 `---` 时整体按正文处理，不吞内容
    }
    return { name, description, instructions: body.join("\n").trim(), dir, tools: [], builtinTools };
}

/** 技能目录里可选 tools.ts：导出 tools: Tool[]，作为该技能的自带工具。 */
async function loadSkillTools(dir: string): Promise<Tool[]> {
    const file = join(dir, "tools.ts");
    try {
        await access(file);
    } catch {
        return []; // 没有自带工具是常态
    }
    const mod = await import(pathToFileURL(file).href); // 导入/导出格式错误如实抛出，让 /use 显式报错
    if (!Array.isArray(mod.tools)) throw new Error("tools.ts 必须导出 tools: Tool[] 数组");
    return mod.tools;
}

/** 扫描 skills/ 目录，每个子目录一个技能；解析失败的技能记录后跳过。只读 SKILL.md，不执行技能代码。 */
export async function loadSkills(): Promise<Skill[]> {
    skills = [];
    let entries;
    try {
        entries = await readdir(SKILLS_DIR, { withFileTypes: true });
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return skills;
        throw err;
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = join(SKILLS_DIR, entry.name);
        const name = entry.name;
        try {
            const raw = await readFile(join(dir, "SKILL.md"), "utf8");
            skills.push(parseSkill(dir, name, raw));
        } catch (err) {
            console.error(`技能 ${name} 加载失败：${(err as Error).message}`);
        }
    }
    return skills;
}

export function listSkills(): readonly Skill[] {
    return skills;
}

export function activeSkill(): Skill | null {
    return active;
}

/** 卸载当前技能自带工具并恢复默认工具可见性；active 置空。 */
function deactivateSkill(): void {
    if (!active) return;
    for (const tool of active.tools) unregisterTool(tool.name);
    active = null;
    setVisibleTools(null);
}

/**
 * 激活技能：加载自带工具、补默认策略，全部校验通过后才替换旧技能
 * （卸载旧的 → 注册新的 → 收敛可见工具），任何一步失败都保持原状，不会半激活。
 */
export async function useSkill(name: string): Promise<void> {
    const skill = skills.find((s) => s.name === name);
    if (!skill) throw new Error(`未知技能：${name}`);
    if (active?.name === name) return; // 重复加载当前技能：无事可做
    skill.tools = await loadSkillTools(skill.dir); // 延迟到真正 /use 才执行技能代码

    // 先把冲突与策略全部处理好，再开始改注册表状态
    const currentTools = new Set(active?.tools.map((t) => t.name) ?? []);
    const incoming = new Set<string>();
    for (const tool of skill.tools) {
        // 与内置/其他在册工具重名，或技能自带工具互相重名，都拒绝加载
        if (incoming.has(tool.name) || (!currentTools.has(tool.name) && hasTool(tool.name))) {
            throw new Error(`工具 ${tool.name} 命名冲突，无法加载技能 ${name}`);
        }
        incoming.add(tool.name);
        await ensureToolPolicy(tool.name, "ask"); // 技能工具默认 ask，用户可自行在配置里改 allow
    }

    deactivateSkill(); // 先卸载旧技能，同名的自带工具由此腾出位置
    for (const tool of skill.tools) registerTool(tool);
    setVisibleTools(skill.builtinTools.length > 0 ? [...skill.builtinTools, ...skill.tools.map((t) => t.name)] : null);
    active = skill;
}

export function unuseSkill(): void {
    deactivateSkill();
}
