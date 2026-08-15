import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_LOCALE,
  MESSAGES,
  enumLabel,
  localizedIssue,
  localizedQuestion,
  message,
  normalizeLocale,
} from "../src/studio/web/i18n.js";

const html = readFileSync(new URL("../src/studio/web/index.html", import.meta.url), "utf8");

test("the creator workspace is Chinese-first with a persistent bilingual switch", () => {
  assert.equal(DEFAULT_LOCALE, "zh-CN");
  assert.equal(normalizeLocale(null), "zh-CN");
  assert.equal(normalizeLocale("en"), "en");
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /id="locale-zh"[^>]+data-locale="zh-CN"[^>]+aria-pressed="true"/);
  assert.match(html, /id="locale-en"[^>]+data-locale="en"[^>]+aria-pressed="false"/);
  assert.equal(message("zh-CN", "nav.history"), "历史实验室");
  assert.equal(message("en", "nav.history"), "History Lab");
  assert.equal(message("zh-CN", "graph.count", { nodes: 4, edges: 3 }), "4 个可见节点 · 3 条关系");
  assert.equal(enumLabel("zh-CN", "status", "complete"), "已完成");
  assert.equal(enumLabel("zh-CN", "dimension", "environment"), "environment");
});

test("every static translation marker has complete Chinese and English catalog entries", () => {
  const keys = [...html.matchAll(/data-i18n(?:-placeholder|-title|-aria-label|-value)?="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(keys.length > 60);
  for (const key of keys) {
    assert.ok(MESSAGES["zh-CN"][key], `missing zh-CN translation for ${key}`);
    assert.ok(MESSAGES.en[key], `missing en translation for ${key}`);
  }
  assert.deepEqual(Object.keys(MESSAGES["zh-CN"]).sort(), Object.keys(MESSAGES.en).sort());
});

test("structured creator questions localize by stable code without changing their payload", () => {
  const question = {
    code: "places-missing",
    prompt: "What places make up the initial geography?",
    whyConsequential: "Movement needs spatial anchors.",
  };
  assert.equal(localizedQuestion("zh-CN", question, "prompt"), "初始地理由哪些地点组成？");
  assert.equal(localizedQuestion("en", question, "prompt"), question.prompt);
  const issue = { code: "invalid-world-id", message: "World id is invalid." };
  assert.match(localizedIssue("zh-CN", issue), /World id/);
  assert.equal(localizedIssue("en", issue), issue.message);
  assert.deepEqual(question, {
    code: "places-missing",
    prompt: "What places make up the initial geography?",
    whyConsequential: "Movement needs spatial anchors.",
  });
});
