#!/usr/bin/env node
// Aggregates per-file JSON directories into single files for fast consumption.
// Intended for the arcraiders-data fork repo.
// - Generates per-directory: items/all.json, quests/all.json, hideout/all.json
// - Generates legacy root files: items.json (with { version, items }), quests.json, hideoutModules.json
// Version is sourced from env.GITHUB_SHA if available.

import { readdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const VERSION = process.env.GITHUB_SHA || null;
// Count-based chunking configuration
const MAX_ITEMS_PER_FILE = Number.parseInt(
  process.env.AGGREGATE_MAX_ITEMS_PER_FILE || "100",
  10
); // Hard limit per file
const MIN_ITEMS_PER_FILE = Number.parseInt(
  process.env.AGGREGATE_MIN_ITEMS_PER_FILE || "10",
  10
); // Minimum for last file; rest gets merged into previous

/**
 * Read all direct child JSON files of a directory, excluding all.json (if present).
 * Returns array of parsed objects, sorted by filename for stability.
 */
async function readJsonDir(dir) {
  const dirPath = path.join(ROOT, dir);
  try {
    const s = await stat(dirPath);
    if (!s.isDirectory()) return [];
  } catch {
    return [];
  }
  const entries = await readdir(dirPath);
  const files = entries
    .filter((f) => f.toLowerCase().endsWith(".json"))
    // Exclude any previously aggregated files: all.json, all_#.json
    .filter((f) => !/^all(_\d+)?\.json$/i.test(f))
    .sort((a, b) => a.localeCompare(b, "en"));
  const out = [];
  const debugInfo = [];
  for (const f of files) {
    const p = path.join(dirPath, f);
    try {
      const raw = await readFile(p, "utf8");
      const json = JSON.parse(raw);
      if (json && typeof json === "object") {
        out.push(json);
        if (Array.isArray(json)) {
          debugInfo.push({ file: f, type: "array", length: json.length });
        } else {
          debugInfo.push({ file: f, type: typeof json });
        }
      }
    } catch (e) {
      console.warn(`[aggregate] Skip invalid JSON: ${dir}/${f}`, e.message);
    }
  }
  console.log(
    `[aggregate] readJsonDir(${dir}) files=${files.length} objects=${out.length}`
  );
  if (debugInfo.length) {
    console.log(`[aggregate] detail ${dir}:`, debugInfo.slice(0, 10));
    if (debugInfo.length > 10)
      console.log(`[aggregate] ... ${debugInfo.length - 10} more entries`);
  }
  return out;
}

async function writeJson(file, value) {
  const json = JSON.stringify(value, null, 2) + "\n";
  await writeFile(path.join(ROOT, file), json, "utf8");
}

/**
 * Remove previously generated all*.json files inside a directory.
 * Matches: all.json and all_#.json (case-insensitive).
 */
async function cleanAllFiles(dir) {
  const dirPath = path.join(ROOT, dir);
  try {
    const s = await stat(dirPath);
    if (!s.isDirectory()) return;
  } catch {
    return;
  }
  const entries = await readdir(dirPath);
  const targets = entries.filter((f) => /^all(_\d+)?\.json$/i.test(f));
  await Promise.all(
    targets.map(async (f) => {
      try {
        await rm(path.join(dirPath, f), { force: true });
      } catch {}
    })
  );
}

/**
 * Write an array into chunked JSON files inside a directory.
 * Count-based policy:
 *  - Max per file = MAX_ITEMS_PER_FILE (default 100)
 *  - Last file must have >= MIN_ITEMS_PER_FILE (default 10), otherwise leftover is merged into previous file
 * Produces all_1.json, all_2.json, ... and handles an all.json helper.
 * - If only one chunk: write all.json as the array (backward compatible)
 * - If multiple chunks: write all.json as a small manifest { chunks, count, policy, version? }
 * Returns list of chunk file names written.
 */
async function writeChunkedAll(dir, values) {
  if (!Array.isArray(values) || values.length === 0) return [];

  const dirPath = path.join(ROOT, dir);
  // Ensure directory exists (it should in repo). If not, bail.
  try {
    const s = await stat(dirPath);
    if (!s.isDirectory()) return [];
  } catch {
    return [];
  }

  const chunkArrays = [];
  const n = values.length;
  const full = Math.floor(n / MAX_ITEMS_PER_FILE);
  const rest = n % MAX_ITEMS_PER_FILE;
  console.log(
    `[aggregate] chunking ${dir}: total=${n} fullChunks=${full} rest=${rest}`
  );

  for (let i = 0; i < full; i++) {
    const start = i * MAX_ITEMS_PER_FILE;
    const end = start + MAX_ITEMS_PER_FILE;
    chunkArrays.push(values.slice(start, end));
  }

  if (rest > 0) {
    if (rest >= MIN_ITEMS_PER_FILE || chunkArrays.length === 0) {
      // Rest is acceptable as a separate chunk (or it's the only chunk)
      chunkArrays.push(values.slice(full * MAX_ITEMS_PER_FILE));
    } else {
      // Rest smaller than minimum: merge into previous chunk
      const lastIdx = chunkArrays.length - 1;
      const merged = chunkArrays[lastIdx].concat(
        values.slice(full * MAX_ITEMS_PER_FILE)
      );
      chunkArrays[lastIdx] = merged; // may exceed MAX_ITEMS_PER_FILE (up to +MIN-1)
    }
  }

  const chunkFiles = [];
  for (let i = 0; i < chunkArrays.length; i++) {
    const chunkName = `all_${i + 1}.json`;
    await writeJson(path.join(dir, chunkName), chunkArrays[i]);
    chunkFiles.push(chunkName);
  }
  console.log(
    `[aggregate] wrote ${dir} chunks:`,
    chunkArrays.map((c) => c.length)
  );

  if (chunkArrays.length === 1) {
    // Backward compatible: write all.json with the single chunk's array
    await writeJson(path.join(dir, "all.json"), chunkArrays[0]);
  } else {
    // Write a small manifest for discovery
    const manifest = {
      chunks: chunkFiles,
      count: values.length,
      policy: {
        type: "count",
        maxItemsPerFile: MAX_ITEMS_PER_FILE,
        minItemsPerFile: MIN_ITEMS_PER_FILE,
      },
      ...(VERSION ? { version: VERSION } : {}),
    };
    await writeJson(path.join(dir, "all.json"), manifest);
  }

  return chunkFiles;
}

async function aggregate() {
  const items = await readJsonDir("items");
  const quests = await readJsonDir("quests");
  const hideout = await readJsonDir("hideout");

  // Per-directory aggregates
  if (items.length > 0) {
    await cleanAllFiles("items");
    await writeChunkedAll("items", items);
  }
  if (quests.length > 0) {
    await cleanAllFiles("quests");
    await writeChunkedAll("quests", quests);
  }
  if (hideout.length > 0) {
    await cleanAllFiles("hideout");
    await writeChunkedAll("hideout", hideout);
  }

  // Legacy root files
  if (items.length > 0) {
    const legacy = VERSION ? { version: VERSION, items } : { items };
    await writeJson("items.json", legacy);
  }
  if (quests.length > 0) await writeJson("quests.json", quests);
  if (hideout.length > 0) await writeJson("hideoutModules.json", hideout);

  console.log("[aggregate] Done.");
}

aggregate().catch((e) => {
  console.error("[aggregate] Failed:", e);
  process.exit(1);
});
