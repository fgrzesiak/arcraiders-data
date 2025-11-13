#!/usr/bin/env node
// Aggregates per-file JSON directories into single files for fast consumption.
// Intended for the arcraiders-data fork repo.
// - Generates per-directory: items/all.json, quests/all.json, hideout/all.json
// - Generates legacy root files: items.json (with { version, items }), quests.json, hideoutModules.json
// Version is sourced from env.GITHUB_SHA if available.

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const VERSION = process.env.GITHUB_SHA || null;

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
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .filter((f) => f.toLowerCase() !== 'all.json')
    .sort((a, b) => a.localeCompare(b, 'en'));
  const out = [];
  for (const f of files) {
    const p = path.join(dirPath, f);
    try {
      const raw = await readFile(p, 'utf8');
      const json = JSON.parse(raw);
      if (json && typeof json === 'object') out.push(json);
    } catch (e) {
      console.warn(`[aggregate] Skip invalid JSON: ${dir}/${f}`, e.message);
    }
  }
  return out;
}

async function writeJson(file, value) {
  const json = JSON.stringify(value, null, 2) + '\n';
  await writeFile(path.join(ROOT, file), json, 'utf8');
}

async function aggregate() {
  const items = await readJsonDir('items');
  const quests = await readJsonDir('quests');
  const hideout = await readJsonDir('hideout');

  // Per-directory aggregates
  if (items.length > 0) await writeJson('items/all.json', items);
  if (quests.length > 0) await writeJson('quests/all.json', quests);
  if (hideout.length > 0) await writeJson('hideout/all.json', hideout);

  // Legacy root files
  if (items.length > 0) {
    const legacy = VERSION ? { version: VERSION, items } : { items };
    await writeJson('items.json', legacy);
  }
  if (quests.length > 0) await writeJson('quests.json', quests);
  if (hideout.length > 0) await writeJson('hideoutModules.json', hideout);

  console.log('[aggregate] Done.');
}

aggregate().catch((e) => {
  console.error('[aggregate] Failed:', e);
  process.exit(1);
});
