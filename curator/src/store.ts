// Append-only JSONL files under data/. Snapshots feed the signals; proposals
// are the shadow-mode record that earns, or does not earn, the allocator key.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Snapshot } from "./observe";

const DIR = new URL("../data/", import.meta.url).pathname;

export async function append(file: string, record: unknown): Promise<void> {
  await mkdir(DIR, { recursive: true });
  await appendFile(DIR + file, JSON.stringify(record) + "\n");
}

export async function readAll<T>(file: string): Promise<T[]> {
  const path = DIR + file;
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8");
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
}

export async function history(label: string): Promise<Snapshot[]> {
  return (await readAll<Snapshot>("snapshots.jsonl")).filter((s) => s.label === label);
}
