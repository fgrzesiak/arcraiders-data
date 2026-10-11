#!/usr/bin/env node

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pruneStaleFiles } from "./lib/sync-utils.js";

const API_URL = "https://arctracker.io/api/hideout";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const targetDir = path.join(repoRoot, "hideout");

async function run() {
  const response = await fetch(API_URL);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${API_URL}: ${response.status} ${response.statusText}`
    );
  }

  const payload = await response.json();

  if (!payload.hideoutModules || typeof payload.hideoutModules !== "object") {
    throw new Error("API payload missing hideoutModules object");
  }

  await mkdir(targetDir, { recursive: true });

  let updated = 0;
  let added = 0;

  for (const [id, remoteModule] of Object.entries(payload.hideoutModules)) {
    const filePath = path.join(targetDir, `${id}.json`);

    let localModule = null;
    try {
      localModule = JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    if (localModule === null) {
      await writeFile(filePath, `${JSON.stringify(remoteModule, null, 2)}\n`);
      added += 1;
      continue;
    }

    const merged = { ...localModule, ...remoteModule };

    if (JSON.stringify(merged) !== JSON.stringify(localModule)) {
      await writeFile(filePath, `${JSON.stringify(merged, null, 2)}\n`);
      updated += 1;
    }
  }

  // Remove entries the API no longer delivers (renamed/removed upstream).
  const removed = await pruneStaleFiles(
    targetDir,
    Object.keys(payload.hideoutModules),
    "hideout"
  );

  if (updated === 0 && added === 0 && removed.length === 0) {
    console.log("No hideout module changes detected");
    return;
  }

  console.log(
    `Updated hideout modules: ${updated} module(s) changed, ${added} module(s) added, ${removed.length} module(s) removed`
  );
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
