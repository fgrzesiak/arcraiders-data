#!/usr/bin/env node

/**
 * Sync ARC enemies (bots.json) from arctracker.io.
 *
 * arctracker.io has no API for ARCs, so this reads the public, server-rendered
 * pages (robots.txt allows them): the list page per locale for official names,
 * and one English detail page per ARC for facts (drops, spawns, toughness,
 * attacks, perception). Descriptive texts are NOT copied – only facts.
 *
 * Hand-maintained fields in bots.json (description, weakness, type, threat,
 * destroyXp, lootXp) are preserved; scraped fields are refreshed.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafeToPrune } from "./lib/sync-utils.js";

const BASE_URL = "https://arctracker.io";
const USER_AGENT =
  "arcraiders-data-sync (+https://github.com/fgrzesiak/arcraiders-data)";
const REQUEST_DELAY_MS = 400;

/** Locales of the consuming app (en is scraped as the base). */
const LOCALES = [
  "da",
  "de",
  "es",
  "fr",
  "hr",
  "it",
  "ja",
  "ko",
  "no",
  "pl",
  "pt",
  "ru",
  "sr",
  "tr",
  "uk"
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const targetPath = path.join(repoRoot, "bots.json");
const mapEventsPath = path.join(repoRoot, "map-events", "map-events.json");

/** arctracker map slug -> maps.json id */
const MAP_IDS = {
  "dam-battleground": "dam_battlegrounds",
  "the-spaceport": "the_spaceport",
  "buried-city": "buried_city",
  "blue-gate": "the_blue_gate",
  "stella-montis": "stella_montis",
  "riven-tides": "riven_tides",
  "pendola-pass": "pendola_pass"
};

/** arctracker slug -> existing bots.json id (keeps app URLs stable) */
const LEGACY_IDS = { queen: "arc_the_queen" };

const TIERS = {
  Fragile: "fragile",
  Light: "light",
  Sturdy: "sturdy",
  Heavy: "heavy",
  Boss: "boss"
};
const MOVEMENT = { Patrols: "patrol", "Stays in place": "static" };
const PLATING = {
  "Light plating": "light",
  "Medium plating": "medium",
  "Heavy plating": "heavy",
  "Head plating": "head",
  "Body plating": "body",
  "Core plating": "core",
  Plating: "any"
};
const PARTS = {
  Core: "core",
  Head: "head",
  Weapon: "weapon",
  Arm: "arm",
  Legs: "leg",
  Joints: "joint",
  Thrusters: "thruster",
  Flaps: "flap",
  Spinner: "spinner",
  Antenna: "antenna",
  Radar: "radar",
  Eye: "eye",
  Actuators: "actuator",
  Claws: "claw",
  Hatch: "hatch"
};
const ATTACKS = {
  Gun: "gun",
  Flamethrower: "flamethrower",
  Mortar: "mortar",
  "Shock weapon": "taser",
  Railgun: "railgun",
  Missiles: "missiles",
  Laser: "laser",
  Shockwave: "shockwave",
  Blast: "blast",
  Melee: "melee",
  Explosion: "explosion",
  "Core burst": "coreBurst"
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchHtml(url) {
  await sleep(REQUEST_DELAY_MS);
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${url}: ${response.status} ${response.statusText}`
    );
  }
  return response.text();
}

// --- tiny HTML helpers (the pages are server-rendered with stable data-* hooks)

const decode = (s) =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Inner HTML of the <section data-arc-NAME="true"> block, or "". */
function section(html, name) {
  const start = html.indexOf(`data-arc-${name}="true"`);
  if (start < 0) return "";
  const end = html.indexOf("</section>", start);
  return html.slice(start, end < 0 ? undefined : end);
}

const all = (re, s) => [...s.matchAll(re)];
const pills = (s) =>
  all(/<span class="arc-pill[^"]*">([\s\S]*?)<\/span>/g, s).map((m) =>
    decode(m[1])
  );
const toInt = (s) => {
  const n = parseInt(String(s).replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : undefined;
};
const toNum = (s) => {
  const n = parseFloat(String(s).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : undefined;
};

/** <dt>label</dt><dd>value</dd> pairs of a section. */
const definitions = (s) =>
  all(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g, s).map((m) => [
    decode(m[1]),
    decode(m[2])
  ]);

function idForSlug(slug) {
  if (LEGACY_IDS[slug]) return LEGACY_IDS[slug];
  return slug.startsWith("arc-")
    ? slug.replace(/-/g, "_")
    : `arc_${slug.replace(/-/g, "_")}`;
}

/** Serbian on arctracker is Latin; the app uses Cyrillic. */
function serbianToCyrillic(text) {
  const pairs = [
    ["Lj", "Љ"],
    ["LJ", "Љ"],
    ["lj", "љ"],
    ["Nj", "Њ"],
    ["NJ", "Њ"],
    ["nj", "њ"],
    ["Dž", "Џ"],
    ["DŽ", "Џ"],
    ["dž", "џ"]
  ];
  const single = {
    A: "А",
    B: "Б",
    V: "В",
    G: "Г",
    D: "Д",
    Đ: "Ђ",
    E: "Е",
    Ž: "Ж",
    Z: "З",
    I: "И",
    J: "Ј",
    K: "К",
    L: "Л",
    M: "М",
    N: "Н",
    O: "О",
    P: "П",
    R: "Р",
    S: "С",
    T: "Т",
    Ć: "Ћ",
    U: "У",
    F: "Ф",
    H: "Х",
    C: "Ц",
    Č: "Ч",
    Š: "Ш"
  };
  let out = text;
  for (const [latin, cyr] of pairs) out = out.split(latin).join(cyr);
  return [...out]
    .map((ch) => {
      const upper = single[ch];
      if (upper) return upper;
      const lower = single[ch.toUpperCase()];
      return lower && ch !== ch.toUpperCase() ? lower.toLowerCase() : ch;
    })
    .join("");
}

/** Normalizes localized display names (quote marks, script). */
function cleanName(name, lang) {
  const plain = name
    .replace(/[«»„“”"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (lang !== "sr") return plain;
  // Keep the brand "ARC" in Latin letters.
  return plain
    .split(/(ARC)/)
    .map((part) => (part === "ARC" ? part : serbianToCyrillic(part)))
    .join("");
}

// --- parsing

/** { slug: { name, image } } from a (localized) /arc list page. */
function parseList(html, prefix) {
  const cards = {};
  const re = new RegExp(
    `<a data-arc-card="([a-z0-9-]+)"[^>]*href="${prefix}/arc/\\1"[^>]*>([\\s\\S]*?)</a>`,
    "g"
  );
  for (const [, slug, inner] of html.matchAll(re)) {
    const name = inner.match(
      /<span class="text-base font-semibold[^"]*">([\s\S]*?)<\/span>/
    );
    const image = inner.match(
      /https:\/\/cdn\.arctracker\.io\/arcs\/[a-z0-9-]+\.(?:webp|png)/
    );
    if (name) cards[slug] = { name: decode(name[1]), image: image?.[0] };
  }
  return cards;
}

function parseEventIds(text, eventIdsByName) {
  return text
    .split(/,| and | & /)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((name) => eventIdsByName.get(name.toLowerCase()) ?? name);
}

function parseDetail(html, eventIdsByName) {
  const out = {};

  // Category pills in the header, e.g. ["Ground", "Heavy"]
  const actionsAt = html.indexOf('class="arc-page-actions"');
  const header =
    actionsAt < 0
      ? ""
      : html.slice(actionsAt, html.indexOf("</header>", actionsAt));
  out.tags = pills(header);

  // Spawns per map
  const spawnHtml = section(html, "spawns");
  out.spawns = all(
    /<li[^>]*data-map="([a-z0-9-]+)"[^>]*>([\s\S]*?)<\/li>/g,
    spawnHtml
  ).map(([, mapSlug, li]) => {
    const spawn = { map: MAP_IDS[mapSlug] ?? mapSlug.replace(/-/g, "_") };
    const sites = li.match(/tabular-nums[^>]*>([\s\S]*?)<\/span>/);
    if (sites) spawn.sites = toInt(decode(sites[1]));
    for (const pill of pills(li)) {
      if (MOVEMENT[pill]) spawn.movement = MOVEMENT[pill];
      else if (pill.startsWith("More during "))
        spawn.moreDuring = parseEventIds(pill.slice(12), eventIdsByName);
      else if (pill.startsWith("Only during "))
        spawn.onlyDuring = parseEventIds(pill.slice(12), eventIdsByName);
      else if (pill === "Only with other ARC") spawn.escortOnly = true;
    }
    return spawn;
  });

  // Drops
  out.drops = [
    ...new Set(
      all(/href="\/items\/([a-z0-9_]+)"/g, section(html, "drops")).map(
        (m) => m[1]
      )
    )
  ];

  // Toughness: aria-label "Heavy: tier 4 of 5" + "6th toughest of 24"
  const toughHtml = section(html, "toughness");
  const tier = toughHtml.match(/aria-label="([A-Za-z]+): tier (\d+) of (\d+)"/);
  const rank = decode(toughHtml).match(/(\d+)\w* toughest of (\d+)/);
  if (tier) {
    out.toughness = {
      tier: TIERS[tier[1]] ?? tier[1].toLowerCase(),
      step: Number(tier[2]),
      steps: Number(tier[3]),
      ...(rank ? { rank: Number(rank[1]), of: Number(rank[2]) } : {})
    };
  }

  // Armor plates, destructible parts, weak point
  const armorHtml = section(html, "armor");
  const groups = armorHtml.split("<h3");
  for (const group of groups) {
    const heading = decode(
      group.slice(0, group.indexOf("</h3>")).replace(/^[^>]*>/, "")
    );
    if (heading === "Armor plates")
      out.plating = pills(group).map((p) => PLATING[p] ?? p);
    if (heading === "Destructible parts")
      out.parts = pills(group).map((p) => PARTS[p] ?? p);
  }
  out.weakPointMarked = armorHtml.includes("marks a weak point");

  // Attacks: [{ kind, damage }]
  out.attacks = definitions(section(html, "attacks")).map(([label, value]) => ({
    kind: ATTACKS[label] ?? label,
    damage: toNum(value)
  }));

  // Perception
  const perception = Object.fromEntries(
    definitions(section(html, "perception"))
  );
  if (Object.keys(perception).length > 0) {
    out.perception = {
      spotsFromM: toNum(perception["Spots you from"]),
      losesBeyondM: toNum(perception["Loses you beyond"]),
      fieldOfViewDeg: toNum(perception["Field of view"])
    };
  }

  // Related ARC
  const relatedHtml = section(html, "related");
  out.related = [
    ...new Set(
      all(/href="\/arc\/([a-z0-9-]+)"/g, relatedHtml).map((m) =>
        idForSlug(m[1])
      )
    )
  ];

  return out;
}

async function loadEventIdsByName() {
  const byName = new Map();
  try {
    const { eventTypes = {} } = JSON.parse(
      await readFile(mapEventsPath, "utf8")
    );
    for (const [id, type] of Object.entries(eventTypes)) {
      if (type?.displayName)
        byName.set(String(type.displayName).toLowerCase(), id);
    }
  } catch {
    // map events are optional; unknown names are kept as text
  }
  return byName;
}

async function run() {
  const existing = JSON.parse(await readFile(targetPath, "utf8"));
  const byId = new Map(existing.map((bot) => [bot.id, bot]));
  const eventIdsByName = await loadEventIdsByName();

  const enList = parseList(await fetchHtml(`${BASE_URL}/arc`), "");
  const slugs = Object.keys(enList);
  assertSafeToPrune("arcs", existing.length, slugs.length);

  const names = {}; // slug -> { lang: name }
  for (const lang of LOCALES) {
    const list = parseList(
      await fetchHtml(`${BASE_URL}/${lang}/arc`),
      `/${lang}`
    );
    for (const [slug, card] of Object.entries(list)) {
      // Identical to English = not translated upstream (e.g. uk, sr); skip so
      // the app can fall back to its own translation instead of a transliteration.
      if (card.name === enList[slug]?.name) continue;
      (names[slug] ??= {})[lang] = cleanName(card.name, lang);
    }
  }

  let added = 0;
  let updated = 0;
  for (const slug of slugs) {
    const id = idForSlug(slug);
    const detail = parseDetail(
      await fetchHtml(`${BASE_URL}/arc/${slug}`),
      eventIdsByName
    );
    const previous = byId.get(id) ?? { id };

    const next = {
      ...previous,
      name: enList[slug].name,
      nameTranslations: { en: enList[slug].name, ...names[slug] },
      arctrackerSlug: slug,
      image: enList[slug].image ?? previous.image,
      ...detail,
      // Hand-maintained map list stays if arctracker lists no spawns (escorts, bosses).
      maps:
        detail.spawns.length > 0
          ? [...new Set(detail.spawns.map((s) => s.map))]
          : (previous.maps ?? []),
      drops: detail.drops.length > 0 ? detail.drops : (previous.drops ?? [])
    };

    if (!byId.has(id)) added += 1;
    else if (JSON.stringify(next) !== JSON.stringify(previous)) updated += 1;
    byId.set(id, next);
  }

  // ARCs that vanished upstream are kept (the game rarely removes enemies).
  const result = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  await writeFile(targetPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    `ARCs: ${slugs.length} upstream, ${added} added, ${updated} updated, ${result.length} total`
  );
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
