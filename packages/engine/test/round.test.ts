import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRowFeedback,
  compareCharacters,
  createRoundState,
  describeComparison,
  isChineseChar,
  loadGameData,
  pickAnswer,
  shadowsToCluePaths,
  suggestStandardWord,
  validateFreeGuess,
  validateFreeGuessDetail,
  validateGuess,
  validateGuessDetail,
} from "../src/index.ts";

const data = loadGameData();

test("createRoundState creates four empty positions", () => {
  const state = createRoundState();
  assert.deepEqual(state.correct, [null, null, null, null]);
  assert.equal(state.cache.length, 4);
  for (const cache of state.cache) assert.equal(cache.length, 0);
  assert.equal(state.tried.size, 0);
  assert.equal(state.seen.size, 0);
  assert.equal(state.rowCounter, 0);
});

test("buildRowFeedback reproduces the plugin's 画蛇添足 row", () => {
  const state = createRoundState();
  const tiles = buildRowFeedback(data, "画蛇添足", "画龙点睛", state);
  assert.equal(tiles.length, 4);

  // position 1: exact char -> green tile with all white answer strokes
  assert.equal(tiles[0].bg, "correct");
  assert.equal(tiles[0].char, "画");
  assert.equal(tiles[0].paths.length, 8);
  for (const path of tiles[0].paths) {
    assert.equal(path.fill, "white");
    assert.equal(path.opacity, 1);
    assert.equal(path.dx, 0);
    assert.equal(path.dy, 0);
  }
  assert.match(tiles[0].description, /画：字形正确/);

  // positions 2-4: 1 green + N translucent shadows each (plugin sample)
  const expected = [
    { green: 1, shadow: 4 },
    { green: 1, shadow: 6 },
    { green: 1, shadow: 5 },
  ];
  for (let i = 0; i < expected.length; i += 1) {
    const tile = tiles[i + 1];
    assert.equal(tile.bg, "none");
    const green = tile.paths.filter((path) => path.fill === "correct");
    const shadow = tile.paths.filter((path) => path.fill === "shadow");
    assert.equal(green.length, expected[i].green, `pos ${i + 2} green`);
    assert.equal(shadow.length, expected[i].shadow, `pos ${i + 2} shadows`);
    for (const path of green) {
      assert.equal(path.opacity, 1);
      assert.equal(path.dx, 0);
      assert.equal(path.dy, 0);
    }
    for (const path of shadow) {
      assert.ok(path.opacity > 0 && path.opacity < 1, `shadow opacity ${path.opacity}`);
      assert.ok(path.dx !== 0 || path.dy !== 0, "shadow must be shifted");
    }
    assert.match(tile.description, /：字形不符，显示 \d+ 个相似笔画线索$/);
  }

  assert.deepEqual(state.correct, ["画", null, null, null], "only the exact character locks yet");
  assert.equal(state.rowCounter, 1);
  assert.ok(state.tried.has("画龙点睛"));
  assert.deepEqual(state.cache.map((cache) => cache.length), [0, 5, 7, 6]);
});

test("buildRowFeedback accumulates shadows across rows", () => {
  const state = createRoundState();
  buildRowFeedback(data, "画蛇添足", "画龙点睛", state);
  const firstCache = state.cache.map((cache) => [...cache]);

  const tiles = buildRowFeedback(data, "画蛇添足", "画虎类犬", state);
  for (let position = 1; position < 4; position += 1) {
    assert.ok(
      state.cache[position].length > firstCache[position].length,
      `position ${position + 1} cache should grow`,
    );
    // tile renders the previous cache first, then this row's new shadows
    assert.deepEqual(tiles[position].paths.slice(0, firstCache[position].length), firstCache[position]);
    assert.ok(tiles[position].paths.length >= state.cache[position].length);
  }
  assert.equal(state.rowCounter, 2);
  assert.ok(state.tried.has("画虎类犬"));
});

test("buildRowFeedback de-duplicates cached clue paths per guessed char and position", () => {
  const state = createRoundState();
  buildRowFeedback(data, "画蛇添足", "画龙点睛", state);
  buildRowFeedback(data, "画蛇添足", "画虎类犬", state);
  const snapshot = state.cache.map((cache) => cache.length);

  // same guess word / same chars at same positions: nothing new enters the cache
  const tiles = buildRowFeedback(data, "画蛇添足", "画虎类犬", state);
  assert.deepEqual(state.cache.map((cache) => cache.length), snapshot);
  for (let position = 1; position < 4; position += 1) {
    assert.ok(tiles[position].paths.length > snapshot[position], "current row still renders its shadows");
  }
  assert.equal(state.rowCounter, 3);
});

test("buildRowFeedback locks a position once won and keeps it green later", () => {
  const state = createRoundState();
  buildRowFeedback(data, "画蛇添足", "画龙添足", state);
  assert.equal(state.correct[0], "画");
  assert.equal(state.correct[1], null);
  assert.equal(state.correct[2], "添");
  assert.equal(state.correct[3], "足");

  const tiles = buildRowFeedback(data, "画蛇添足", "画龙点睛", state);
  for (const position of [2, 3]) {
    assert.equal(tiles[position].bg, "correct");
    assert.equal(tiles[position].char, "画蛇添足"[position]);
    assert.ok(tiles[position].paths.every((path) => path.fill === "white"));
    assert.match(tiles[position].description, /字形正确/);
  }
  assert.equal(tiles[1].bg, "none");

  // fully correct guess fills every position
  const winning = buildRowFeedback(data, "画蛇添足", "画蛇添足", state);
  for (const tile of winning) {
    assert.equal(tile.bg, "correct");
    assert.match(tile.description, /字形正确/);
  }
  assert.deepEqual(state.correct, ["画", "蛇", "添", "足"]);
});

test("describeComparison / shadowsToCluePaths follow the plugin opacity formula", () => {
  const detail = describeComparison(data, "蛇", "龙");
  assert.equal(detail.shadowCount, 11);
  assert.equal(detail.paths.filter((path) => path.fill === "correct").length, 1);
  assert.equal(detail.paths.filter((path) => path.fill === "shadow").length, 4);
  const result = compareCharacters(data, "蛇", "龙");
  const renderedShadows = result.shadows.filter((shadow) => shadow.stroke);
  assert.equal(renderedShadows.length, detail.paths.length);
  for (let i = 0; i < renderedShadows.length; i += 1) {
    const shadow = renderedShadows[i];
    const path = detail.paths[i];
    assert.equal(path.d, shadow.stroke);
    assert.equal(path.fill, shadow.distance === 0 ? "correct" : "shadow");
    const opacity = (1 - Math.max(shadow.distance, 0.5)) / 0.5;
    assert.ok(Math.abs(path.opacity - opacity) < 1e-12, `opacity ${path.opacity} != ${opacity}`);
    assert.equal(path.dx, shadow.shiftX);
    assert.equal(path.dy, shadow.shiftY);
  }

  const paths = shadowsToCluePaths([
    { stroke: "M 0 0", distance: 0, shiftX: 0, shiftY: 0 },
    { stroke: "M 1 1", distance: 0.7, shiftX: 12, shiftY: -8 },
    { stroke: "M 2 2", distance: 0.5, shiftX: 1, shiftY: 1 },
    { stroke: "", distance: 1, shiftX: 0, shiftY: 0 },
  ]);
  assert.equal(paths.length, 3, "empty stroke is skipped");
  assert.deepEqual(paths[0], { d: "M 0 0", fill: "correct", opacity: 1, dx: 0, dy: 0 });
  assert.equal(paths[1].fill, "shadow");
  assert.ok(Math.abs(paths[1].opacity - 0.6) < 1e-12);
  assert.equal(paths[1].dx, 12);
  assert.equal(paths[1].dy, -8);
  assert.ok(Math.abs(paths[2].opacity - 1) < 1e-12, "distance at threshold is fully opaque");
});

test("validateGuess accepts known idioms and rejects everything else", () => {
  assert.equal(validateGuess(data, "一心一意"), true);
  assert.equal(validateGuess(data, "画蛇添足"), true);
  assert.equal(validateGuess(data, "画蛇添"), false);
  assert.equal(validateGuess(data, "画蛇添足足"), false);
  assert.equal(validateGuess(data, "abcd"), false);
  assert.equal(validateGuess(data, "阿阿阿阿"), false);
  assert.equal(validateGuess(data, "天天天天"), false);

  assert.deepEqual(validateGuessDetail(data, "一心一意"), { ok: true });
  const short = validateGuessDetail(data, "一心");
  assert.equal(short.ok, false);
  assert.match(short.reason, /4 个汉字/);
  const unknown = validateGuessDetail(data, "阿阿阿阿");
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /词库/);
});

test("standard dictionary scopes: common vs all", () => {
  const nonCommon = data.answerPool.find((word) => !data.commonSet.has(word));
  assert.ok(nonCommon, "there are usable idioms outside the common list");
  assert.equal(validateGuess(data, nonCommon!), false, "common scope rejects non-common idioms");
  assert.equal(validateGuess(data, nonCommon!, "all"), true, "all scope accepts them");
  assert.equal(validateGuess(data, "画蛇添足", "all"), true, "common idioms are inside all");
  assert.equal(validateGuess(data, "画蛇添足", "common"), true);
  assert.deepEqual(validateGuessDetail(data, nonCommon!, "all"), { ok: true });
  assert.equal(validateGuessDetail(data, nonCommon!, "common").ok, false);
});

test("suggestStandardWord finds exactly one-different dictionary word", () => {
  const target = data.commonPool[0];
  const chars = Array.from(target);
  const pickReplacement = () =>
    ["天", "地", "人", "心", "大", "小", "中", "上", "下", "水"].find(
      (char) => data.strokes[char] && !chars.includes(char),
    ) ?? "天";
  const replacement = pickReplacement();
  const wrong = `${chars[0]}${chars[1]}${chars[2]}${replacement}`;
  assert.equal(validateGuess(data, wrong, "common"), false, "the mutated word is not an idiom");

  const suggestion = suggestStandardWord(data, wrong, "common", () => 0);
  assert.ok(suggestion, "a distance-1 candidate exists");
  assert.ok(data.commonSet.has(suggestion!), "suggestion comes from the selected dictionary");
  let differences = 0;
  for (let index = 0; index < 4; index += 1) if (suggestion![index] !== wrong[index]) differences += 1;
  assert.equal(differences, 1, "suggestion differs by exactly one character");
  // The all scope also returns a single valid string.
  const allSuggestion = suggestStandardWord(data, wrong, "all", () => 0.5);
  assert.ok(allSuggestion && data.guessSet.has(allSuggestion));

  // No suggestions for malformed input or already-valid words.
  assert.equal(suggestStandardWord(data, "画蛇添"), null);
  assert.equal(suggestStandardWord(data, "abcd"), null);
  assert.equal(suggestStandardWord(data, "画蛇添足", "common"), null);
});

test("validateFreeGuess accepts any four renderable Chinese characters", () => {
  // known idiom -> valid in both modes
  assert.equal(validateFreeGuess(data, "一心一意"), true);
  // four real characters that are not an idiom: rejected by standard, accepted by free
  assert.equal(validateGuess(data, "天天天天"), false);
  assert.equal(validateFreeGuess(data, "天天天天"), true);
  assert.equal(validateFreeGuess(data, "画蛇添足"), true);

  // length / script / stroke data still matter
  assert.equal(validateFreeGuess(data, "天天天"), false);
  assert.equal(validateFreeGuess(data, "天天天天天"), false);
  assert.equal(validateFreeGuess(data, "ab天"), false);
  assert.equal(validateFreeGuess(data, "abcd"), false);
  assert.equal(validateFreeGuess(data, "😀天天天"), false);
  // a CJK char that has no stroke data
  const missing = Array.from("𠀋").length === 1 ? "𠀋" : "\u{20000}";
  assert.equal(validateFreeGuess(data, `${missing}天天天`), false);

  assert.deepEqual(validateFreeGuessDetail(data, "天天天天"), { ok: true });
  const bad = validateFreeGuessDetail(data, "a天天天");
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /汉字/);
});

test("isChineseChar only accepts CJK characters", () => {
  assert.equal(isChineseChar("永"), true);
  assert.equal(isChineseChar("a"), false);
  assert.equal(isChineseChar("1"), false);
  assert.equal(isChineseChar("🙂"), false);
});

test("pickAnswer follows the selected dictionary scope", () => {
  const first = pickAnswer(data, () => 0);
  const last = pickAnswer(data, () => 0.999999);
  assert.equal(first, data.commonPool[0], "default scope is common");
  assert.equal(last, data.commonPool[data.commonPool.length - 1]);
  const allFirst = pickAnswer(data, () => 0, "all");
  const allLast = pickAnswer(data, () => 0.999999, "all");
  assert.equal(allFirst, data.answerPool[0]);
  assert.equal(allLast, data.answerPool[data.answerPool.length - 1]);
  const random = pickAnswer(data);
  assert.ok(data.commonPool.includes(random));
  assert.ok(data.commonSet.has(random));
});
