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
const MAX_CHUNK_BYTES = Number.parseInt(
  process.env.AGGREGATE_MAX_CHUNK_BYTES || "1800000",
  10
); // ~1.8MB default

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
    .filter((f) => f.toLowerCase() !== "all.json")
    .sort((a, b) => a.localeCompare(b, "en"));
  const out = [];
  for (const f of files) {
    const p = path.join(dirPath, f);
    try {
      const raw = await readFile(p, "utf8");
      const json = JSON.parse(raw);
      if (json && typeof json === "object") out.push(json);
    } catch (e) {
      console.warn(`[aggregate] Skip invalid JSON: ${dir}/${f}`, e.message);
    }
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
 * Produces all_1.json, all_2.json, ... and handles an all.json helper.
 * - If only one chunk: write all.json as the array (backward compatible)
 * - If multiple chunks: write all.json as a small manifest { chunks, count, version?, maxChunkBytes }
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
  let current = [];

  const fitsWith = (arr, item) => {
    try {
      const s = JSON.stringify([...arr, item], null, 2) + "\n";
      return Buffer.byteLength(s, "utf8") <= MAX_CHUNK_BYTES;
    } catch {
      return false;
    }
  };

  for (const v of values) {
    if (current.length === 0) {
      current.push(v);
      // Edge: single item larger than limit — allow it as a single-item chunk.
      // We still proceed; consumers should handle rare oversize items.
      continue;
    }
    if (fitsWith(current, v)) {
      current.push(v);
    } else {
      chunkArrays.push(current);
      current = [v];
    }
  }
  if (current.length) chunkArrays.push(current);

  const chunkFiles = [];
  for (let i = 0; i < chunkArrays.length; i++) {
    const chunkName = `all_${i + 1}.json`;
    await writeJson(path.join(dir, chunkName), chunkArrays[i]);
    chunkFiles.push(chunkName);
  }

  if (chunkArrays.length === 1) {
    // Backward compatible: write all.json with the single chunk's array
    await writeJson(path.join(dir, "all.json"), chunkArrays[0]);
  } else {
    // Write a small manifest for discovery
    const manifest = {
      chunks: chunkFiles,
      count: values.length,
      maxChunkBytes: MAX_CHUNK_BYTES,
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
