import { readdir, unlink } from "node:fs/promises";
import path from "node:path";

// Aggregated outputs (all.json, all_1.json, …) are managed by aggregate.mjs.
const AGGREGATE_FILE = /^all(_\d+)?\.json$/i;

/**
 * Refuse to prune when the API suddenly returns far fewer entries than exist
 * locally (outage, partial response, schema change). Deleting most of the
 * dataset is never a legitimate sync result.
 */
export function assertSafeToPrune(
  label,
  localCount,
  remoteCount,
  minRatio = 0.5
) {
  if (remoteCount === 0 || remoteCount < localCount * minRatio) {
    throw new Error(
      `[${label}] Refusing to prune: API returned ${remoteCount} entries but ${localCount} exist locally.`
    );
  }
}

/**
 * Delete `<id>.json` files in `dir` whose id is no longer delivered by the API.
 * Without this, renamed entries (e.g. quest `a_bad_feeling` → `ss5`) linger
 * forever next to their replacements and show up as duplicates.
 *
 * @returns {Promise<string[]>} the removed ids
 */
export async function pruneStaleFiles(dir, remoteIds, label) {
  const keep = new Set(remoteIds);
  const files = (await readdir(dir)).filter(
    (f) => f.toLowerCase().endsWith(".json") && !AGGREGATE_FILE.test(f)
  );

  assertSafeToPrune(label, files.length, keep.size);

  const removed = [];
  for (const file of files) {
    const id = file.slice(0, -".json".length);
    if (keep.has(id)) continue;
    await unlink(path.join(dir, file));
    removed.push(id);
  }

  if (removed.length > 0) {
    console.log(
      `[${label}] Removed ${removed.length} stale file(s): ${removed.join(", ")}`
    );
  }
  return removed;
}
