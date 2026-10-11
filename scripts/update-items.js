#!/usr/bin/env node

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_URL = "https://arctracker.io/api/items";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const targetDir = path.join(repoRoot, "items");

async function run() {
  const response = await fetch(API_URL);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${API_URL}: ${response.status} ${response.statusText}`
    );
  }

  const payload = await response.json();

  if (!Array.isArray(payload.items)) {
    throw new Error("API payload missing items array");
  }

  await mkdir(targetDir, { recursive: true });

  let updated = 0;
  let added = 0;

  for (const remoteItem of payload.items) {
    const id = remoteItem?.id;
    if (!id) continue;

    const filePath = path.join(targetDir, `${id}.json`);

    let localItem = null;
    try {
      localItem = JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    if (localItem === null) {
      await writeFile(filePath, `${JSON.stringify(remoteItem, null, 2)}\n`);
      added += 1;
      continue;
    }

    const merged = { ...localItem, ...remoteItem };

    if (JSON.stringify(merged) !== JSON.stringify(localItem)) {
      await writeFile(filePath, `${JSON.stringify(merged, null, 2)}\n`);
      updated += 1;
    }
  }

  if (updated === 0 && added === 0) {
    console.log("No item changes detected");
    return;
  }

  console.log(`Updated items: ${updated} item(s) changed, ${added} item(s) added`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
