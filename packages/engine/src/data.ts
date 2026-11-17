import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DictionaryMode } from "../../shared/src/index.ts";

/** A point in the 1024-unit glyph coordinate system ([x, y]). */
export type Point = [number, number];

/** Raw data for one Chinese character inside `datasets/strokes.json`. */
export interface StrokeEntry {
  /** SVG path data, one entry per stroke. */
  strokes: string[];
  /** Polyline approximation of every stroke (same order as `strokes`). */
  medians: Point[][];
  /** Optional indexes of strokes that belong to the radical part of the glyph. */
  radStrokes?: number[];
}

export interface GameData {
  /** All characters that have stroke data (9574 in the shipped dataset). */
  strokes: Record<string, StrokeEntry>;
  /** Every usable idiom used as an answer (~29406 = 29957 minus 550 with missing strokes). */
  answerPool: string[];
  /** Common idioms whose four characters all have stroke data (~7208); kept for reference. */
  commonPool: string[];
  /** Every idiom usable as a guess (all four chars have stroke data, ~29406). */
  guessSet: Set<string>;
  /** Common idioms usable as a standard-mode guess (~7208). */
  commonSet: Set<string>;
  /** Every idiom present in `idioms.json`, whether renderable or not (29956 unique). */
  idiomSet: Set<string>;
  /** Cleaned one-line explanation for every idiom that ships with one. */
  explanations: Map<string, string>;
}

export interface LoadGameDataOptions {
  /** Folder that contains strokes.json / idioms.json / common-idioms.json. */
  datasetsDir?: string;
  /** Set to true to skip the module level cache and read everything again. */
  fresh?: boolean;
}

const DEFAULT_DATASETS_DIR = fileURLToPath(new URL("../../../datasets/", import.meta.url));

let defaultCache: GameData | null = null;

function readJson<T>(dir: string, name: string): T {
  const file = join(dir, name);
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function hasFourRenderableChars(word: string, strokes: Record<string, StrokeEntry>): boolean {
  if (typeof word !== "string" || Array.from(word).length !== 4) return false;
  for (const char of word) {
    if (!strokes[char]) return false;
  }
  return true;
}

const EXPLANATION_MAX = 80;

/**
 * Turn the raw dataset explanation (a multi-section block such as
 * `【解释】...\n【出处】...`) into a single short sentence for the sidebar.
 */
export function cleanExplanation(raw: string): string {
  let text = String(raw ?? "").replace(/\r/g, "");
  text = text.replace(/^\s*【解释】\s*/, "");
  // Keep only the explanation section: stop at a newline or another 【...】 tag.
  const stop = text.search(/\n|【/);
  if (stop >= 0) text = text.slice(0, stop);
  text = text.replace(/\s+/g, " ").trim();
  if (Array.from(text).length > EXPLANATION_MAX) {
    text = Array.from(text).slice(0, EXPLANATION_MAX - 1).join("") + "…";
  }
  return text;
}

/**
 * Load the three datasets shipped in `datasets/`.
 *
 * The result is cached per datasets directory, so calling this from several
 * modules (engine tests, server, scripts) only parses the 30 MB stroke file once.
 */
export function loadGameData(options: string | LoadGameDataOptions = {}): GameData {
  const opts: LoadGameDataOptions = typeof options === "string" ? { datasetsDir: options } : options;
  const dir = opts.datasetsDir ?? DEFAULT_DATASETS_DIR;
  if (!opts.fresh && defaultCache && dir === DEFAULT_DATASETS_DIR) {
    return defaultCache;
  }

  const strokes = readJson<Record<string, StrokeEntry>>(dir, "strokes.json");
  const idiomEntries = readJson<Array<{ idiom?: string; explanation?: string } | string>>(dir, "idioms.json");
  const commonIdioms = readJson<Array<string | { idiom?: string }>>(dir, "common-idioms.json");

  const idiomSet = new Set<string>();
  const explanations = new Map<string, string>();
  for (const entry of idiomEntries) {
    const word = typeof entry === "string" ? entry : entry?.idiom;
    if (typeof word === "string" && word.length > 0) {
      idiomSet.add(word);
      if (typeof entry === "object" && entry && typeof entry.explanation === "string") {
        const cleaned = cleanExplanation(entry.explanation);
        if (cleaned.length > 0 && !explanations.has(word)) explanations.set(word, cleaned);
      }
    }
  }

  const guessSet = new Set<string>();
  for (const word of idiomSet) {
    if (hasFourRenderableChars(word, strokes)) guessSet.add(word);
  }

  const commonPool: string[] = [];
  const seenCommon = new Set<string>();
  for (const entry of commonIdioms) {
    const word = typeof entry === "string" ? entry : entry?.idiom;
    if (typeof word !== "string" || seenCommon.has(word)) continue;
    if (hasFourRenderableChars(word, strokes)) {
      seenCommon.add(word);
      commonPool.push(word);
    }
  }

  // Answers now come from the full usable idiom list (standard mode guesses the same set).
  const answerPool = [...guessSet];
  const commonSet = new Set(commonPool);

  const data: GameData = { strokes, answerPool, commonPool, guessSet, commonSet, idiomSet, explanations };
  if (dir === DEFAULT_DATASETS_DIR) defaultCache = data;
  return data;
}

/** Cleaned one-line explanation for an idiom, or `""` when the dataset has none. */
export function explanationFor(data: GameData, word: string): string {
  if (typeof word !== "string" || word.length === 0) return "";
  return data.explanations.get(word) ?? "";
}

/** Answer pool for the selected dictionary scope. */
export function answerPoolFor(data: GameData, dictionary: DictionaryMode = "common"): string[] {
  return dictionary === "all" ? data.answerPool : data.commonPool;
}

/** Guess set for the selected dictionary scope (free mode ignores this). */
export function guessSetFor(data: GameData, dictionary: DictionaryMode = "common"): Set<string> {
  return dictionary === "all" ? data.guessSet : data.commonSet;
}

/** Get stroke data for one character, or `undefined` when the glyph is unknown. */
export function getStrokeEntry(data: GameData, char: string): StrokeEntry | undefined {
  if (typeof char !== "string" || Array.from(char).length !== 1) return undefined;
  return data.strokes[char];
}

/** True when every character of the word has stroke data. */
export function isRenderableWord(data: GameData, word: string): boolean {
  return hasFourRenderableChars(word, data.strokes);
}

/** The default dataset folder (repo_root/datasets). */
export function defaultDatasetsDir(): string {
  return DEFAULT_DATASETS_DIR;
}
