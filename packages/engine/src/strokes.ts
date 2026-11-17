import type { GameData, StrokeEntry } from "./data.ts";
import { getStrokeEntry } from "./data.ts";

/** A point in the 1024-unit glyph coordinate system. */
export type StrokePoint = [number, number];

/** The subset of `datasets/strokes.json` needed by the stroke comparison. */
export interface CharacterStrokes {
  strokes: string[];
  medians: StrokePoint[][];
}

/** One shadow entry per answer stroke (empty `stroke` = no usable match). */
export interface StrokeShadow {
  stroke: string;
  distance: number;
  shiftX: number;
  shiftY: number;
}

export interface StrokeCompareConfig {
  correctThreshold: number;
  presentThreshold: number;
  shiftFactor: number;
}

export interface StrokeCompareResult {
  shadows: StrokeShadow[];
  match: boolean;
  percent: number;
}

/** Exactly the ciying plugin's default (normal mode) configuration. */
export const defaultStrokeConfig: StrokeCompareConfig = {
  correctThreshold: 0.5,
  presentThreshold: 1,
  shiftFactor: 0.7,
};

/** The plugin's hard mode configuration (kept for completeness). */
export const hardStrokeConfig: StrokeCompareConfig = {
  correctThreshold: 0.3,
  presentThreshold: 1,
  shiftFactor: 0.7,
};

/** Backwards friendly aliases for the default config values. */
export const CORRECT_THRESHOLD = defaultStrokeConfig.correctThreshold;
export const PRESENT_THRESHOLD = defaultStrokeConfig.presentThreshold;
export const SHIFT_FACTOR = defaultStrokeConfig.shiftFactor;

// ---------------------------------------------------------------------------
// The functions below are a line-by-line port of the ciying plugin
// `src/utils/strokes.ts` (koishi-plugin-wordle-game v4.4.0).
// ---------------------------------------------------------------------------

export function pointDistance(a: StrokePoint, b: StrokePoint): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function vectorBetween(from: StrokePoint, to: StrokePoint): StrokePoint {
  return [to[0] - from[0], to[1] - from[1]];
}

/** Scale a vector to the requested length (`origin + direction * factor` is `pointAlong`). */
export function scaleVector(vector: StrokePoint, length: number): StrokePoint {
  const factor = length / Math.hypot(vector[0], vector[1]);
  return [vector[0] * factor, vector[1] * factor];
}

export function polylineLength(points: StrokePoint[]): number {
  let total = 0;
  for (let i = 0; i + 1 < points.length; i += 1) {
    total += pointDistance(points[i], points[i + 1]);
  }
  return total;
}

/** Arc-length weighted centroid of a polyline (not the median of the vertices). */
export function polylineCentroid(points: StrokePoint[]): StrokePoint {
  const total = polylineLength(points);
  const center: StrokePoint = [0, 0];
  for (let i = 0; i + 1 < points.length; i += 1) {
    const weight = pointDistance(points[i], points[i + 1]) / total;
    for (let axis = 0; axis < 2; axis += 1) {
      center[axis] += ((points[i][axis] + points[i + 1][axis]) / 2) * weight;
    }
  }
  return center;
}

/** `origin + direction * factor` (plugin signature; `direction` is a vector, not a polyline). */
export function pointAlong(origin: StrokePoint, direction: StrokePoint, factor: number): StrokePoint {
  return [origin[0] + direction[0] * factor, origin[1] + direction[1] * factor];
}

/** Integrated squared distance between two linear motions over one step. */
export function segmentSquaredDistance(
  startA: StrokePoint,
  directionA: StrokePoint,
  startB: StrokePoint,
  directionB: StrokePoint,
  step: number,
): number {
  let sum = 0;
  for (let axis = 0; axis < 2; axis += 1) {
    const offset = startB[axis] - startA[axis];
    const drift = (directionB[axis] - directionA[axis]) * step;
    sum += (offset * offset + offset * drift + (drift * drift) / 3) * step;
  }
  return sum;
}

/** Characteristic radius of one stroke, in glyph units divided by 1024. */
export function medianRadius(points: StrokePoint[]): number {
  const center = polylineCentroid(points);
  const total = polylineLength(points);
  let sum = 0;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const step = pointDistance(points[i], points[i + 1]) / total;
    const direction = scaleVector(vectorBetween(points[i], points[i + 1]), total);
    sum += segmentSquaredDistance(points[i], direction, center, [0, 0], step);
  }
  return Math.sqrt(sum) / 1024;
}

/** Distance between two strokes, integrated over both polylines (glyph units / 1024). */
export function medianDistance(pointsA: StrokePoint[], pointsB: StrokePoint[], shiftFactor: number): number {
  let sum = 0;
  const lengthA = polylineLength(pointsA);
  const lengthB = polylineLength(pointsB);
  const centerA = polylineCentroid(pointsA);
  const centerB = polylineCentroid(pointsB);
  let currentA = pointAlong(pointsA[0], centerA, -shiftFactor);
  let currentB = pointAlong(pointsB[0], centerB, -shiftFactor);
  let indexA = 1;
  let indexB = 1;
  while (indexA < pointsA.length && indexB < pointsB.length) {
    const nextA = pointAlong(pointsA[indexA], centerA, -shiftFactor);
    const nextB = pointAlong(pointsB[indexB], centerB, -shiftFactor);
    const stepA = pointDistance(currentA, nextA) / lengthA;
    const stepB = pointDistance(currentB, nextB) / lengthB;
    const directionA = scaleVector(vectorBetween(currentA, nextA), lengthA);
    const directionB = scaleVector(vectorBetween(currentB, nextB), lengthB);
    if (stepA === stepB) {
      sum += segmentSquaredDistance(currentA, directionA, currentB, directionB, stepA);
      currentA = nextA;
      currentB = nextB;
      indexA += 1;
      indexB += 1;
    } else if (stepA < stepB) {
      sum += segmentSquaredDistance(currentA, directionA, currentB, directionB, stepA);
      currentA = nextA;
      currentB = pointAlong(currentB, directionB, stepA);
      indexA += 1;
    } else {
      sum += segmentSquaredDistance(currentA, directionA, currentB, directionB, stepB);
      currentA = pointAlong(currentA, directionA, stepB);
      currentB = nextB;
      indexB += 1;
    }
  }
  return Math.sqrt(sum) / 1024;
}

/**
 * Exact port of the plugin `compareStrokes`.
 *
 * Every stroke of the answer glyph independently looks for the closest stroke
 * of the guessed glyph. When it is close enough the answer's own path is used
 * (all bright); otherwise the guessed path is reused with a partial centroid
 * shift as a translucent shadow. `shadows` may carry previously accumulated
 * shadows; when omitted it starts from one empty shadow per answer stroke.
 */
export function compareStrokes(
  answer: CharacterStrokes,
  input: CharacterStrokes,
  shadows: { shadows: StrokeShadow[] } | null,
  config: StrokeCompareConfig = defaultStrokeConfig,
): StrokeCompareResult {
  const result: StrokeShadow[] = [
    ...(shadows?.shadows ??
      answer.medians.map(() => ({
        stroke: "",
        distance: config.presentThreshold,
        shiftX: 0,
        shiftY: 0,
      }))),
  ];
  let matchedCount = 0;
  for (let i = 0; i < answer.medians.length; i += 1) {
    let isCorrect = false;
    const radius = medianRadius(answer.medians[i]);
    for (let j = 0; j < input.medians.length; j += 1) {
      const distance = medianDistance(answer.medians[i], input.medians[j], config.shiftFactor) / radius;
      if (distance < config.correctThreshold) {
        isCorrect = true;
      }
      if (distance < result[i].distance) {
        if (distance < config.correctThreshold) {
          result[i] = {
            stroke: answer.strokes[i],
            distance: 0,
            shiftX: 0,
            shiftY: 0,
          };
        } else {
          const centerAnswer = polylineCentroid(answer.medians[i]);
          const centerInput = polylineCentroid(input.medians[j]);
          result[i] = {
            stroke: input.strokes[j],
            distance,
            shiftX: (centerAnswer[0] - centerInput[0]) * config.shiftFactor,
            shiftY: (centerAnswer[1] - centerInput[1]) * config.shiftFactor,
          };
        }
      }
    }
    if (isCorrect) {
      matchedCount += 1;
    }
  }
  return {
    shadows: result,
    match: false,
    percent: matchedCount / answer.medians.length,
  };
}

/** Convert a dataset stroke entry into the plugin's `CharacterStrokes` shape. */
export function toCharacterStrokes(entry: StrokeEntry | undefined): CharacterStrokes | null {
  if (!entry) return null;
  return { strokes: entry.strokes, medians: entry.medians };
}

/** Convenience wrapper: compare two characters using `loadGameData` data. */
export function compareCharacters(
  data: GameData,
  answerChar: string,
  guessChar: string,
  config: StrokeCompareConfig = defaultStrokeConfig,
): StrokeCompareResult {
  const answer = toCharacterStrokes(getStrokeEntry(data, answerChar));
  const input = toCharacterStrokes(getStrokeEntry(data, guessChar));
  if (!answer || !input) {
    return { shadows: [], match: false, percent: 0 };
  }
  return compareStrokes(answer, input, null, config);
}
