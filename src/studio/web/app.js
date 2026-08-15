import { DEFAULT_LOCALE, SUPPORTED_LOCALES, enumLabel, localizedIssue, localizedQuestion, message, normalizeLocale } from "./i18n.js";

const LOCALE_STORAGE_KEY = "world-studio.locale";

function savedLocale() {
  try { return normalizeLocale(localStorage.getItem(LOCALE_STORAGE_KEY)); }
  catch { return DEFAULT_LOCALE; }
}

const state = {
  worlds: [], worldId: null, workspace: null, view: "explore", selectedEntity: null,
  wikiPage: null, wikiCreating: false, wikiRequestSequence: 0, authorRevision: 0, authorResult: null, historyResult: null, control: null, locale: savedLocale(),
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const short = (value, size = 10) => value ? `${String(value).slice(0, size)}…${String(value).slice(-4)}` : "—";
const t = (key, parameters) => message(state.locale, key, parameters);
const valueLabel = (group, value) => enumLabel(state.locale, group, value);
const labelFor = (object) => object?.attributes?.name ?? object?.id ?? t("value.unknown");

function applyStaticTranslations() {
  document.documentElement.lang = state.locale;
  $$('[data-i18n]').forEach((element) => { element.textContent = t(element.dataset.i18n); });
  $$('[data-i18n-placeholder]').forEach((element) => { element.placeholder = t(element.dataset.i18nPlaceholder); });
  $$('[data-i18n-title]').forEach((element) => { element.title = t(element.dataset.i18nTitle); });
  $$('[data-i18n-aria-label]').forEach((element) => { element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel)); });
  $$('[data-i18n-value]').forEach((element) => {
    const key = element.dataset.i18nValue;
    const knownDefaults = SUPPORTED_LOCALES.map((locale) => message(locale, key));
    if (knownDefaults.includes(element.value)) element.value = t(key);
  });
  $$('[data-locale]').forEach((button) => {
    const active = button.dataset.locale === state.locale;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function setLocale(locale) {
  state.locale = normalizeLocale(locale);
  try { localStorage.setItem(LOCALE_STORAGE_KEY, state.locale); } catch { /* Browser preference is optional. */ }
  applyStaticTranslations();
  renderWorlds();
  if (state.workspace) {
    renderWorkspace();
    if (state.selectedEntity) inspectEntity(state.selectedEntity.id);
    if (state.wikiPage) {
      $("#wiki-revision").textContent = t("wiki.revision", { revision: state.wikiPage.revision, hash: short(state.wikiPage.contentHash, 10) });
      renderWikiPreview();
    }
    if (state.historyResult?.kind === "branch") renderHistoryEvidence(state.historyResult.value, false);
    if (state.historyResult?.kind === "explanation") renderExplanation(state.historyResult.value, false);
  }
  if (state.authorResult) renderAuthorResult(state.authorResult, false);
}

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json", ...(options.headers ?? {}) }, ...options });
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(payload?.error?.message ?? t("api.requestFailed", { status: response.status }));
  return payload;
}

function busy(active, message = t("busy.default")) {
  $("#busy span").textContent = message;
  $("#busy").classList.toggle("hidden", !active);
}

let toastTimer;
function toast(message, error = false) {
  clearTimeout(toastTimer);
  const element = $("#toast");
  element.textContent = message;
  element.classList.toggle("error", error);
  element.classList.remove("hidden");
  toastTimer = setTimeout(() => element.classList.add("hidden"), 4200);
}

async function task(label, action) {
  busy(true, label);
  try { return await action(); }
  catch (error) { toast(error.message, true); throw error; }
  finally { busy(false); }
}

function renderWorlds() {
  $("#world-list").innerHTML = state.worlds.map((world) => `
    <button class="world-item ${world.worldId === state.worldId ? "active" : ""}" data-world="${esc(world.worldId)}">
      <strong>${esc(world.title)}</strong><span>${esc(t(world.runCount === 1 ? "world.runCount.one" : "world.runCount.many", { count: world.runCount, hash: short(world.contractHash, 7) }))}</span>
    </button>`).join("");
  $$("[data-world]").forEach((button) => button.addEventListener("click", () => selectWorld(button.dataset.world)));
}

async function loadWorlds() {
  const response = await api("/api/worlds");
  state.worlds = response.worlds;
  renderWorlds();
  if (!state.worldId && state.worlds[0]) await selectWorld(state.worlds[0].worldId);
}

async function selectWorld(worldId, runId) {
  state.worldId = worldId;
  state.selectedEntity = null;
  state.wikiPage = null;
  state.wikiCreating = false;
  state.wikiRequestSequence += 1;
  state.historyResult = null;
  state.authorResult = null;
  $("#history-result").textContent = t("history.empty");
  $("#author-results").innerHTML = "";
  state.workspace = await task(t("task.openWorld"), () => api(`/api/worlds/${encodeURIComponent(worldId)}/workspace${runId ? `?run=${encodeURIComponent(runId)}` : ""}`));
  state.control = state.workspace.controls[0] ?? null;
  renderWorlds();
  renderWorkspace();
  setView(state.view);
}

function setView(view) {
  state.view = view;
  $$(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === view));
  $$(".view").forEach((element) => element.classList.add("hidden"));
  $("#empty-state").classList.toggle("hidden", Boolean(state.workspace));
  if (state.workspace) $(`#view-${view}`).classList.remove("hidden");
}

function renderWorkspace() {
  const workspace = state.workspace;
  $("#world-kicker").textContent = t("contract.kicker", { authority: workspace.contract.authority, hash: short(workspace.contract.hash, 12) });
  $("#world-title").textContent = workspace.world.title;
  $("#world-summary").textContent = workspace.world.summary;
  $("#export-book").disabled = !workspace.run;
  renderStats(); renderGraph(); renderEntities(); renderMap(); renderTimeline(); renderWiki(); renderRun(); renderHistoryControls();
}

function renderStats() {
  const workspace = state.workspace;
  const facts = workspace.graph.facts.length;
  const items = [
    [workspace.graph.nodes.length, t("stats.objects")], [workspace.graph.edges.length, t("stats.relations")], [facts, t("stats.facts")],
    [workspace.run ? workspace.boundaries.length : 0, t("stats.boundaries")], [workspace.run?.closure?.status ? valueLabel("status", workspace.run.closure.status) : t("stats.initial"), t("stats.closure")],
  ];
  $("#stats").innerHTML = items.map(([value, label]) => `<div class="stat"><strong>${esc(value)}</strong><span>${esc(label)}</span></div>`).join("");
}

const nodeColors = { person: "#ad8bf0", cultivator: "#ad8bf0", organization: "#e4a64c", institution: "#d57e67", place: "#53b9b4", settlement: "#5bc9c5", route: "#8e9eb6", event: "#ed6a78", hazard: "#e96e74", "resource-stock": "#75c48e", "population-group": "#7ab9df" };

function graphNodes() {
  const preferred = ["person", "cultivator", "organization", "institution", "place", "settlement", "route", "event", "hazard", "resource-stock", "population-group"];
  return [...state.workspace.graph.nodes].sort((a, b) => preferred.indexOf(a.type) - preferred.indexOf(b.type) || a.id.localeCompare(b.id)).slice(0, 38);
}

function renderGraph() {
  const nodes = graphNodes();
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = state.workspace.graph.edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)).slice(0, 70);
  const width = 820, height = 370, cx = width / 2, cy = height / 2;
  const ringPlan = [{ start: 0, capacity: 6, radius: 78 }, { start: 6, capacity: 12, radius: 154 }, { start: 18, capacity: 20, radius: 207 }];
  const positions = new Map(nodes.map((node, index) => {
    const ring = ringPlan.find((candidate) => index < candidate.start + candidate.capacity) ?? ringPlan.at(-1);
    const count = Math.min(ring.capacity, nodes.length - ring.start);
    const localIndex = index - ring.start;
    const angle = (localIndex / Math.max(count, 1)) * Math.PI * 2 - Math.PI / 2;
    return [node.id, { x: cx + Math.cos(angle) * ring.radius, y: cy + Math.sin(angle) * ring.radius * .73 }];
  }));
  const lines = edges.map((edge) => {
    const from = positions.get(edge.from), to = positions.get(edge.to);
    return `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}"><title>${esc(edge.type)}</title></line>`;
  }).join("");
  const circles = nodes.map((node) => {
    const position = positions.get(node.id), label = labelFor(node);
    return `<g class="node" data-entity="${esc(node.id)}" transform="translate(${position.x} ${position.y})"><circle r="${node.type === "place" ? 9 : 7}" fill="${nodeColors[node.type] ?? "#718096"}"></circle><text y="18">${esc(label.length > 18 ? `${label.slice(0, 17)}…` : label)}</text><title>${esc(`${node.type}: ${label}`)}</title></g>`;
  }).join("");
  $("#graph").innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(t("graph.aria"))}">${lines}${circles}</svg>`;
  $("#graph-count").textContent = t("graph.count", { nodes: nodes.length, edges: edges.length });
  $$("#graph [data-entity]").forEach((element) => element.addEventListener("click", () => inspectEntity(element.dataset.entity)));
}

function renderEntities(filter = "") {
  const term = filter.toLowerCase();
  const priority = ["person", "cultivator", "organization", "institution", "event", "settlement", "population-group", "resource-stock", "hazard", "place", "route"];
  const groups = Object.entries(state.workspace.entityGroups).filter(([type, nodes]) => priority.includes(type) && nodes.some((node) => `${node.id} ${labelFor(node)}`.toLowerCase().includes(term))).sort((a, b) => priority.indexOf(a[0]) - priority.indexOf(b[0]));
  $("#entity-groups").innerHTML = groups.map(([type, nodes]) => `<div class="entity-group"><h3 title="${esc(type)}">${esc(valueLabel("entity", type))}</h3><div class="entity-chips">${nodes.filter((node) => `${node.id} ${labelFor(node)}`.toLowerCase().includes(term)).map((node) => `<button class="entity-chip" data-entity="${esc(node.id)}">${esc(labelFor(node))}</button>`).join("")}</div></div>`).join("") || `<div class="inspector-empty">${esc(t("entities.empty"))}</div>`;
  $$("#entity-groups [data-entity]").forEach((element) => element.addEventListener("click", () => inspectEntity(element.dataset.entity)));
}

function entityById(id) { return state.workspace.graph.nodes.find((node) => node.id === id) ?? state.workspace.graph.edges.find((edge) => edge.id === id) ?? state.workspace.graph.facts.find((fact) => fact.id === id); }

function inspectEntity(id) {
  const entity = entityById(id);
  if (!entity) return;
  state.selectedEntity = entity;
  $("#inspector-title").textContent = labelFor(entity);
  const attributes = entity.attributes ?? Object.fromEntries(Object.entries(entity).filter(([key]) => !["worldId", "id", "type"].includes(key)));
  const entityType = entity.type ?? (entity.from ? "edge" : "fact");
  $("#inspector").innerHTML = `<span class="object-type" title="${esc(entityType)}">${esc(valueLabel("entity", entityType))}</span><p class="muted">${esc(entity.id)}</p><dl class="attribute-list">${Object.entries(attributes).map(([key, value]) => `<div class="attribute"><dt>${esc(key)}</dt><dd>${esc(typeof value === "object" ? JSON.stringify(value) : value)}</dd></div>`).join("")}</dl>`;
  renderHistoryControls(id);
}

function renderMap() {
  const places = state.workspace.map.places;
  const byId = new Map(places.map((place) => [place.id, place]));
  const point = (place) => ({ x: Math.max(105, Math.min(895, Number(place.x) * 10)), y: Math.max(35, Math.min(245, Number(place.y) * 3)) });
  const routes = state.workspace.map.routes.flatMap((route) => {
    const from = byId.get(route.attributes.origin), to = byId.get(route.attributes.destination);
    if (!from || !to) return [];
    const start = point(from), end = point(to);
    return [`<g class="map-route"><line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}"></line><text x="${(start.x + end.x) / 2}" y="${(start.y + end.y) / 2 - 8}">${esc(labelFor(route))}</text></g>`];
  });
  if (!places.length) { $("#map").innerHTML = `<div class="inspector-empty">${esc(t("map.empty"))}</div>`; return; }
  const markers = places.map((place) => {
    const location = point(place), coordinateLabel = place.coordinates === "creator" ? t("map.creatorCoordinates") : t("map.nonCausalLayout"), imageLabel = place.imagePath ? t("map.imageReference") : t("map.noImage");
    return `<g class="map-place" data-entity="${esc(place.id)}" transform="translate(${location.x} ${location.y})" role="button" tabindex="0" aria-label="${esc(`${place.name} · ${coordinateLabel} · ${imageLabel}`)}"><title>${esc(place.name)}</title><circle r="9"></circle><rect x="-78" y="14" width="156" height="42" rx="8"></rect><text class="map-name" y="31">${esc(place.name)}</text><text class="map-meta" y="46">${esc(`${coordinateLabel} · ${imageLabel}`)}</text></g>`;
  });
  $("#map").innerHTML = `<svg viewBox="0 0 1000 300" role="img" aria-label="${esc(t("map.aria"))}">${routes.join("")}${markers.join("")}</svg>`;
  $$("#map [data-entity]").forEach((element) => {
    element.addEventListener("click", () => inspectEntity(element.dataset.entity));
    element.addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); inspectEntity(element.dataset.entity); } });
  });
}

function renderTimeline() {
  const boundaries = state.workspace.boundaries;
  const entries = state.workspace.timeline.entries;
  $("#timeline-run").textContent = state.workspace.run ? state.workspace.run.id : t("timeline.initial");
  if (!boundaries.length) { $("#timeline").innerHTML = `<div class="inspector-empty">${esc(t("timeline.empty"))}</div>`; return; }
  $("#timeline").innerHTML = boundaries.map((record) => {
    const boundary = record.boundary;
    const events = entries.filter((entry) => entry.instant.worldTime === boundary.worldTime);
    const summaries = events.slice(0, 2).map((entry) => entry.summary.length > 190 ? `${entry.summary.slice(0, 187)}…` : entry.summary);
    return `<div class="timeline-row"><div class="timeline-time">t ${boundary.worldTime}</div><div class="scale-badge ${boundary.scale}" title="${esc(boundary.scale)}">${esc(valueLabel("scale", boundary.scale))}</div><div class="timeline-rail"></div><div class="timeline-content"><strong>${esc(boundary.id.replace("boundary:", "").replaceAll("-", " "))}</strong><p>${esc(boundary.reason)}</p>${summaries.map((summary) => `<p>${esc(summary)}</p>`).join("")}${events.length > summaries.length ? `<p class="timeline-more">${esc(t("timeline.more", { count: events.length - summaries.length }))}</p>` : ""}<p>${esc(t("timeline.evidenceCount", { emissions: record.emissionIds.length, dimensions: record.dimensionsActivated.length }))}</p></div></div>`;
  }).join("");
}

function markdown(markdownText) {
  let output = esc(markdownText);
  output = output.replace(/^### (.+)$/gm, "<h3>$1</h3>").replace(/^## (.+)$/gm, "<h2>$1</h2>").replace(/^# (.+)$/gm, "<h1>$1</h1>");
  output = output.replace(/\[\[([^\]]+)\]\]/g, '<a href="#" data-wiki-link="$1">$1</a>').replace(/`([^`]+)`/g, "<code>$1</code>");
  output = output.split(/\n{2,}/).map((block) => /^<h[1-3]>/.test(block) ? block : `<p>${block.replaceAll("\n", "<br>")}</p>`).join("");
  return output;
}

function renderWiki() {
  const pages = state.workspace.wiki;
  $("#wiki-list").innerHTML = pages.map((page) => `<button class="wiki-page ${state.wikiPage?.id === page.id ? "active" : ""}" data-wiki="${esc(page.slug)}"><strong>${esc(page.title)}</strong><span>${page.tags.map((tag) => `#${esc(tag)}`).join(" ") || esc(t("wiki.revision", { revision: page.revision, hash: short(page.contentHash, 6) }))}</span></button>`).join("") || `<div class="inspector-empty">${esc(t("wiki.noPages"))}</div>`;
  $$("[data-wiki]").forEach((button) => button.addEventListener("click", () => openWiki(button.dataset.wiki)));
  if (!state.wikiPage && !state.wikiCreating && pages[0]) void openWiki(pages[0].slug);
}

async function openWiki(slug) {
  const requestSequence = ++state.wikiRequestSequence;
  const page = await api(`/api/worlds/${encodeURIComponent(state.worldId)}/wiki/${encodeURIComponent(slug)}`);
  if (requestSequence !== state.wikiRequestSequence) return;
  state.wikiCreating = false;
  state.wikiPage = page;
  $("#wiki-title").value = state.wikiPage.title;
  $("#wiki-slug").value = state.wikiPage.slug; $("#wiki-slug").disabled = true;
  $("#wiki-tags").value = state.wikiPage.tags.join(", ");
  $("#wiki-markdown").value = state.wikiPage.markdown;
  $("#wiki-revision").textContent = t("wiki.revision", { revision: state.wikiPage.revision, hash: short(state.wikiPage.contentHash, 10) });
  renderWikiPreview(); renderWiki();
}

function newWiki() {
  state.wikiRequestSequence += 1;
  state.wikiCreating = true;
  state.wikiPage = null;
  $("#wiki-title").value = ""; $("#wiki-slug").value = ""; $("#wiki-slug").disabled = false; $("#wiki-tags").value = ""; $("#wiki-markdown").value = state.locale === "zh-CN" ? "# 新页面\n\n" : "# New page\n\n"; $("#wiki-revision").textContent = t("wiki.newPage"); renderWikiPreview(); renderWiki();
}

function renderWikiPreview() {
  $("#wiki-rendered").innerHTML = markdown($("#wiki-markdown").value);
  $("#wiki-backlinks").innerHTML = state.wikiPage?.backlinks?.length ? state.wikiPage.backlinks.map((page) => `<button class="entity-chip" data-wiki-backlink="${esc(page.slug)}">${esc(page.title)}</button>`).join("") : esc(t("wiki.noBacklinks"));
  $$("[data-wiki-backlink]").forEach((button) => button.addEventListener("click", () => openWiki(button.dataset.wikiBacklink)));
}

async function saveWiki() {
  const slug = $("#wiki-slug").value.trim() || $("#wiki-title").value.trim();
  const expectedRevision = state.wikiPage?.revision ?? 0;
  const savedPage = await task(t("wiki.taskSave"), () => api(`/api/worlds/${encodeURIComponent(state.worldId)}/wiki/${encodeURIComponent(slug)}`, { method: "PUT", body: JSON.stringify({ title: $("#wiki-title").value, markdown: $("#wiki-markdown").value, tags: $("#wiki-tags").value.split(",").map((tag) => tag.trim()).filter(Boolean), expectedRevision }) }));
  state.wikiPage = savedPage;
  state.wikiCreating = false;
  await refreshWorld();
  await openWiki(savedPage.slug);
  toast(t("wiki.saved"));
}

function renderRun() {
  const control = state.control;
  const status = control?.status ?? "no-control";
  $("#run-status").textContent = valueLabel("status", status); $("#run-status").className = `status ${status}`; $("#run-status").dataset.status = status;
  $("#run-start").disabled = Boolean(control && !["complete", "failed"].includes(control.status));
  $("#run-step").disabled = control?.status !== "running";
  $("#run-pause").disabled = control?.status !== "running";
  $("#run-resume").disabled = control?.status !== "paused";
  $("#run-complete").disabled = control?.status !== "running";
  const current = control?.nextBoundaryIndex ?? 0, total = control?.boundaryCount ?? 7, percent = total ? Math.round(current / total * 100) : 0;
  $("#run-progress").innerHTML = `<progress class="progress-track" max="100" value="${percent}">${percent}%</progress><div class="progress-meta"><span>${esc(t("run.committed", { current, total }))}</span><span>${percent}%</span></div>${control?.finalRunId ? `<p class="muted">${esc(t("run.final", { id: control.finalRunId }))}</p>` : ""}`;
  const closure = state.workspace.run?.closure;
  $("#closure").innerHTML = closure ? `<div class="closure-card"><strong data-status="${esc(closure.status)}">${esc(valueLabel("status", closure.status))}</strong><span>${esc(t("run.dependencies", { dependencies: closure.causalDependencyCount, feedbacks: closure.crossBoundaryFeedbackCount }))}</span></div><div class="dimension-list">${closure.activatedDimensions.map((dimension) => `<span class="dimension" title="${esc(dimension)}">${esc(dimension)}</span>`).join("")}</div><div class="closure-card"><strong>${closure.loops.filter((loop) => loop.closed).length}/${closure.loops.length}</strong><span>${esc(t("run.feedbackFamilies", { closed: closure.loops.filter((loop) => loop.closed).length, total: closure.loops.length, scales: closure.scalesActivated.length }))}</span></div>` : `<div class="inspector-empty">${esc(t("run.noClosure"))}</div>`;
}

async function startRun() {
  const control = await task(t("run.taskCreate"), () => api(`/api/worlds/${encodeURIComponent(state.worldId)}/runs`, { method: "POST", body: JSON.stringify({ seed: $("#run-seed").value.trim() }) }));
  state.control = { ...control, boundaryCount: control.plan.boundaries.length }; renderRun(); toast(t("run.ready"));
}

async function runAction(action) {
  if (!state.control) return;
  const result = await task(action === "run-to-complete" ? t("run.taskComplete") : t("run.taskBoundary"), () => api(`/api/worlds/${encodeURIComponent(state.worldId)}/controls/${encodeURIComponent(state.control.id)}/actions`, { method: "POST", body: JSON.stringify({ action }) }));
  state.control = { ...result, boundaryCount: result.plan.boundaries.length };
  await refreshWorld();
  toast(result.status === "complete" ? t("run.complete") : t("run.status", { status: valueLabel("status", result.status) }));
}

function renderHistoryControls(selectedId) {
  if (!state.workspace) return;
  const nodes = state.workspace.graph.nodes;
  const select = $("#history-object");
  const current = selectedId ?? select.value ?? state.selectedEntity?.id;
  select.innerHTML = nodes.map((node) => `<option value="${esc(node.id)}" ${node.id === current ? "selected" : ""}>${esc(labelFor(node))} · ${esc(node.type)}</option>`).join("");
  renderHistoryFields();
  $("#history-branch").disabled = !state.workspace.run;
  $("#history-explain").disabled = !state.workspace.run;
}

function renderHistoryFields() {
  const object = state.workspace?.graph.nodes.find((node) => node.id === $("#history-object").value);
  const current = $("#history-field").value;
  $("#history-field").innerHTML = object ? Object.keys(object.attributes).map((field) => `<option value="${esc(field)}" ${field === current ? "selected" : ""}>${esc(field)}</option>`).join("") : "";
  const value = object?.attributes?.[$("#history-field").value];
  if (value !== undefined) $("#history-value").value = JSON.stringify(value);
}

function historyTarget() { return { kind: "node", id: $("#history-object").value, fieldId: $("#history-field").value }; }

async function createBranch() {
  const target = historyTarget(), mode = $("#history-mode").value, runId = state.workspace.run?.id;
  if (!runId) throw new Error(t("history.mustComplete"));
  const base = { worldId: state.worldId, id: `request:workspace:${Date.now()}`, parentRunId: runId, target: { ...target, worldTime: Number($("#history-time").value) }, reason: $("#history-reason").value };
  const request = mode === "intervention" ? { ...base, mode, action: { kind: "set-node-attribute", nodeId: target.id, fieldId: target.fieldId, value: JSON.parse($("#history-value").value) } } : { ...base, mode, prompt: $("#history-prompt").value, permittedLevers: ["bounded actor and organization choices"], protectedFacts: [], forbiddenEffects: ["guaranteed success", "pre-authored outcome"] };
  const evidence = await task(t("history.taskBranch"), () => api(`/api/worlds/${encodeURIComponent(state.worldId)}/branches`, { method: "POST", body: JSON.stringify({ request }) }));
  renderHistoryEvidence(evidence); await refreshWorld(); toast(t("history.branchSaved"));
}

function listPaths(paths) { return paths.length ? `<div class="path-list">${paths.slice(0, 20).map((path) => `<code>${esc(path)}</code>`).join("")}</div>` : `<span class="muted">${esc(t("history.none"))}</span>`; }
function renderHistoryEvidence(evidence, remember = true) {
  if (remember) state.historyResult = { kind: "branch", value: evidence };
  const verified = evidence.comparison.protectedPrefixVerified ? t("history.verified") : t("history.notVerified");
  $("#history-result").innerHTML = `<div class="evidence-block"><h3>${esc(t("history.prefix"))}</h3><p>${esc(t("history.prefixSummary", { verified, anchor: evidence.anchorBoundaryId, time: evidence.anchorWorldTime, count: evidence.comparison.commonPrefixInputCount }))}</p></div><div class="evidence-block"><h3>${esc(t("history.changed"))}</h3>${listPaths(evidence.comparison.changedPaths)}</div><div class="evidence-block"><h3>${esc(t("history.audit"))}</h3>${listPaths(evidence.comparison.auditChangedPaths)}</div><div class="evidence-block"><h3>${esc(t("history.forward"))}</h3><p>${esc(t("history.forwardSummary", { emissions: evidence.impact.emissionIds.length, boundaries: evidence.impact.boundaryIds.length }))}</p>${listPaths(evidence.impact.writtenPaths)}</div><div class="evidence-block"><h3>${esc(t("history.backward"))}</h3><p>${esc(t("history.backwardSummary", { status: valueLabel("status", evidence.targetAfter.status), steps: evidence.targetAfter.steps.length, roots: evidence.initialConditionRoots.length }))}</p></div><div class="evidence-block"><h3>${esc(t("history.uncertainty"))}</h3>${evidence.unresolvedUncertainty.length ? `<ul>${evidence.unresolvedUncertainty.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>` : esc(t("history.noneRecorded"))}</div><p class="muted">${esc(t("history.evidenceHash", { hash: short(evidence.evidenceHash, 14) }))}</p>`;
}

async function explainSelection() {
  const explanation = await task(t("history.taskExplain"), () => api(`/api/worlds/${encodeURIComponent(state.worldId)}/explain`, { method: "POST", body: JSON.stringify({ runId: state.workspace.run.id, target: historyTarget() }) }));
  renderExplanation(explanation);
}

function renderExplanation(explanation, remember = true) {
  if (remember) state.historyResult = { kind: "explanation", value: explanation };
  $("#history-result").innerHTML = `<div class="evidence-block"><h3>${esc(explanation.targetPath)}</h3><p>${esc(t("history.explainSummary", { status: valueLabel("status", explanation.status), steps: explanation.steps.length, roots: explanation.externalCauseInputIds.length }))}</p></div><div class="evidence-block"><h3>${esc(t("history.initialRoots"))}</h3>${listPaths(explanation.initialConditionPaths)}</div><div class="evidence-block"><h3>${esc(t("history.mechanism"))}</h3>${explanation.steps.map((step) => `<p><strong>${esc(step.mechanismId)}</strong><br>${esc(step.boundaryId)} · <span title="${esc(step.scale)}">${esc(valueLabel("scale", step.scale))}</span> · ${esc(step.triggerSummary)}</p>`).join("") || esc(t("history.noWriter"))}</div>`;
}

async function loadTemplate() {
  const suffix = Math.random().toString(36).slice(2, 8);
  const response = await api(`/api/templates/world?worldId=${encodeURIComponent(`world.untitled-${suffix}`)}&title=${encodeURIComponent(t("author.untitledWorld"))}`);
  $("#author-json").value = JSON.stringify(response.definition, null, 2); state.authorRevision = 0; state.authorResult = null; $("#author-results").innerHTML = "";
}

async function loadSavedDraft() {
  if (!state.worldId) throw new Error(t("author.selectFirst"));
  const response = await api(`/api/worlds/${encodeURIComponent(state.worldId)}/drafts`);
  const draft = response.drafts[0];
  if (!draft) throw new Error(t("author.noDraft"));
  $("#author-json").value = JSON.stringify(draft.definition, null, 2);
  state.authorRevision = draft.revision;
  renderAuthorResult(draft);
  toast(t("author.loaded", { draftId: draft.draftId, revision: draft.revision }));
}

function parsedDefinition() { try { return JSON.parse($("#author-json").value); } catch (error) { throw new Error(t("author.invalidJson", { message: error.message })); } }
function renderAuthorResult(result, remember = true) {
  if (remember) state.authorResult = result;
  if (result.contract) { $("#author-results").innerHTML = `<div class="success-card"><strong>${esc(t("author.accepted"))}</strong><br>${esc(result.contract.hash)}<br>${esc(t("author.instance", { id: result.instance.id }))}</div>`; return; }
  const questions = result.questions ?? [], issues = result.issues ?? [];
  $("#author-results").innerHTML = `${questions.map((item) => `<div class="question"><strong>${esc(item.section)} · ${esc(item.code)}</strong><br>${esc(localizedQuestion(state.locale, item, "prompt"))}<br><span class="muted">${esc(localizedQuestion(state.locale, item, "why"))}</span></div>`).join("")}${issues.map((item) => `<div class="issue"><strong>${esc(item.path)} · ${esc(item.code)}</strong><br>${esc(localizedIssue(state.locale, item))}</div>`).join("")}${!questions.length && !issues.length ? `<div class="success-card">${esc(t("author.ready"))}</div>` : ""}`;
}

async function inspectAuthor() { renderAuthorResult(await api("/api/worlds/inspect", { method: "POST", body: JSON.stringify({ definition: parsedDefinition() }) })); }
async function saveAuthor() {
  const definition = parsedDefinition();
  const draft = await task(t("author.taskSave"), () => api(`/api/worlds/${encodeURIComponent(definition.worldId)}/drafts/${encodeURIComponent(definition.draftId)}`, { method: "PUT", body: JSON.stringify({ definition, expectedRevision: state.authorRevision }) }));
  state.authorRevision = draft.revision; renderAuthorResult(draft); toast(t("author.saved", { revision: draft.revision }));
}
async function compileAuthor() {
  const definition = parsedDefinition();
  if (state.authorRevision === 0) await saveAuthor();
  const result = await task(t("author.taskCompile"), () => api(`/api/worlds/${encodeURIComponent(definition.worldId)}/drafts/${encodeURIComponent(definition.draftId)}/compile`, { method: "POST", body: "{}" }));
  renderAuthorResult(result); await loadWorlds(); await selectWorld(definition.worldId); toast(t("author.compiled"));
}

async function exportBook() {
  const value = await task(t("export.task"), () => api(`/api/worlds/${encodeURIComponent(state.worldId)}/exports`, { method: "POST", body: JSON.stringify({ runId: state.workspace.run?.id }) }));
  const blob = new Blob([value.markdown], { type: "text/markdown" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = value.filename; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); toast(t("export.done", { filename: value.filename }));
}

async function refreshWorld() {
  if (!state.worldId) return;
  state.workspace = await api(`/api/worlds/${encodeURIComponent(state.worldId)}/workspace`);
  const found = state.control && state.workspace.controls.find((control) => control.id === state.control.id);
  state.control = found ?? state.workspace.controls[0] ?? null;
  renderWorkspace();
}

async function searchAll(query) {
  const term = query.trim().toLowerCase(); renderEntities(term);
  if (state.view === "wiki" && state.worldId) {
    const response = await api(`/api/worlds/${encodeURIComponent(state.worldId)}/wiki?q=${encodeURIComponent(query)}`);
    state.workspace.wiki = response.pages; renderWiki();
  }
}

function wire() {
  $$('[data-locale]').forEach((button) => button.addEventListener("click", () => setLocale(button.dataset.locale)));
  $$(".tab").forEach((tab) => tab.addEventListener("click", () => setView(tab.dataset.view)));
  $("#new-world").addEventListener("click", async () => { setView("author"); await loadTemplate(); });
  $("#entity-filter").addEventListener("input", (event) => renderEntities(event.target.value));
  $("#global-search").addEventListener("input", (event) => searchAll(event.target.value));
  $("#wiki-search").addEventListener("input", async (event) => { const response = await api(`/api/worlds/${encodeURIComponent(state.worldId)}/wiki?q=${encodeURIComponent(event.target.value)}`); state.workspace.wiki = response.pages; renderWiki(); });
  $("#wiki-new").addEventListener("click", newWiki); $("#wiki-save").addEventListener("click", () => saveWiki()); $("#wiki-markdown").addEventListener("input", renderWikiPreview);
  $("#run-start").addEventListener("click", () => startRun()); $("#run-step").addEventListener("click", () => runAction("advance")); $("#run-pause").addEventListener("click", () => runAction("pause")); $("#run-resume").addEventListener("click", () => runAction("resume")); $("#run-complete").addEventListener("click", () => runAction("run-to-complete"));
  $("#history-object").addEventListener("change", renderHistoryFields); $("#history-field").addEventListener("change", renderHistoryFields); $("#history-mode").addEventListener("change", (event) => { $("#history-value-wrap").classList.toggle("hidden", event.target.value !== "intervention"); $("#history-prompt-wrap").classList.toggle("hidden", event.target.value !== "soft-guidance"); });
  $("#history-branch").addEventListener("click", () => createBranch()); $("#history-explain").addEventListener("click", () => explainSelection());
  $("#author-template").addEventListener("click", () => loadTemplate()); $("#author-load").addEventListener("click", () => loadSavedDraft()); $("#author-inspect").addEventListener("click", () => inspectAuthor()); $("#author-save").addEventListener("click", () => saveAuthor()); $("#author-compile").addEventListener("click", () => compileAuthor());
  $("#export-book").addEventListener("click", () => exportBook());
}

wire();
applyStaticTranslations();
loadWorlds().catch((error) => toast(error.message, true));
