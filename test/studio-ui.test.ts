import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../src/studio/web/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/studio/web/app.js", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../src/studio/web/i18n.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/studio/web/styles.css", import.meta.url), "utf8");

test("the shipped workspace exposes every creator flow through real API-backed controls", () => {
  for (const view of ["explore", "timeline", "wiki", "evolve", "history", "author"]) assert.match(html, new RegExp(`data-view="${view}"`));
  for (const id of ["world-list", "locale-zh", "locale-en", "graph", "inspector", "entity-groups", "map", "timeline", "wiki-list", "wiki-markdown", "run-start", "run-step", "run-pause", "run-resume", "history-branch", "history-explain", "author-json", "author-load", "author-compile", "export-book"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /\/api\/worlds\/inspect/);
  assert.match(app, /\/drafts\/\$\{encodeURIComponent\(definition\.draftId\)\}\/compile/);
  assert.match(app, /action: "run-to-complete"|runAction\("run-to-complete"\)/);
  assert.match(app, /\/branches/);
  assert.match(app, /\/explain/);
  assert.match(app, /\/exports/);
  assert.match(app, /data-wiki-link/);
  assert.match(app, /wikiRequestSequence/);
  assert.match(app, /requestSequence !== state\.wikiRequestSequence/);
  assert.match(app, /await openWiki\(savedPage\.slug\)/);
  assert.match(css, /color-scheme: dark/);
  assert.match(css, /\.graph svg/);
  assert.match(css, /\.map-place/);
  assert.match(app, /t\("map\.aria"\)/);
  assert.match(app, /transform="translate\(/);
  assert.doesNotMatch(app, /class="map-place"[^>]+style=/);
  assert.doesNotMatch(app, /class="progress-fill"[^>]+style=/);
  assert.match(app, /world-studio\.locale/);
  assert.match(app, /localStorage\.setItem/);
  assert.match(i18n, /export const DEFAULT_LOCALE = "zh-CN"/);
  assert.doesNotMatch(html, /prototype|placeholder success|demo-only/i);
});
