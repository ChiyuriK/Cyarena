import test from "node:test";
import assert from "node:assert/strict";
import {
  answerPoolFor,
  cleanExplanation,
  defaultDatasetsDir,
  explanationFor,
  getStrokeEntry,
  guessSetFor,
  isRenderableWord,
  loadGameData,
} from "../src/index.ts";

const data = loadGameData();

test("loadGameData loads all three datasets", () => {
  assert.equal(Object.keys(data.strokes).length, 9574);
  assert.equal(data.commonPool.length, 7208, "common idiom list is kept for reference");
  assert.equal(data.commonSet.size, 7208);
  assert.ok(data.idiomSet.size >= 29956, `idiomSet=${data.idiomSet.size}`);
  assert.ok(data.guessSet.size > 29000 && data.guessSet.size < data.idiomSet.size);
  assert.equal(data.idiomSet.size - data.guessSet.size, 550, "about 550 idioms lack stroke data");
  assert.equal(data.answerPool.length, data.guessSet.size, "answers use the full usable list");
  assert.ok(defaultDatasetsDir().includes("datasets"));
});

test("dictionary scopes expose the right answer/guess pools", () => {
  assert.equal(answerPoolFor(data, "common"), data.commonPool);
  assert.equal(answerPoolFor(data, "all"), data.answerPool);
  assert.equal(answerPoolFor(data), data.commonPool, "default scope is common");
  assert.equal(guessSetFor(data, "common"), data.commonSet);
  assert.equal(guessSetFor(data, "all"), data.guessSet);
  assert.equal(guessSetFor(data), data.commonSet);
  for (const word of data.commonPool) assert.ok(data.commonSet.has(word) && data.guessSet.has(word));
});

test("answerPool is the full usable idiom list", () => {
  assert.equal(new Set(data.answerPool).size, data.answerPool.length, "no duplicate answers");
  assert.equal(data.answerPool.length, data.guessSet.size);
  for (const word of data.answerPool) {
    assert.ok(data.guessSet.has(word), `${word} missing from guessSet`);
    assert.ok(isRenderableWord(data, word), `${word} has missing strokes`);
  }
  // a non-common but usable idiom can now be the answer
  const nonCommon = data.answerPool.find((word) => !data.commonPool.includes(word));
  assert.ok(nonCommon, "answer pool contains idioms outside the common list");
  assert.equal(Array.from(nonCommon!).length, 4);
});

test("stroke entries expose paths and medians for every renderable char", () => {
  const entry = getStrokeEntry(data, "永");
  assert.ok(entry);
  assert.equal(entry!.strokes.length, 5);
  assert.equal(entry!.medians.length, 5);
  for (const stroke of entry!.strokes) assert.match(stroke, /^M /);
  for (const median of entry!.medians) assert.ok(median.length >= 2);
  assert.equal(getStrokeEntry(data, "\u0000"), undefined);
  assert.equal(getStrokeEntry(data, "ab"), undefined);
});

test("explanations cover every answer and are cleaned for the sidebar", () => {
  assert.ok(data.explanations.size > 29_000, `explanations=${data.explanations.size}`);
  for (const word of data.answerPool) {
    assert.ok(data.explanations.has(word), `${word} has no explanation`);
  }
  for (const word of [data.commonPool[0], data.answerPool.find((entry) => !data.commonSet.has(entry))!]) {
    const explanation = explanationFor(data, word);
    assert.ok(explanation.length > 0, `${word} explanation is empty`);
    assert.equal(explanation.startsWith("【解释】"), false);
    assert.equal(explanation.includes("\n"), false);
    assert.ok(Array.from(explanation).length <= 80, "explanation is truncated for the sidebar");
  }
  assert.equal(explanationFor(data, "不存在的成语"), "");
  assert.equal(explanationFor(data, ""), "");
  assert.equal(cleanExplanation("【解释】测试用释义。\n【出处】某书"), "测试用释义。");
  assert.equal(cleanExplanation("【解释】多行\n第二行【示例】例子"), "多行");
  assert.ok(Array.from(cleanExplanation("【解释】" + "长".repeat(120))).length <= 80);
});

test("loadGameData is cached for the default directory", () => {
  assert.equal(loadGameData(), data);
});
