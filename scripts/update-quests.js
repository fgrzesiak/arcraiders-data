#!/usr/bin/env node

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_URL = "https://arctracker.io/api/quests";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const targetDir = path.join(repoRoot, "quests");

async function run() {
  const response = await fetch(API_URL);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${API_URL}: ${response.status} ${response.statusText}`
    );
  }

  const payload = await response.json();

  if (!payload.quests || typeof payload.quests !== "object") {
    throw new Error("API payload missing quests object");
  }

  await mkdir(targetDir, { recursive: true });

  let updated = 0;
  let added = 0;

  for (const [id, remoteQuest] of Object.entries(payload.quests)) {
    const filePath = path.join(targetDir, `${id}.json`);

    let localQuest = null;
    try {
      localQuest = JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    if (localQuest === null) {
      await writeFile(filePath, `${JSON.stringify(remoteQuest, null, 2)}\n`);
      added += 1;
      continue;
    }

    const merged = { ...localQuest, ...remoteQuest };

    if (JSON.stringify(merged) !== JSON.stringify(localQuest)) {
      await writeFile(filePath, `${JSON.stringify(merged, null, 2)}\n`);
      updated += 1;
    }
  }

  if (updated === 0 && added === 0) {
    console.log("No quest changes detected");
    return;
  }

  console.log(
    `Updated quests: ${updated} quest(s) changed, ${added} quest(s) added`
  );
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
