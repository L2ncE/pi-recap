import { test } from "node:test";
import assert from "node:assert/strict";

import {
	buildInputKey,
	cleanLine,
	cleanSingleLine,
	isWideChar,
	limitWords,
	positiveInt,
	similarity,
	unitRatio,
	wrapText,
} from "../extensions/recap.ts";

test("cleanLine strips markdown heading syntax", () => {
	assert.equal(cleanLine("## 会话回顾"), "会话回顾");
	assert.equal(cleanLine("# Heading"), "Heading");
});

test("cleanLine keeps legitimate leading digits", () => {
	assert.equal(cleanLine("3 files changed and the build is green"), "3 files changed and the build is green");
	assert.equal(cleanLine("12 errors fixed; tests next"), "12 errors fixed; tests next");
	assert.equal(cleanLine("2024 roadmap is done"), "2024 roadmap is done");
});

test("cleanLine keeps decimal lead-ins (not ordered-list markers)", () => {
	assert.equal(cleanLine("1.5x faster rendering landed"), "1.5x faster rendering landed");
	assert.equal(cleanLine("3.0 release is out"), "3.0 release is out");
	assert.equal(cleanLine("2.5x speedup achieved"), "2.5x speedup achieved");
});

test("cleanLine keeps years followed by a dot", () => {
	assert.equal(cleanLine("2024. roadmap is done"), "2024. roadmap is done");
});

test("cleanLine keeps negative numbers intact", () => {
	assert.equal(cleanLine("-3 items removed"), "-3 items removed");
});

test("cleanLine strips ordered and bullet list markers", () => {
	assert.equal(cleanLine("1. 列表项内容"), "列表项内容");
	assert.equal(cleanLine("2) second item"), "second item");
	assert.equal(cleanLine("100. item"), "item");
	assert.equal(cleanLine("- item"), "item");
	assert.equal(cleanLine("• item"), "item");
});

test("cleanLine strips recap prefix, markdown markers, links", () => {
	assert.equal(cleanLine("※ recap: 修复了标题问题"), "修复了标题问题");
	assert.equal(cleanLine("recap: plain"), "plain");
	assert.equal(cleanLine("**加粗**和`代码`测试"), "加粗和代码测试");
	assert.equal(cleanLine("see [docs](https://example.com)"), "see docs");
	assert.equal(cleanLine('"quoted"'), "quoted");
});

test("cleanSingleLine skips preamble and heading lines", () => {
	assert.equal(
		cleanSingleLine("Here is a recap of the session based on the recent activity:\n用户正在测试 recap 生成"),
		"用户正在测试 recap 生成",
	);
	assert.equal(cleanSingleLine("## 会话回顾"), "");
	assert.equal(cleanSingleLine("## 标题\n实际内容在这"), "实际内容在这");
	assert.equal(cleanSingleLine(""), "");
});

test("cleanSingleLine trims trailing punctuation", () => {
	assert.equal(cleanSingleLine("修复了 bug。"), "修复了 bug");
});

test("limitWords truncates with ellipsis", () => {
	assert.equal(limitWords("a b c d", 2), "a b…");
	assert.equal(limitWords("a b c", 5), "a b c");
});

test("similarity is symmetric Jaccard overlap", () => {
	assert.equal(similarity("a b c", "a b c"), 1);
	assert.equal(similarity("a b c", "x y z"), 0);
	// Subset: 2 of 3 words overlap → 2/3, below the 0.7 gate, so a recap that
	// drops content is not suppressed.
	assert.equal(similarity("a b", "a b c"), 2 / 3);
	assert.equal(similarity("", "a b"), 0);
});

test("positiveInt floors valid values, falls back otherwise", () => {
	assert.equal(positiveInt(1, 3), 1);
	assert.equal(positiveInt(2.9, 3), 2);
	assert.equal(positiveInt(0, 3), 3);
	assert.equal(positiveInt(-1, 3), 3);
	assert.equal(positiveInt(Number.NaN, 3), 3);
	assert.equal(positiveInt("2", 3), 3);
});

test("unitRatio accepts [0,1] values, falls back otherwise", () => {
	assert.equal(unitRatio(0, 0.7), 0);
	assert.equal(unitRatio(0.5, 0.7), 0.5);
	assert.equal(unitRatio(1, 0.7), 1);
	assert.equal(unitRatio(1.5, 0.7), 0.7);
	assert.equal(unitRatio(-0.1, 0.7), 0.7);
	assert.equal(unitRatio(Number.NaN, 0.7), 0.7);
});

test("buildInputKey joins goal and last round", () => {
	const rounds = [
		{ user: "first", assistant: "reply", tools: ["read"] },
		{ user: "second message", assistant: "another reply", tools: [] },
	];
	const key = buildInputKey("the goal", rounds);
	assert.ok(key.includes("the goal"));
	assert.ok(key.includes("second message"));
	assert.ok(key.includes("another reply"));
	assert.equal(key, buildInputKey("the goal", rounds));
});

test("wrapText wraps to width and counts wide chars", () => {
	assert.deepEqual(wrapText("abc", 2), ["ab", "c"]);
	// ※ (U+203B) counts as 2 columns
	assert.deepEqual(wrapText("※abc", 3), ["※a", "bc"]);
	assert.deepEqual(wrapText("中文", 2), ["中", "文"]);
});

test("isWideChar covers CJK and the ※ reference mark", () => {
	assert.equal(isWideChar("中"), true);
	assert.equal(isWideChar("※"), true);
	assert.equal(isWideChar("a"), false);
});
