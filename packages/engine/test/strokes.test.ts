import test from "node:test";
import assert from "node:assert/strict";
import type { StrokePoint } from "../src/index.ts";
import {
  compareStrokes,
  defaultStrokeConfig,
  hardStrokeConfig,
  loadGameData,
  medianDistance,
  medianRadius,
  pointAlong,
  pointDistance,
  polylineCentroid,
  polylineLength,
  scaleVector,
  segmentSquaredDistance,
  toCharacterStrokes,
  vectorBetween,
} from "../src/index.ts";

const data = loadGameData();
const yong = toCharacterStrokes(data.strokes["永"])!;
const shui = toCharacterStrokes(data.strokes["水"])!;

const CLOSE = 1e-12;
function assertClose(actual: number, expected: number, message: string): void {
  assert.ok(Math.abs(actual - expected) <= CLOSE, `${message}: expected ${expected}, got ${actual}`);
}

test("basic geometry helpers match the plugin formulas", () => {
  assert.equal(pointDistance([0, 0], [3, 4]), 5);
  assert.deepEqual(vectorBetween([1, 2], [4, 6]), [3, 4]);
  assert.deepEqual(scaleVector([3, 4], 10), [6, 8]);
  assert.deepEqual(pointAlong([10, 20], [3, 4], 0.5), [11.5, 22]);

  const line: StrokePoint[] = [
    [0, 0],
    [10, 0],
    [10, 10],
  ];
  assert.equal(polylineLength(line), 20);
  assert.deepEqual(polylineCentroid(line), [7.5, 2.5]);
});

test("segmentSquaredDistance uses the plugin's integrated formula", () => {
  // offset 0 on both axes, zero drift -> 0
  assert.equal(segmentSquaredDistance([0, 0], [1, 0], [0, 0], [1, 0], 0.5), 0);
  // constant offset of 2 on x over step 0.5 -> 2^2 * 0.5 = 2, same for y
  assertClose(segmentSquaredDistance([0, 0], [1, 0], [2, 2], [1, 0], 0.5), 4, "two-axis constant offset");
  // drift on x: directionB - directionA = 1, step 0.5 -> drift 0.5
  // (0 + 0 + 0.25/3) * 0.5 = 0.0416666..
  assertClose(segmentSquaredDistance([0, 0], [1, 0], [0, 0], [2, 0], 0.5), 0.25 / 3 * 0.5, "drift term");
});

test("medianRadius / medianDistance match the plugin's reference numbers", () => {
  assertClose(medianRadius(yong.medians[0]), 0.03963748866010424, "medianRadius 永[0]");
  assertClose(medianRadius(yong.medians[1]), 0.21325829135351584, "medianRadius 永[1]");
  const centroid = polylineCentroid(yong.medians[1]);
  assertClose(centroid[0], 470.166758712462, "centroid.x 永[1]");
  assertClose(centroid[1], 332.5485337851823, "centroid.y 永[1]");
  assertClose(polylineLength(yong.medians[1]), 914.1018979230646, "length 永[1]");
  assertClose(medianDistance(yong.medians[0], shui.medians[0], 0.7), 0.25845099511067504, "medianDistance 永0-水0");
  assertClose(medianDistance(yong.medians[0], shui.medians[1], 0.7), 0.20115097981325883, "medianDistance 永0-水1");
  assertClose(medianDistance(yong.medians[1], shui.medians[0], 0.7), 0.07392393676409767, "medianDistance 永1-水0");
});

test("default and hard mode configurations match the plugin", () => {
  assert.deepEqual(defaultStrokeConfig, { correctThreshold: 0.5, presentThreshold: 1, shiftFactor: 0.7 });
  assert.deepEqual(hardStrokeConfig, { correctThreshold: 0.3, presentThreshold: 1, shiftFactor: 0.7 });
});

test("compareStrokes: identical characters produce only zero-distance shadows", () => {
  const result = compareStrokes(toCharacterStrokes(data.strokes["画"])!, toCharacterStrokes(data.strokes["画"])!, null, defaultStrokeConfig);
  assert.equal(result.shadows.length, 8);
  for (const shadow of result.shadows) {
    assert.equal(shadow.distance, 0);
    assert.notEqual(shadow.stroke, "");
    assert.equal(shadow.shiftX, 0);
    assert.equal(shadow.shiftY, 0);
  }
  assert.equal(result.percent, 1);
  assert.equal(result.match, false, "compareStrokes itself never sets match");
});

test("compareStrokes: 画蛇添足 vs 画龙点睛 positions match the plugin sample", () => {
  // 蛇/龙 -> 1 green + 4 translucent shadows out of 11 answer strokes
  const sheLong = compareStrokes(toCharacterStrokes(data.strokes["蛇"])!, toCharacterStrokes(data.strokes["龙"])!, null, defaultStrokeConfig);
  assert.equal(sheLong.shadows.length, 11);
  assert.equal(sheLong.shadows.filter((s) => s.stroke && s.distance === 0).length, 1);
  assert.equal(sheLong.shadows.filter((s) => s.stroke && s.distance > 0).length, 4);
  assertClose(sheLong.percent, 1 / 11, "蛇/龙 percent");

  // 添/点 -> 1 green + 6 shadows
  const tianDian = compareStrokes(toCharacterStrokes(data.strokes["添"])!, toCharacterStrokes(data.strokes["点"])!, null, defaultStrokeConfig);
  assert.equal(tianDian.shadows.length, 11);
  assert.equal(tianDian.shadows.filter((s) => s.stroke && s.distance === 0).length, 1);
  assert.equal(tianDian.shadows.filter((s) => s.stroke && s.distance > 0).length, 6);

  // 足/睛 -> 1 green + 5 shadows
  const zuJing = compareStrokes(toCharacterStrokes(data.strokes["足"])!, toCharacterStrokes(data.strokes["睛"])!, null, defaultStrokeConfig);
  assert.equal(zuJing.shadows.length, 7);
  assert.equal(zuJing.shadows.filter((s) => s.stroke && s.distance === 0).length, 1);
  assert.equal(zuJing.shadows.filter((s) => s.stroke && s.distance > 0).length, 5);
});

test("compareStrokes: unmatched answer strokes keep an empty stroke", () => {
  const result = compareStrokes(toCharacterStrokes(data.strokes["一"])!, toCharacterStrokes(data.strokes["丨"])!, null, defaultStrokeConfig);
  assert.equal(result.shadows.length, 1);
  assert.equal(result.shadows[0].stroke, "");
  assert.equal(result.shadows[0].distance, defaultStrokeConfig.presentThreshold);
  assert.equal(result.percent, 0);
});

test("compareStrokes: previously accumulated shadows are carried forward and only improved", () => {
  const first = compareStrokes(toCharacterStrokes(data.strokes["蛇"])!, toCharacterStrokes(data.strokes["龙"])!, null, defaultStrokeConfig);
  const second = compareStrokes(
    toCharacterStrokes(data.strokes["蛇"])!,
    toCharacterStrokes(data.strokes["虫"])!,
    { shadows: first.shadows },
    defaultStrokeConfig,
  );
  assert.equal(second.shadows.length, first.shadows.length);
  for (let i = 0; i < first.shadows.length; i += 1) {
    assert.ok(second.shadows[i].distance <= first.shadows[i].distance || second.shadows[i].distance === 0);
  }
});
