import { dirname, resolve } from "node:path";
import { SessionData } from "./sessions";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const SESSION_FILE = resolve(".kagent/sessions.json");

export async function saveSessions(data: SessionData): Promise<string> {
    await mkdir(dirname(SESSION_FILE), { recursive: true });
    await writeFile(SESSION_FILE, JSON.stringify(data, null, 2) + "\n", "utf8");
    return SESSION_FILE;
}

export async function loadSessions(): Promise<{ data: unknown; file: string }> {
    return { data: JSON.parse(await readFile(SESSION_FILE, "utf8")), file: SESSION_FILE };
}
