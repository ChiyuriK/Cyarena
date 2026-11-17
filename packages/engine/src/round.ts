import type { CluePath, DictionaryMode, TileFeedback } from "../../shared/src/index.ts";
import { DEFAULT_DICTIONARY, GUESS_LENGTH } from "../../shared/src/index.ts";
import type { GameData } from "./data.ts";
import { answerPoolFor, getStrokeEntry, guessSetFor } from "./data.ts";
import { compareCharacters, defaultStrokeConfig } from "./strokes.ts";

/** Per-round feedback state, mirrors the plugin's normal mode accumulators. */
export interface RoundFeedbackState {
  /** Character locked in as correct for each of the four positions (or null). */
  correct: (string | null)[];
  /** Accumulated clue paths for each of the four positions (`strokesHtmlCache`). */
  cache: CluePath[][];
  /** Words already guessed this round (repeats are rejected without consuming a row). */
  tried: Set<string>;
  /** Number of rows built so far this round. */
  rowCounter: number;
  /**
   * `${char}-${position}` keys already merged into `cache` (the plugin's
   * `previousGuess` de-duplication list).
   */
  seen: Set<string>;
}

/** Create the mutable feedback state for one round. */
export function createRoundState(): RoundFeedbackState {
  return {
    correct: [null, null, null, null],
    cache: [[], [], [], []],
    tried: new Set<string>(),
    rowCounter: 0,
    seen: new Set<string>(),
  };
}

/** Chinese character check used by guess/session validation. */
export function isChineseChar(char: string): boolean {
  return /^[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]$/u.test(char);
}

export type ValidateGuessResult = { ok: true } | { ok: false; reason: string };

/** Detailed standard-mode guess validation against the selected dictionary scope. */
export function validateGuessDetail(
  data: GameData,
  word: string,
  dictionary: DictionaryMode = DEFAULT_DICTIONARY,
): ValidateGuessResult {
  if (typeof word !== "string") return { ok: false, reason: "猜测词必须是字符串" };
  const trimmed = word.trim();
  const chars = Array.from(trimmed);
  if (chars.length !== GUESS_LENGTH) return { ok: false, reason: `请输入 ${GUESS_LENGTH} 个汉字的成语` };
  for (const char of chars) {
    if (!isChineseChar(char)) return { ok: false, reason: "只能输入汉字" };
    if (!getStrokeEntry(data, char)) return { ok: false, reason: `字库中缺少“${char}”的笔画数据` };
  }
  if (!guessSetFor(data, dictionary).has(trimmed)) return { ok: false, reason: "词库中没有这个成语" };
  return { ok: true };
}

/** True when the word is a four character idiom (in the selected dictionary). */
export function validateGuess(data: GameData, word: string, dictionary: DictionaryMode = DEFAULT_DICTIONARY): boolean {
  return validateGuessDetail(data, word, dictionary).ok;
}

/**
 * Standard-mode helper: for a valid-looking four character word that is missing
 * from the dictionary, find one random dictionary word with Hamming distance 1.
 * Returns null when no such candidate exists (or the input is invalid for other reasons).
 */
export function suggestStandardWord(
  data: GameData,
  word: string,
  dictionary: DictionaryMode = DEFAULT_DICTIONARY,
  rng: () => number = Math.random,
): string | null {
  if (typeof word !== "string") return null;
  const trimmed = word.trim();
  const chars = Array.from(trimmed);
  if (chars.length !== GUESS_LENGTH) return null;
  for (const char of chars) {
    if (!isChineseChar(char) || !getStrokeEntry(data, char)) return null;
  }
  const pool = guessSetFor(data, dictionary);
  if (pool.has(trimmed)) return null;
  const candidates: string[] = [];
  for (const candidate of pool) {
    let differences = 0;
    for (let index = 0; index < GUESS_LENGTH; index += 1) {
      if (candidate[index] !== trimmed[index]) {
        differences += 1;
        if (differences > 1) break;
      }
    }
    if (differences === 1) candidates.push(candidate);
  }
  if (candidates.length === 0) return null;
  const roll = rng();
  const safe = Number.isFinite(roll) ? Math.min(0.999999999, Math.max(0, roll)) : 0;
  return candidates[Math.floor(safe * candidates.length)];
}

/**
 * Free mode validation: any four Chinese characters that all have stroke data.
 * The word does NOT have to exist in the idiom dictionary.
 */
export function validateFreeGuessDetail(data: GameData, word: string): ValidateGuessResult {
  if (typeof word !== "string") return { ok: false, reason: "猜测词必须是字符串" };
  const trimmed = word.trim();
  const chars = Array.from(trimmed);
  if (chars.length !== GUESS_LENGTH) return { ok: false, reason: `请输入 ${GUESS_LENGTH} 个汉字` };
  for (const char of chars) {
    if (!isChineseChar(char)) return { ok: false, reason: "只能输入汉字" };
    if (!getStrokeEntry(data, char)) return { ok: false, reason: `字库中缺少“${char}”的笔画数据` };
  }
  return { ok: true };
}

/** True when the word is four Chinese characters that all have stroke data (free mode). */
export function validateFreeGuess(data: GameData, word: string): boolean {
  return validateFreeGuessDetail(data, word).ok;
}

/** Random answer from the pool matching the room's dictionary scope. */
export function pickAnswer(
  data: GameData,
  rng: () => number = Math.random,
  dictionary: DictionaryMode = DEFAULT_DICTIONARY,
): string {
  const pool = answerPoolFor(data, dictionary);
  if (pool.length === 0) throw new Error("answerPool 为空，无法抽取答案");
  const roll = rng();
  const safe = Number.isFinite(roll) ? Math.min(0.999999999, Math.max(0, roll)) : 0;
  return pool[Math.floor(safe * pool.length)];
}

function answerStrokePaths(data: GameData, answerChar: string): CluePath[] {
  const entry = getStrokeEntry(data, answerChar);
  if (!entry) return [];
  return entry.strokes.map((d) => ({ d, fill: "white", opacity: 1, dx: 0, dy: 0 }));
}

/**
 * Turn the plugin's `compareStrokes` shadows into renderable clue paths.
 * Order matches the answer stroke order; unmatched strokes produce nothing.
 */
export function shadowsToCluePaths(shadows: Array<{ stroke: string; distance: number; shiftX: number; shiftY: number }>): CluePath[] {
  const { correctThreshold, presentThreshold } = defaultStrokeConfig;
  const paths: CluePath[] = [];
  for (const shadow of shadows) {
    if (!shadow.stroke) continue;
    const opacity =
      (presentThreshold - Math.max(shadow.distance, correctThreshold)) / (presentThreshold - correctThreshold);
    paths.push({
      d: shadow.stroke,
      fill: shadow.distance === 0 ? "correct" : "shadow",
      opacity,
      dx: shadow.shiftX,
      dy: shadow.shiftY,
    });
  }
  return paths;
}

/** Result of comparing one answer character with one guessed character. */
export interface ComparisonDetail {
  paths: CluePath[];
  /** `shadows.length` from the plugin result (one entry per answer stroke). */
  shadowCount: number;
  /** Number of strokes that matched within the correct threshold. */
  matchedCount: number;
  percent: number;
}

/** Compare one answer char with one guess char and turn it into clue paths. */
export function describeComparison(data: GameData, answerChar: string, guessChar: string): ComparisonDetail {
  const result = compareCharacters(data, answerChar, guessChar);
  const paths = shadowsToCluePaths(result.shadows);
  return {
    paths,
    shadowCount: result.shadows.length,
    matchedCount: Math.round(result.percent * result.shadows.length),
    percent: result.percent,
  };
}

/**
 * Build the four tiles for one guess row and mutate `state` (cache / correct /
 * tried / rowCounter) the same way the ciying plugin does in normal mode.
 */
export function buildRowFeedback(
  data: GameData,
  answer: string,
  guess: string,
  state: RoundFeedbackState,
): TileFeedback[] {
  const answerChars = Array.from(answer);
  const guessChars = Array.from(guess);
  if (answerChars.length !== GUESS_LENGTH) throw new Error("answer 必须是四个汉字");
  if (guessChars.length !== GUESS_LENGTH) throw new Error("guess 必须是四个汉字");

  if (!state.tried) state.tried = new Set<string>();
  if (!state.seen) state.seen = new Set<string>();
  if (!state.cache) state.cache = [[], [], [], []];
  if (!state.correct) state.correct = [null, null, null, null];

  const tiles: TileFeedback[] = [];
  for (let position = 0; position < GUESS_LENGTH; position += 1) {
    const answerChar = answerChars[position];
    const guessChar = guessChars[position];
    if (state.correct[position] === answerChar || guessChar === answerChar) {
      state.correct[position] = answerChar;
      tiles.push({
        bg: "correct",
        char: answerChar,
        description: `${answerChar}：字形正确`,
        paths: answerStrokePaths(data, answerChar),
      });
      continue;
    }

    const { paths: current, shadowCount } = describeComparison(data, answerChar, guessChar);
    const cache = state.cache[position];
    const key = `${guessChar}-${position}`;
    const isNewPair = !state.seen.has(key);
    // The tile renders the previously accumulated cache followed by this row's
    // shadows, exactly like the plugin renders `strokesHtmlCache[i]` before
    // appending the current shadows.
    const tilePaths = [...cache, ...current];
    if (isNewPair) {
      state.seen.add(key);
      for (const path of current) cache.push(path);
    }

    tiles.push({
      bg: "none",
      char: guessChar,
      description: `${guessChar}：字形不符，显示 ${shadowCount} 个相似笔画线索`,
      paths: tilePaths,
    });
  }

  // The plugin records every `${char}-${position}` pair of the guess, plus the
  // guessed idiom itself, after building the row.
  for (let position = 0; position < GUESS_LENGTH; position += 1) {
    state.seen.add(`${guessChars[position]}-${position}`);
  }
  state.tried.add(guess);
  state.rowCounter += 1;
  return tiles;
}
