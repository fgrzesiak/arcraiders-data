#!/usr/bin/env node
// Builds a structured changelog entry by comparing the game data at two git refs.
//
//   node scripts/build-changelog.mjs --from <ref> --to <ref> [--date YYYY-MM-DD] [--dry]
//
// Writes changelog/<date>.json (suffixed -2, -3, … when the date already has an
// entry) and prepends it to changelog/index.json. Only gameplay-relevant fields
// are compared, and a field is only reported as changed when it exists on both
// sides, so data enrichment (a source adding fields) does not show up as a patch.
// Exits without writing when nothing relevant changed.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "changelog");
const AGGREGATE_FILE = /^all(_\d+)?\.json$/i;

const ITEM_FIELDS = [
  "type",
  "rarity",
  "value",
  "weightKg",
  "stackSize",
  "recyclesInto",
  "salvagesInto",
  "recipe",
  "craftBench",
  "craftQuantity",
  "stationLevelRequired",
  "upgradeCost",
  "blueprintLocked"
];
const QUEST_FIELDS = [
  "requiredItemIds",
  "rewardItemIds",
  "xp",
  "trader",
  "map"
];

function parseArgs(argv) {
  const args = { dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry") args.dry = true;
    else if (a.startsWith("--")) args[a.slice(2)] = argv[++i];
  }
  if (!args.from || !args.to) {
    console.error(
      "Usage: build-changelog.mjs --from <ref> --to <ref> [--date YYYY-MM-DD] [--dry]"
    );
    process.exit(1);
  }
  return args;
}

function git(args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024
  });
}

/** Reads many `<ref>:<path>` blobs in one `git cat-file --batch` call. */
function readBlobs(ref, paths) {
  if (paths.length === 0) return new Map();
  const input = paths.map((p) => `${ref}:${p}`).join("\n") + "\n";
  const out = execFileSync("git", ["cat-file", "--batch"], {
    cwd: ROOT,
    input,
    maxBuffer: 512 * 1024 * 1024
  });
  const result = new Map();
  let offset = 0;
  for (const p of paths) {
    const headerEnd = out.indexOf(0x0a, offset);
    const header = out.subarray(offset, headerEnd).toString("utf8");
    offset = headerEnd + 1;
    if (header.endsWith(" missing")) continue;
    const size = Number(header.split(" ")[2]);
    result.set(p, out.subarray(offset, offset + size).toString("utf8"));
    offset += size + 1;
  }
  return result;
}

function listJson(ref, dir) {
  let out = "";
  try {
    out = git(["ls-tree", "--name-only", `${ref}:${dir}`]);
  } catch {
    return [];
  }
  return out
    .split("\n")
    .filter((f) => f.endsWith(".json") && !AGGREGATE_FILE.test(f))
    .map((f) => `${dir}/${f}`);
}

function parse(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    console.warn(`[changelog] Skip invalid JSON: ${label}`);
    return null;
  }
}

function readDir(ref, dir) {
  const blobs = readBlobs(ref, listJson(ref, dir));
  return [...blobs]
    .map(([p, text]) => parse(text, `${ref}:${p}`))
    .filter(Boolean);
}

function readFile(ref, file) {
  const text = readBlobs(ref, [file]).get(file);
  return text ? parse(text, `${ref}:${file}`) : null;
}

function snapshot(ref) {
  return {
    items: readDir(ref, "items"),
    quests: readDir(ref, "quests"),
    hideout: readDir(ref, "hideout"),
    projects: readFile(ref, "projects.json") ?? [],
    maps: readFile(ref, "maps.json") ?? []
  };
}

/** Stable stringify so key order never counts as a change. */
function canon(value) {
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const enName = (entry) =>
  typeof entry?.name === "string" ? entry.name : (entry?.name?.en ?? entry?.id);

/**
 * Strips what the source adds without a gameplay meaning: extra flags on item
 * references (questItem) and 0 as a "not filled in yet" placeholder.
 */
function normalize(value) {
  if (value === 0 || value === null) return undefined;
  if (Array.isArray(value)) {
    return value.map((v) =>
      v && typeof v === "object" && "itemId" in v
        ? { itemId: v.itemId, quantity: v.quantity }
        : v
    );
  }
  return value;
}

function diffFields(before, after, fields) {
  const changes = [];
  for (const field of fields) {
    const from = normalize(before[field]);
    const to = normalize(after[field]);
    if (from === undefined || to === undefined) continue;
    if (canon(from) !== canon(to)) changes.push({ field, from, to });
  }
  return changes;
}

function byKey(list, key) {
  return new Map(list.filter((e) => e?.[key]).map((e) => [e[key], e]));
}

function diffItems(before, after) {
  const prev = byKey(before, "id");
  const next = byKey(after, "id");
  const added = [];
  const removed = [];
  const changed = [];

  for (const [id, item] of next) {
    const old = prev.get(id);
    if (!old) {
      added.push(id);
      continue;
    }
    const changes = diffFields(old, item, ITEM_FIELDS);
    if (!old.phasedOut && item.phasedOut)
      changes.push({ field: "phasedOut", from: false, to: true });
    if (enName(old) !== enName(item))
      changes.push({ field: "name", from: enName(old), to: enName(item) });
    if (changes.length) changed.push({ id, changes });
  }
  for (const [id, item] of prev) {
    if (!next.has(id)) removed.push({ id, name: item.name ?? id });
  }

  // An id that disappears while a new id with the same name appears is a
  // rename in the source, not a new item.
  const removedNames = new Set(removed.map((r) => enName(r).toLowerCase()));
  const renamed = new Set(
    added.filter((id) => removedNames.has(enName(next.get(id)).toLowerCase()))
  );
  const renamedNames = new Set(
    [...renamed].map((id) => enName(next.get(id)).toLowerCase())
  );
  return {
    added: added.filter((id) => !renamed.has(id)).sort(),
    removed: removed.filter((r) => !renamedNames.has(enName(r).toLowerCase())),
    changed
  };
}

/**
 * Quests are matched by slug: the source renames ids (a_bad_feeling → ss5).
 * Older data has no slug, so it is derived from the id the same way.
 */
function diffQuests(before, after) {
  const key = (q) =>
    q.slug ?? String(q.id).replace(/^\d+_/, "").replace(/_/g, "-");
  const prev = new Map(before.map((q) => [key(q), q]));
  const next = new Map(after.map((q) => [key(q), q]));
  const added = [];
  const removed = [];
  const changed = [];

  for (const [slug, quest] of next) {
    const old = prev.get(slug);
    if (!old) {
      added.push({ id: quest.id, slug });
      continue;
    }
    const changes = diffFields(old, quest, QUEST_FIELDS);
    if (changes.length) changed.push({ id: quest.id, slug, changes });
  }
  for (const [slug, quest] of prev) {
    if (!next.has(slug))
      removed.push({ id: quest.id, slug, name: quest.name ?? slug });
  }
  return { added, removed, changed };
}

function diffHideout(before, after) {
  const prev = byKey(before, "id");
  const changed = [];
  for (const station of after) {
    const old = prev.get(station.id);
    if (!old) continue;
    const oldLevels = new Map((old.levels ?? []).map((l) => [l.level, l]));
    for (const level of station.levels ?? []) {
      const oldLevel = oldLevels.get(level.level);
      const from = oldLevel
        ? normalize(oldLevel.requirementItemIds ?? [])
        : null;
      const to = normalize(level.requirementItemIds ?? []);
      if (oldLevel ? canon(from) === canon(to) : to.length === 0) continue;
      changed.push({ id: station.id, level: level.level, from, to });
    }
  }
  return { changed };
}

function diffById(before, after) {
  const prev = byKey(before, "id");
  const next = byKey(after, "id");
  const added = [...next.keys()].filter((id) => !prev.has(id));
  const removed = [...prev.keys()].filter((id) => !next.has(id));
  const changed = [...next.keys()].filter(
    (id) =>
      prev.has(id) &&
      canon(prev.get(id).phases ?? null) !== canon(next.get(id).phases ?? null)
  );
  return { added, removed, changed };
}

function isEmpty(entry) {
  const { items, quests, hideout, projects, maps } = entry;
  return (
    items.added.length +
      items.removed.length +
      items.changed.length +
      quests.added.length +
      quests.removed.length +
      quests.changed.length +
      hideout.changed.length +
      projects.added.length +
      projects.changed.length +
      maps.added.length ===
    0
  );
}

function counts(entry) {
  return {
    newItems: entry.items.added.length,
    newQuests: entry.quests.added.length,
    newMaps: entry.maps.added.length,
    newProjects: entry.projects.added.length,
    changes:
      entry.items.changed.length +
      entry.quests.changed.length +
      entry.hideout.changed.length +
      entry.projects.changed.length,
    removed: entry.items.removed.length + entry.quests.removed.length
  };
}

function nextId(date, index) {
  const taken = new Set(index.map((e) => e.id));
  if (!taken.has(date)) return date;
  let n = 2;
  while (taken.has(`${date}-${n}`)) n++;
  return `${date}-${n}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const fromSha = git(["rev-parse", args.from]).trim();
  const toSha = git(["rev-parse", args.to]).trim();
  const date = args.date ?? git(["log", "-1", "--format=%cs", toSha]).trim();

  const before = snapshot(fromSha);
  const after = snapshot(toSha);

  const entry = {
    date,
    from: fromSha,
    to: toSha,
    items: diffItems(before.items, after.items),
    quests: diffQuests(before.quests, after.quests),
    hideout: diffHideout(before.hideout, after.hideout),
    projects: diffById(before.projects, after.projects),
    maps: { added: diffById(before.maps, after.maps).added }
  };

  if (isEmpty(entry)) {
    console.log("[changelog] No gameplay-relevant changes.");
    return;
  }

  const indexPath = path.join(OUT_DIR, "index.json");
  const index = existsSync(indexPath)
    ? JSON.parse(readFileSync(indexPath, "utf8"))
    : [];
  if (index.some((e) => e.to === toSha)) {
    console.log(`[changelog] ${toSha} already has an entry.`);
    return;
  }

  const id = nextId(date, index);
  const full = { id, ...entry };
  const summary = { id, date, to: toSha, counts: counts(entry) };
  console.log(`[changelog] ${id}:`, JSON.stringify(summary.counts));

  if (args.dry) return;
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    path.join(OUT_DIR, `${id}.json`),
    JSON.stringify(full, null, 2) + "\n"
  );
  const nextIndex = [summary, ...index].sort(
    (a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)
  );
  writeFileSync(indexPath, JSON.stringify(nextIndex, null, 2) + "\n");

  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `id=${id}\n`, { flag: "a" });
  }
}

main();
