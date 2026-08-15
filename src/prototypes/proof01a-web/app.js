const API_URL = "/api/proof01a";
const VARIANTS = ["A", "B", "C"];
const A_VIEWS = ["overview", "character", "relationships", "events", "proof"];
const FALLBACK_WORLD_HISTORY = [
  { id: "history-town-register", day: 0, fact: "The town register contains every resident in this prototype." },
  { id: "history-road-closed", day: 1, fact: "Flooding closed the only grain road into town." },
];
const WORLD_FACT_ZH = {
  "history-town-register": "城镇名册包含这个原型中的每一位居民。",
  "history-road-closed": "洪水切断了进入小镇的唯一运粮道路。",
};
const CLAIM_TEXT_ZH = {
  "claim:official-road-report": "北方补给路被暴风雨阻断，预定的运粮车无法通过。",
  "claim:council-reservation-order": "根据议会决定，在镇粮仓保留六十袋粮食。",
};
const CONCERN_TEXT_ZH = {
  "market-grain-access": "能否继续从市场获得粮食",
  "household-grain-duration": "家中余粮还能维持多久",
};

const root = document.querySelector("#app-root");

const state = {
  payload: null,
  phase: readPhase(),
  variant: readVariant(),
  view: readView(),
  note: "世界仍处于低分辨率。聚焦不会创造替代身份，也不会重写历史。",
  loading: true,
  error: null,
};

function readVariant() {
  const requested = new URL(window.location.href).searchParams.get("variant")?.toUpperCase();
  return VARIANTS.includes(requested) ? requested : "A";
}

function readView() {
  const requested = new URL(window.location.href).searchParams.get("view");
  return A_VIEWS.includes(requested) ? requested : "overview";
}

function readPhase() {
  return new URL(window.location.href).searchParams.get("phase") === "after" ? "after" : "before";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function number(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function shortHash(value) {
  const text = String(value ?? "—");
  return text.length > 18 ? `${text.slice(0, 10)}…${text.slice(-6)}` : text;
}

function currentSummary(model) {
  return model.phase === "after" ? model.after : model.before;
}

function focusedResident(summary) {
  return Array.isArray(summary?.focusedResidents) ? summary.focusedResidents[0] ?? null : null;
}

function worldHistory(model) {
  return Array.isArray(model.worldHistory) && model.worldHistory.length > 0
    ? model.worldHistory
    : FALLBACK_WORLD_HISTORY;
}

function readableWorldFact(event) {
  return WORLD_FACT_ZH[event?.id] ?? event?.fact ?? "世界历史正文尚未提供。";
}

function readableClaim(claim) {
  return CLAIM_TEXT_ZH[claim?.id] ?? claim?.proposition ?? "命题正文尚未提供。";
}

function readableConcern(value) {
  return CONCERN_TEXT_ZH[value] ?? value ?? "尚未展开";
}

function targetRecord(model) {
  const record = model.targetResidentRecord;
  return record && typeof record === "object"
    ? record
    : {
        id: model.residentId,
        populationGroupId: "尚未提供",
        grainContribution: 0,
        committedHistoryEventIds: worldHistory(model).map((event) => event.id),
      };
}

function deriveChecks(model) {
  const before = model.before;
  const current = currentSummary(model);
  const promoted = number(current.promotionCount) > 0;
  const resident = focusedResident(current);
  const lastPromotion = current.lastPromotion;
  const residentCount = number(current.residentCount);
  const populationReconciles =
    residentCount === number(before.residentCount) &&
    number(current.residualCount) + number(current.detailedCount) === residentCount;
  const totalGrain = number(current.totalGrain);
  const grainReconciles =
    totalGrain === number(before.totalGrain) &&
    number(current.residualGrain) + number(current.detailedGrain) === totalGrain;
  const historyUnchanged =
    current.historyHash === before.historyHash &&
    number(current.historyEventCount) === number(before.historyEventCount);
  const identityPreserved = promoted &&
    lastPromotion?.residentId === model.residentId &&
    resident?.id === model.residentId &&
    resident?.continuityRecordId === model.residentId;
  const repeated = promoted && current.projectionHash === model.after.projectionHash;

  return [
    {
      id: "identity",
      label: "稳定身份",
      status: promoted ? (identityPreserved ? "passed" : "failed") : "pending",
      detail: promoted
        ? `${model.residentId} 与其连续性记录仍是同一个对象`
        : `等待聚焦 ${model.residentId}`,
    },
    {
      id: "population",
      label: "人口守恒",
      status: populationReconciles ? "passed" : "failed",
      detail: `${number(current.residualCount)} 低分辨率 + ${number(current.detailedCount)} 详细 = ${residentCount}`,
    },
    {
      id: "grain",
      label: "粮食守恒",
      status: grainReconciles ? "passed" : "failed",
      detail: `${number(current.residualGrain)} 群体账本 + ${number(current.detailedGrain)} 人物账本 = ${totalGrain}`,
    },
    {
      id: "history",
      label: "既有历史未改写",
      status: historyUnchanged ? "passed" : "failed",
      detail: `${number(current.historyEventCount)} 个事件，历史哈希与基线一致`,
    },
    {
      id: "repeat",
      label: "同输入可重现",
      status: promoted ? (repeated ? "passed" : "failed") : "pending",
      detail: promoted ? "相同初态与聚焦请求得到相同投影" : "聚焦后检查确定性投影",
    },
  ];
}

function statusLabel(status) {
  return status === "passed" ? "通过" : status === "failed" ? "失败" : "待验证";
}

function renderChecks(checks, { compact = false } = {}) {
  return `
    <ol class="check-list${compact ? " compact" : ""}">
      ${checks.map((check, index) => `
        <li class="check-item ${check.status}">
          <span class="check-index mono">0${index + 1}</span>
          <span class="check-copy">
            <strong>${escapeHtml(check.label)}</strong>
            <small>${escapeHtml(check.detail)}</small>
          </span>
          <span class="status ${check.status}">${statusLabel(check.status)}</span>
        </li>
      `).join("")}
    </ol>
  `;
}

function renderActionBar(model, label = "聚焦普通居民") {
  const focused = model.phase === "after";
  return `
    <div class="action-bar" role="group" aria-label="原型操作">
      <button class="action-button primary" type="button" data-action="focus" ${focused ? "disabled" : ""}>
        <span aria-hidden="true">◎</span>
        ${focused ? `${escapeHtml(model.residentId)} 已聚焦` : `${escapeHtml(label)} ${escapeHtml(model.residentId)}`}
      </button>
      <button class="action-button secondary" type="button" data-action="reset" ${focused ? "" : "disabled"}>
        <span aria-hidden="true">↺</span> 重置世界
      </button>
    </div>
  `;
}

function renderVariantSwitcher(activeVariant) {
  const names = {
    A: ["A", "世界工作台"],
    B: ["B", "因果画布"],
    C: ["C", "时间对照"],
  };
  return `
    <nav class="variant-switcher" aria-label="切换视觉方案">
      <span class="variant-hint">视觉方案</span>
      ${VARIANTS.map((variant) => `
        <button
          class="variant-button${activeVariant === variant ? " active" : ""}"
          type="button"
          data-variant="${variant}"
          aria-pressed="${activeVariant === variant}"
          title="${names[variant][1]}"
        ><b>${names[variant][0]}</b><span>${names[variant][1]}</span></button>
      `).join("")}
      <span class="keyboard-hint mono">← →</span>
    </nav>
  `;
}

function renderMetric(label, value, detail = "", modifier = "") {
  return `
    <article class="metric-card ${modifier}">
      <span class="metric-label">${escapeHtml(label)}</span>
      <strong class="metric-value">${escapeHtml(value)}</strong>
      ${detail ? `<small>${escapeHtml(detail)}</small>` : ""}
    </article>
  `;
}

function renderHashes(summary) {
  return `
    <dl class="state-ledger hash-ledger">
      <div><dt>历史哈希</dt><dd class="mono" title="${escapeHtml(summary.historyHash)}">${escapeHtml(summary.historyHash)}</dd></div>
      <div><dt>承诺哈希</dt><dd class="mono" title="${escapeHtml(summary.committedHistoryHash)}">${escapeHtml(summary.committedHistoryHash)}</dd></div>
      <div><dt>投影哈希</dt><dd class="mono" title="${escapeHtml(summary.projectionHash)}">${escapeHtml(summary.projectionHash)}</dd></div>
    </dl>
  `;
}

function renderResidentDetail(model) {
  const summary = currentSummary(model);
  const resident = focusedResident(summary);
  const continuity = targetRecord(model);
  const groupId = resident?.populationGroupId ?? continuity.populationGroupId ?? "尚未提供";
  const grainContribution = number(resident?.grainContribution, number(continuity.grainContribution));
  const inheritedEventIds = resident?.inheritedHistoryEventIds ?? continuity.committedHistoryEventIds ?? [];
  if (!resident) {
    return `
      <article class="resident-card dormant">
        <div class="resident-avatar" aria-hidden="true">42</div>
        <div>
          <p class="eyebrow">LOW RESOLUTION · 稳定身份</p>
          <h2>${escapeHtml(model.residentId)}</h2>
          <p>这个人已经存在于城镇名册和群体账本中，但当前没有独立的详细人物模型。</p>
          <dl class="inline-facts">
            <div><dt>连续性记录 / 稳定 ID</dt><dd class="mono">${escapeHtml(continuity.id ?? model.residentId)}</dd></div>
            <div><dt>分辨率</dt><dd>群体成员</dd></div>
            <div><dt>人口分组</dt><dd>${escapeHtml(groupId)}</dd></div>
            <div><dt>粮食贡献</dt><dd>${grainContribution} 袋，包含在 ${number(summary.residualGrain)} 袋群体账本中</dd></div>
            <div><dt>继承事件</dt><dd>${inheritedEventIds.map(escapeHtml).join(" · ") || "尚未提供"}</dd></div>
          </dl>
        </div>
      </article>
    `;
  }
  return `
    <article class="resident-card focused">
      <div class="resident-avatar" aria-hidden="true">42</div>
      <div class="resident-copy">
        <p class="eyebrow">FOCUSED · 同一居民，分辨率提高</p>
        <h2>${escapeHtml(resident.id)}</h2>
        <p class="resident-concern">当前关切：<strong>${escapeHtml(readableConcern(resident.currentConcern))}</strong></p>
        <dl class="inline-facts">
          <div><dt>连续性记录</dt><dd class="mono">${escapeHtml(resident.continuityRecordId)}</dd></div>
          <div><dt>所属群体</dt><dd>${escapeHtml(groupId)}</dd></div>
          <div><dt>独立账本贡献</dt><dd>${grainContribution} 袋</dd></div>
          <div><dt>继承历史</dt><dd>${inheritedEventIds.map(escapeHtml).join(" · ") || "尚未提供"}</dd></div>
        </dl>
      </div>
    </article>
  `;
}

function renderPromotion(summary, residentId) {
  const promotion = summary.lastPromotion;
  if (!promotion) {
    return `
      <article class="promotion-record pending">
        <span class="status pending">尚未发生</span>
        <h3>Focus Promotion Request</h3>
        <p>请求将只提高 ${escapeHtml(residentId)} 的观察分辨率。</p>
      </article>
    `;
  }
  return `
    <article class="promotion-record passed">
      <span class="status passed">已提交</span>
      <h3>${escapeHtml(promotion.id)}</h3>
      <dl class="state-ledger">
        <div><dt>类型</dt><dd>${escapeHtml(promotion.kind)}</dd></div>
        <div><dt>居民</dt><dd class="mono">${escapeHtml(promotion.residentId)}</dd></div>
        <div><dt>转移粮食</dt><dd>${number(promotion.transferredGrainContribution)} 袋</dd></div>
        <div><dt>所据历史</dt><dd class="mono">${escapeHtml(promotion.worldHistoryHash)}</dd></div>
      </dl>
    </article>
  `;
}

function renderWorldState(summary) {
  return `
    <div class="metric-grid">
      ${renderMetric("登记居民", summary.residentCount, "稳定身份总数")}
      ${renderMetric("低分辨率", summary.residualCount, "仍留在群体账本")}
      ${renderMetric("详细人物", summary.detailedCount, "已建立独立视图", summary.detailedCount ? "accent" : "")}
      ${renderMetric("粮食总量", summary.totalGrain, `${number(summary.residualGrain)} 群体 + ${number(summary.detailedGrain)} 独立`)}
      ${renderMetric("历史事件", summary.historyEventCount, "已承诺且不可改写")}
      ${renderMetric("晋升记录", summary.promotionCount, "只存在于当前内存")}
    </div>
  `;
}

const A_VIEW_META = {
  overview: { icon: "◫", label: "世界总览", eyebrow: "WORLD OVERVIEW" },
  character: { icon: "◎", label: "人物详情", eyebrow: "INDIVIDUAL ACTOR" },
  relationships: { icon: "⌘", label: "人物关系", eyebrow: "RELATIONSHIPS" },
  events: { icon: "≡", label: "事件与时间线", eyebrow: "EVENT HISTORY" },
  proof: { icon: "✓", label: "推演检查", eyebrow: "ENGINE PROOF" },
};

function anchoredFinalState(model) {
  const finalState = model.anchoredRun?.finalState;
  return finalState && typeof finalState === "object" ? finalState : {};
}

function anchoredActor(model, actorId) {
  return anchoredFinalState(model).actors?.[actorId] ?? {};
}

function anchoredClaim(model, claimId) {
  return anchoredFinalState(model).claims?.[claimId] ?? {};
}

function anchoredPlaceName(model, placeId) {
  return anchoredFinalState(model).places?.[placeId]?.name ?? placeId ?? "尚未提供";
}

function worldClock(instant) {
  if (!instant || typeof instant.worldTime !== "number") return "尚未提供";
  const minutes = number(instant?.worldTime);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function renderRunAuthority(model) {
  const manifest = model.anchoredRun?.manifest ?? {};
  const status = model.anchoredRun?.status ?? "unknown";
  return `
    <div class="run-authority">
      ${renderEvidenceBadge("committed")}
      <span class="mono">${escapeHtml(manifest.runId ?? "run:proof00:anchored:v1")}</span>
      <span>${escapeHtml(status)}</span>
    </div>
  `;
}

function renderAViewLink(view, suffix = "") {
  const meta = A_VIEW_META[view];
  const active = view === state.view;
  return `
    <a
      href="?variant=A&amp;view=${view}&amp;phase=${state.phase}"
      data-view="${view}"
      class="view-link${active ? " active" : ""}"
      ${active ? 'aria-current="page"' : ""}
    ><span aria-hidden="true">${meta.icon}</span> ${meta.label}${suffix}</a>
  `;
}

function renderEvidenceBadge(kind) {
  const labels = {
    committed: ["passed", "已承诺事实"],
    derived: ["pending", "引擎解释"],
    draft: ["pending", "创作草案"],
    unresolved: ["pending", "未建模"],
    external: ["pending", "作者操作"],
  };
  const [status, label] = labels[kind] ?? labels.unresolved;
  return `<span class="status ${status} evidence-badge evidence-${kind}">${label}</span>`;
}

function renderAOverview(model) {
  const summary = currentSummary(model);
  const resident = focusedResident(summary);
  const continuity = targetRecord(model);
  const events = worldHistory(model);
  const roadEvent = events.find((event) => event.id === "history-road-closed") ?? events.at(-1);
  const focused = model.phase === "after";
  return `
    <article class="workspace-view workspace-overview" data-workspace-view="overview">
      <header class="document-header view-header">
        <p class="eyebrow">${A_VIEW_META.overview.eyebrow}</p>
        <h1 id="variant-a-title">断路小镇，现在发生了什么？</h1>
        <p class="lede">${escapeHtml(readableWorldFact(roadEvent))} 镇上登记着 ${number(summary.residentCount)} 名居民，粮食账本共 ${number(summary.totalGrain)} 袋；世界尚未推演人群之后会合作、囤积还是冲突。</p>
        ${renderActionBar(model, "从人群中聚焦")}
      </header>

      <section class="document-section story-summary" aria-labelledby="situation-title">
        <div class="section-heading"><div><p class="eyebrow">SITUATION BRIEF</p><h2 id="situation-title">场景简述</h2></div>${renderEvidenceBadge("committed")}</div>
        <div class="brief-grid">
          <article class="panel narrative-card">
            <h3>危机</h3>
            <p>第 1 天，洪水关闭了进入小镇的唯一粮食道路。当前切片只提交了道路关闭这一事实，还没有模拟恢复时间、市场反应或居民选择。</p>
          </article>
          <article class="panel narrative-card">
            <h3>焦点人物</h3>
            <p>${focused
              ? `${escapeHtml(model.residentId)} 是 ${escapeHtml(resident?.populationGroupId ?? continuity.populationGroupId)} 的一名普通居民。聚焦后只新增了一个与粮食危机相关的当前关切：${escapeHtml(readableConcern(resident?.currentConcern))}。`
              : `${escapeHtml(model.residentId)} 已经是名册中的同一个人，属于 ${escapeHtml(continuity.populationGroupId)}；姓名、经历、心理与人际关系仍未展开。`}</p>
          </article>
          <article class="panel narrative-card">
            <h3>我们正在证明</h3>
            <p>作者能否看清一个普通人，同时不改变既有历史，不制造额外人口，也不凭空增加或丢失粮食。</p>
          </article>
        </div>
      </section>

      <section class="document-section" aria-labelledby="world-state-title">
        <div class="section-heading"><div><p class="eyebrow">CURRENT WORLD</p><h2 id="world-state-title">当前世界状态</h2></div><span class="mono">${shortHash(summary.projectionHash)}</span></div>
        ${renderWorldState(summary)}
      </section>

      <section class="document-section view-directory" aria-labelledby="continue-title">
        <div class="section-heading"><div><p class="eyebrow">EXPLORE</p><h2 id="continue-title">继续查看</h2></div></div>
        <div class="directory-grid">
          <a href="?variant=A&amp;view=character&amp;phase=${model.phase}" data-view="character" class="directory-card"><span>01</span><strong>人物详情</strong><small>简述、当前关切、动机与信念边界</small></a>
          <a href="?variant=A&amp;view=relationships&amp;phase=${model.phase}" data-view="relationships" class="directory-card"><span>02</span><strong>人物关系</strong><small>已提交的归属与尚未实现的人际网络</small></a>
          <a href="?variant=A&amp;view=events&amp;phase=${model.phase}" data-view="events" class="directory-card"><span>03</span><strong>事件时间线</strong><small>原因、结果、影响与未决后果</small></a>
          <a href="?variant=A&amp;view=proof&amp;phase=${model.phase}" data-view="proof" class="directory-card"><span>04</span><strong>推演检查</strong><small>前后对照、守恒与确定性</small></a>
        </div>
      </section>
    </article>
  `;
}

function renderAnchoredMara(model) {
  const mara = anchoredActor(model, "actor:chair-mara");
  const roles = mara.organizationRoles?.["organization:town-council"] ?? [];
  const claimIds = mara.epistemicState?.accessibleClaimIds ?? [];
  const claims = claimIds.map((id) => anchoredClaim(model, id));
  const hasRun = Boolean(mara.id);
  if (!hasRun) {
    return `<article class="panel unavailable-card"><h3>Proof 00 Anchored Run 尚未载入</h3><p>这个区域只读取 API 提供的真实 Run，不用创作文案替代。</p></article>`;
  }
  return `
    <article class="anchored-character-card">
      <header class="anchored-character-header">
        <div class="resident-avatar mara-avatar" aria-hidden="true">M</div>
        <div><p class="eyebrow">DETAILED ACTOR EXAMPLE</p><h3>${escapeHtml(mara.name)} <small>${escapeHtml(mara.id)}</small></h3><p>镇议会主席。她在 04:00 收到正式道路报告后形成保留粮食的立场，并通过议会程序产生储备命令。</p></div>
      </header>
      <dl class="inline-facts actor-facts">
        <div><dt>位置</dt><dd>${escapeHtml(anchoredPlaceName(model, mara.location?.placeId))}</dd></div>
        <div><dt>组织角色</dt><dd>${roles.map(escapeHtml).join(" · ") || "无"}</dd></div>
        <div><dt>当前立场</dt><dd>${escapeHtml(mara.currentPosition ?? "尚无立场")}</dd></div>
        <div><dt>决策记录</dt><dd>${(mara.decisionHistory ?? []).map(escapeHtml).join(" · ") || "无"}</dd></div>
      </dl>
      <div class="accessible-claims">
        <h4>她可以访问的信息</h4>
        ${claims.length > 0 ? claims.map((claim) => `<blockquote><p>${escapeHtml(readableClaim(claim))}</p><cite class="mono">${escapeHtml(claim.id ?? "claim:unknown")}</cite></blockquote>`).join("") : "<p>无可访问 Claim。</p>"}
      </div>
    </article>
  `;
}

function renderACharacter(model) {
  const summary = currentSummary(model);
  const resident = focusedResident(summary);
  const continuity = targetRecord(model);
  const focused = model.phase === "after";
  const concern = readableConcern(resident?.currentConcern);
  return `
    <article class="workspace-view character-view" data-workspace-view="character">
      <header class="document-header view-header character-header">
        <p class="eyebrow">${A_VIEW_META.character.eyebrow} / ${escapeHtml(model.residentId)}</p>
        <h1 id="variant-a-title">居民 0042 <small>暂无姓名</small></h1>
        <p class="lede">一位在危机发生前就已存在的普通居民。这个页面明确区分引擎已经知道的内容、为了可读性做的转译，以及还没有被建模的部分。</p>
        ${renderActionBar(model, "展开人物")}
      </header>

      <section class="document-section character-summary">
        <div class="section-heading"><div><p class="eyebrow">CHARACTER BRIEF</p><h2>人物简述</h2></div>${renderEvidenceBadge("committed")}</div>
        ${renderResidentDetail(model)}
      </section>

      <section class="document-section" aria-labelledby="inner-model-title">
        <div class="section-heading"><div><p class="eyebrow">INNER MODEL</p><h2 id="inner-model-title">动机、信念与压力</h2></div></div>
        <div class="character-model-grid">
          <article class="panel model-card">
            <div class="panel-title"><h3>当前关切</h3>${renderEvidenceBadge(focused ? "derived" : "unresolved")}</div>
            <strong>${escapeHtml(concern)}</strong>
            <p>${focused ? "这是对 currentConcern 字段的中文转译，并不是完整动机模型。" : "聚焦后，原型只会按既有区域实现一个与粮食危机有关的关切。"}</p>
          </article>
          <article class="panel model-card">
            <div class="panel-title"><h3>可能的行动压力</h3>${renderEvidenceBadge("draft")}</div>
            <strong>${focused ? "确认市场准入与粮食可得性" : "待人物聚焦后判断"}</strong>
            <p>这是界面为了帮助阅读而提出的候选解释；Proof 01A 尚未提交 Want、Need、Fear 或 Plan。</p>
          </article>
          <article class="panel model-card unresolved-card">
            <div class="panel-title"><h3>信念候选</h3>${renderEvidenceBadge("draft")}</div>
            <strong>他相信市场仍会公平供应吗？</strong>
            <p>当前没有 Observation、Claim 或 Belief 记录，不能把这个问题直接写成角色事实。</p>
          </article>
          <article class="panel model-card unresolved-card">
            <div class="panel-title"><h3>人格与价值</h3>${renderEvidenceBadge("unresolved")}</div>
            <strong>尚无人格量表或价值排序</strong>
            <p>完整心理模型不是本次 MVP 的实现范围；此处不会伪造大五人格、童年经历或性格标签。</p>
          </article>
        </div>
      </section>

      <section class="document-section" aria-labelledby="known-title">
        <div class="section-heading"><div><p class="eyebrow">EPISTEMIC BOUNDARY</p><h2 id="known-title">这个人目前有多“真实”</h2></div></div>
        <div class="knowledge-columns">
          <article class="panel known-list"><h3>已承诺</h3><ul><li>稳定身份 ${escapeHtml(model.residentId)}</li><li>${escapeHtml(resident?.populationGroupId ?? continuity.populationGroupId)} 人口成员</li><li>贡献 ${number(resident?.grainContribution, number(continuity.grainContribution))} 袋粮食账本</li><li>继承 ${(continuity.committedHistoryEventIds ?? []).length} 项已承诺世界历史</li></ul></article>
          <article class="panel unknown-list"><h3>仍未实现</h3><ul><li>姓名、年龄、职业与住所</li><li>家庭成员和具体人际关系</li><li>观察到的信息及其可信程度</li><li>记忆、信念、恐惧、价值和行动计划</li></ul></article>
        </div>
      </section>

      <section class="document-section anchored-example" aria-labelledby="mara-example-title">
        <div class="section-heading"><div><p class="eyebrow">PROOF 00 · ANCHORED RUN</p><h2 id="mara-example-title">已有运行中的详细人物：Mara</h2></div>${renderRunAuthority(model)}</div>
        <p class="section-intro">这一栏不是 resident-0042 的补全结果，而是另一个已经验收的 Proof 00 Run。它展示未来人物视图可以读取哪些真实字段。</p>
        ${renderAnchoredMara(model)}
      </section>
    </article>
  `;
}

function renderCommittedInteraction({ from, to, time, type, proposition, evidence }) {
  return `
    <article class="panel committed-interaction">
      <div class="interaction-direction"><strong>${escapeHtml(from)}</strong><span aria-hidden="true">→</span><strong>${escapeHtml(to)}</strong></div>
      <div class="panel-title"><h3>${escapeHtml(type)}</h3>${renderEvidenceBadge("committed")}</div>
      <p>“${escapeHtml(proposition)}”</p>
      <dl class="inline-facts"><div><dt>送达</dt><dd>${escapeHtml(time)}</dd></div><div><dt>证据</dt><dd class="mono">${escapeHtml(evidence)}</dd></div></dl>
    </article>
  `;
}

function renderARelationships(model) {
  const summary = currentSummary(model);
  const focused = model.phase === "after";
  const resident = focusedResident(summary);
  const continuity = targetRecord(model);
  const groupId = resident?.populationGroupId ?? continuity.populationGroupId ?? "尚未提供";
  const officialReport = anchoredClaim(model, "claim:official-road-report");
  const reserveOrder = anchoredClaim(model, "claim:council-reservation-order");
  const orderMovement = anchoredFinalState(model).movements?.["movement:clerk-order"] ?? {};
  return `
    <article class="workspace-view relationships-view" data-workspace-view="relationships">
      <header class="document-header view-header">
        <p class="eyebrow">${A_VIEW_META.relationships.eyebrow} / ${escapeHtml(model.residentId)}</p>
        <h1 id="variant-a-title">关系不是一根“好感度”连线</h1>
        <p class="lede">当前原型只展示已经有依据的归属和账本关系。家庭、朋友、邻居等人际关系被保留为明确空缺，而不是为了让页面丰富就现场编造。</p>
        ${renderActionBar(model, "展开人物")}
      </header>

      <section class="document-section relation-map-section" aria-labelledby="relation-map-title">
        <div class="section-heading"><div><p class="eyebrow">RELATION MAP</p><h2 id="relation-map-title">当前可见关系</h2></div></div>
        <div class="relation-board" role="img" aria-label="居民 0042 与小镇、人口分组、市场和未知人际网络的关系">
          <article class="relation-node subject-node"><small>人物</small><strong>${escapeHtml(model.residentId)}</strong><span>${focused ? "详细视图" : "低分辨率"}</span></article>
          <article class="relation-node world-node"><small>成员资格</small><strong>断路小镇</strong><span>${number(summary.residentCount)} 名登记居民</span></article>
          <article class="relation-node group-node"><small>人口归属</small><strong>${escapeHtml(groupId)}</strong><span>已承诺事实</span></article>
          <article class="relation-node concern-node"><small>情境关联</small><strong>粮食市场</strong><span>${focused ? "当前关切指向市场准入" : "聚焦后可能变得相关"}</span></article>
          <article class="relation-node unknown-node"><small>人际网络</small><strong>家庭 / 朋友 / 邻居</strong><span>尚未建模</span></article>
        </div>
      </section>

      <section class="document-section" aria-labelledby="relation-ledger-title">
        <div class="section-heading"><div><p class="eyebrow">RELATIONSHIP LEDGER</p><h2 id="relation-ledger-title">关系说明</h2></div></div>
        <div class="relationship-list">
          <article class="panel relationship-card"><div class="panel-title"><h3>${escapeHtml(model.residentId)} → 断路小镇</h3>${renderEvidenceBadge("committed")}</div><p><strong>角色：</strong>登记居民</p><p><strong>依据：</strong>第 0 天的城镇名册包含本原型中的每位居民。</p><p><strong>影响：</strong>聚焦只能展开这个既有身份，不能生成替代人物。</p></article>
          <article class="panel relationship-card"><div class="panel-title"><h3>${escapeHtml(model.residentId)} → ${escapeHtml(groupId)}</h3>${renderEvidenceBadge("committed")}</div><p><strong>方向：</strong>人物 → 人口分组</p><p><strong>角色：</strong>区域人口成员</p><p><strong>依据：</strong>Individual Continuity Record 中的 populationGroupId。</p><p><strong>影响：</strong>决定 MVP 中实现哪一种粮食关切。</p></article>
          <article class="panel relationship-card"><div class="panel-title"><h3>${escapeHtml(model.residentId)} → 粮食市场</h3>${renderEvidenceBadge(focused ? "derived" : "unresolved")}</div><p><strong>角色：</strong>尚非正式 Relationship Model，仅是当前关切所指向的情境对象。</p><p><strong>依据：</strong>${focused ? escapeHtml(readableConcern(resident?.currentConcern)) : "聚焦前没有人物级字段"}</p><p><strong>限制：</strong>原型不知道他是否有购买权、是否去过市场、是否信任商人。</p></article>
          <article class="panel relationship-card unresolved-card"><div class="panel-title"><h3>${escapeHtml(model.residentId)} ↔ 其他人物</h3>${renderEvidenceBadge("unresolved")}</div><p><strong>角色：</strong>家庭、亲属、邻居、工作与交换关系均未实现。</p><p><strong>下一步需要：</strong>共享互动历史、双方各自的方向性认知，以及信任、依赖、义务或权力的具体领域。</p></article>
        </div>
      </section>

      <section class="document-section anchored-interactions" aria-labelledby="committed-interactions-title">
        <div class="section-heading"><div><p class="eyebrow">PROOF 00 · ANCHORED RUN</p><h2 id="committed-interactions-title">三条已提交的互动</h2></div>${renderRunAuthority(model)}</div>
        <p class="section-intro">它们是信息与组织命令的实际传递，不代表双方互相信任、友好或拥有相同理解。</p>
        <div class="interaction-list">
          ${renderCommittedInteraction({
            from: anchoredActor(model, "actor:clerk-ivo").name ?? "Ivo",
            to: anchoredActor(model, "actor:chair-mara").name ?? "Mara",
            time: worldClock(officialReport.receivedBy?.["actor:chair-mara"]),
            type: "正式道路报告送达",
            proposition: readableClaim(officialReport),
            evidence: officialReport.id ?? "claim:official-road-report",
          })}
          ${renderCommittedInteraction({
            from: anchoredActor(model, "actor:chair-mara").name ?? "Mara",
            to: anchoredActor(model, "actor:clerk-ivo").name ?? "Ivo",
            time: worldClock(reserveOrder.receivedBy?.["actor:clerk-ivo"]),
            type: "议会储备命令",
            proposition: readableClaim(reserveOrder),
            evidence: reserveOrder.id ?? "claim:council-reservation-order",
          })}
          ${renderCommittedInteraction({
            from: anchoredActor(model, "actor:clerk-ivo").name ?? "Ivo",
            to: anchoredActor(model, "actor:keeper-sena").name ?? "Sena",
            time: worldClock(reserveOrder.receivedBy?.["actor:keeper-sena"]),
            type: "携带命令到粮仓",
            proposition: readableClaim(reserveOrder),
            evidence: orderMovement.id ?? "movement:clerk-order",
          })}
        </div>
      </section>
    </article>
  `;
}

function renderEventCard({ index, time, title, fact, cause, result, impact, future, kind = "committed" }) {
  return `
    <li class="event-card ${kind}">
      <span class="timeline-marker">${String(index).padStart(2, "0")}</span>
      <article>
        <div class="event-heading"><div><p class="eyebrow">${escapeHtml(time)}</p><h2>${escapeHtml(title)}</h2></div>${renderEvidenceBadge(kind)}</div>
        <p class="event-fact">${escapeHtml(fact)}</p>
        <dl class="event-causality">
          <div><dt>原因</dt><dd>${escapeHtml(cause)}</dd></div>
          <div><dt>结果</dt><dd>${escapeHtml(result)}</dd></div>
          <div><dt>影响</dt><dd>${escapeHtml(impact)}</dd></div>
          <div><dt>长期影响</dt><dd>${escapeHtml(future)}</dd></div>
        </dl>
      </article>
    </li>
  `;
}

function renderAnchoredRunTimeline(model) {
  const finalState = anchoredFinalState(model);
  const officialReport = anchoredClaim(model, "claim:official-road-report");
  const position = finalState.actorPositions?.["position:chair-reserve-grain"] ?? {};
  const decision = finalState.organizations?.["organization:town-council"]?.decisions?.["decision:council-reserve-grain"] ?? {};
  const order = anchoredClaim(model, "claim:council-reservation-order");
  const movement = finalState.movements?.["movement:clerk-order"] ?? {};
  const reservation = finalState.grainReservations?.["reservation:council-emergency"] ?? {};
  const stock = finalState.grainStocks?.["stock:town-grain"] ?? {};
  if (!officialReport.id) {
    return `<article class="panel unavailable-card"><h3>Proof 00 Anchored Run 尚未载入</h3><p>事件区不会用虚构条目代替缺失的 Run 数据。</p></article>`;
  }
  return `
    <ol class="event-timeline anchored-event-timeline">
      ${renderEventCard({
        index: 1,
        time: `${worldClock(officialReport.receivedBy?.["actor:chair-mara"])} · Proof 00`,
        title: "Mara 收到正式道路报告",
        fact: readableClaim(officialReport),
        cause: `Ivo 携带 ${officialReport.id} 从北门抵达议会。`,
        result: "这条 Claim 进入 Mara 的 accessibleClaimIds。",
        impact: "信息机制据此触发主席的决策点。",
        future: "收到 Claim 不等于自动相信；本 Run 的 beliefSummaries 仍为空。",
      })}
      ${renderEventCard({
        index: 2,
        time: `${worldClock(position.decidedAt)} · Proof 00`,
        title: "Mara 形成粮食储备立场",
        fact: `${anchoredActor(model, "actor:chair-mara").name ?? "Mara"} 选择 ${position.action?.kind ?? "recommend-grain-reserve"}，数量 ${number(position.action?.quantity, 60)} 袋。`,
        cause: `证据引用 ${(position.evidenceRefs ?? []).join(" · ") || officialReport.id}。`,
        result: `${position.id ?? "position:chair-reserve-grain"} 被提交。`,
        impact: "这个人物立场成为议会决策的支持输入，而不是直接改动粮仓。",
        future: "后续仍必须经过组织程序和命令执行链。",
      })}
      ${renderEventCard({
        index: 3,
        time: `${worldClock(decision.decidedAt)} · Proof 00`,
        title: "镇议会采纳储备决定",
        fact: decision.id
          ? "北方补给路关闭后，为全镇保留一批应急粮食。"
          : "议会决定正文尚未提供。",
        cause: `主席立场 ${decision.supportingPositionId ?? position.id ?? "position:chair-reserve-grain"} 进入议会程序。`,
        result: `决定状态为 ${decision.status ?? "adopted"}，目标储备 ${number(decision.quantity, 60)} 袋。`,
        impact: "组织决定产生正式命令，但物资还未变化。",
        future: "命令需要由 Ivo 送往粮仓并由 Sena 接收。",
      })}
      ${renderEventCard({
        index: 4,
        time: `${worldClock(order.formedAt)} · Proof 00`,
        title: "Mara 的命令交给 Ivo",
        fact: readableClaim(order),
        cause: order.transformation
          ? `由 ${decision.id ?? "decision:council-reserve-grain"} 授权形成。`
          : "储备决定形成正式命令。",
        result: `${order.id ?? "claim:council-reservation-order"} 进入 Ivo 的可访问信息，并随其开始前往粮仓。`,
        impact: "信息已被授权并进入执行链，粮食仍未自动储备。",
        future: `移动 ${movement.id ?? "movement:clerk-order"} 预计在 ${worldClock(movement.earliestArrival)} 抵达。`,
      })}
      ${renderEventCard({
        index: 5,
        time: `${worldClock(reservation.revision === 0 ? movement.arrivedAt : order.receivedBy?.["actor:keeper-sena"])} · Proof 00`,
        title: "命令抵达，60 袋应急粮正式保留",
        fact: `${anchoredActor(model, "actor:keeper-sena").name ?? "Sena"} 收到命令；${reservation.id ?? "reservation:council-emergency"} 状态为 ${reservation.status ?? "active"}。`,
        cause: `Ivo 完成 ${movement.id ?? "movement:clerk-order"}，命令送达粮仓保管人。`,
        result: `${number(stock.physicalQuantity, 100)} 袋实物粮中，${number(stock.reservedQuantity, 60)} 袋进入议会应急储备。`,
        impact: "组织决定终于通过信息传递、移动和粮仓执行成为物质约束。",
        future: "该 Run 在此保留可追溯状态；之后世界如何演化不由这个页面补写。",
      })}
    </ol>
  `;
}

function renderAEvents(model) {
  const summary = currentSummary(model);
  const focused = model.phase === "after";
  const events = worldHistory(model);
  const registerEvent = events.find((event) => event.id === "history-town-register") ?? events[0];
  const roadEvent = events.find((event) => event.id === "history-road-closed") ?? events[1] ?? events[0];
  return `
    <article class="workspace-view events-view" data-workspace-view="events">
      <header class="document-header view-header">
        <p class="eyebrow">${A_VIEW_META.events.eyebrow}</p>
        <h1 id="variant-a-title">世界历史与一次外部聚焦</h1>
        <p class="lede">前两项是已经发生的世界事件；第三项只是作者改变观察分辨率的操作，绝不能被角色当作自己经历过的事件。</p>
        ${renderActionBar(model, "执行外部聚焦")}
      </header>

      <section class="document-section readable-timeline" aria-labelledby="timeline-title">
        <div class="section-heading"><div><p class="eyebrow">CAUSAL TIMELINE</p><h2 id="timeline-title">事件、原因与影响</h2></div><span>${number(summary.historyEventCount)} 个世界事件</span></div>
        <ol class="event-timeline">
          ${renderEventCard({
            index: 1,
            time: `第 ${number(registerEvent?.day)} 天 · 世界事件`,
            title: "建立城镇居民名册",
            fact: readableWorldFact(registerEvent),
            cause: "Proof 01A 只把它作为初始条件；具体登记机构与过程尚未建模。",
            result: `${number(summary.residentCount)} 个居民拥有稳定身份，${model.residentId} 已经存在。`,
            impact: "后续聚焦必须指向同一身份，不能为了需要一个主角而临时造人。",
            future: "名册制度、遗漏、迁入迁出等尚未模拟。",
          })}
          ${renderEventCard({
            index: 2,
            time: `第 ${number(roadEvent?.day, 1)} 天 · 世界事件`,
            title: "洪水切断唯一运粮道路",
            fact: readableWorldFact(roadEvent),
            cause: "洪水；天气形成、道路损坏程度与恢复工期未在本切片展开。",
            result: "通往镇外的唯一粮食路线关闭。",
            impact: focused ? `与 ${model.residentId} 有关的“市场粮食准入”关切被实现。` : "人物级影响要等聚焦后才能读取。",
            future: "市场价格、配给、囤积、冲突或恢复都没有被本 MVP 预先写死。",
          })}
          ${renderEventCard({
            index: 3,
            time: "作者操作 · 不属于世界时间",
            title: focused ? `聚焦 ${model.residentId}` : `等待聚焦 ${model.residentId}`,
            fact: focused ? "作者请求提高同一位居民的观察分辨率。" : "当前仍保持低分辨率人口状态。",
            cause: focused ? "外部 Focus Promotion Request。" : "尚未发生外部请求。",
            result: focused ? `人口账本从 200 + 0 变为 ${number(summary.residualCount)} + ${number(summary.detailedCount)}；2 袋粮食转入人物账本。` : "没有状态转移。",
            impact: focused ? "人物获得当前关切，但世界历史哈希不变。" : "无。",
            future: "新增细节只可影响后续推演；当前原型没有继续运行世界时间。",
            kind: "external",
          })}
        </ol>
      </section>

      <section class="document-section anchored-run-events" aria-labelledby="anchored-events-title">
        <div class="section-heading"><div><p class="eyebrow">PROOF 00 · ANCHORED RUN</p><h2 id="anchored-events-title">一条已经跑通的内容链</h2></div>${renderRunAuthority(model)}</div>
        <p class="section-intro">下面读取已保存 Run 的 finalState，与上面的 Proof 01A 聚焦实验分栏展示。它说明人物信息、立场、组织决定和物质结果如何连续发生。</p>
        ${renderAnchoredRunTimeline(model)}
      </section>
    </article>
  `;
}

function renderAProof(model) {
  const before = model.before;
  const summary = currentSummary(model);
  const checks = deriveChecks(model);
  return `
    <article class="workspace-view proof-view" data-workspace-view="proof">
      <header class="document-header view-header">
        <p class="eyebrow">${A_VIEW_META.proof.eyebrow}</p>
        <h1 id="variant-a-title">这次“看清”有没有偷偷改写世界？</h1>
        <p class="lede">这不是完整世界引擎验收，只是 Proof 01A 的五个可见检查，以及聚焦前后的最小状态差异。</p>
        ${renderActionBar(model, "运行聚焦检查")}
      </header>

      <section class="document-section proof-checks" aria-labelledby="checks-title">
        <div class="section-heading"><div><p class="eyebrow">VISIBLE INVARIANTS</p><h2 id="checks-title">5 项推演检查</h2></div><span>${checks.filter((item) => item.status === "passed").length}/5</span></div>
        ${renderChecks(checks)}
      </section>

      <section class="document-section" aria-labelledby="diff-title">
        <div class="section-heading"><div><p class="eyebrow">STATE DIFF</p><h2 id="diff-title">聚焦前 / 当前</h2></div></div>
        <div class="comparison-table-wrap">
          <table class="comparison-table">
            <thead><tr><th>状态</th><th>聚焦前</th><th>当前</th><th>解释</th></tr></thead>
            <tbody>
              ${comparisonRow("登记居民", number(before.residentCount), number(summary.residentCount))}
              ${comparisonRow("低分辨率居民", number(before.residualCount), number(summary.residualCount))}
              ${comparisonRow("详细人物", number(before.detailedCount), number(summary.detailedCount))}
              ${comparisonRow("群体粮食", number(before.residualGrain), number(summary.residualGrain), " 袋")}
              ${comparisonRow("人物账本贡献", number(before.detailedGrain), number(summary.detailedGrain), " 袋")}
              ${comparisonRow("粮食总量", number(before.totalGrain), number(summary.totalGrain), " 袋")}
              ${comparisonRow("历史事件", number(before.historyEventCount), number(summary.historyEventCount))}
            </tbody>
          </table>
        </div>
      </section>

      <section class="document-section proof-ledger-grid">
        <div><div class="section-heading"><div><p class="eyebrow">TRANSITION</p><h2>晋升记录</h2></div></div>${renderPromotion(summary, model.residentId)}</div>
        <div><div class="section-heading"><div><p class="eyebrow">STATE ADDRESS</p><h2>完整状态指纹</h2></div></div>${renderHashes(summary)}</div>
      </section>
    </article>
  `;
}

function renderActiveAView(model) {
  const views = {
    overview: renderAOverview,
    character: renderACharacter,
    relationships: renderARelationships,
    events: renderAEvents,
    proof: renderAProof,
  };
  return (views[model.view] ?? renderAOverview)(model);
}

/** Variant A — a routed, Obsidian-like world workspace with real independent views. */
export function renderVariantA(model) {
  const summary = currentSummary(model);
  const checks = deriveChecks(model);
  const currentMeta = A_VIEW_META[model.view] ?? A_VIEW_META.overview;
  return `
    <section class="view view-a" aria-labelledby="variant-a-title">
      <div class="workspace multi-view-workspace">
        <aside class="sidebar world-sidebar">
          <div class="sidebar-heading">
            <p class="eyebrow">WORLD WORKSPACE</p>
            <strong>断路小镇</strong>
            <small>Proof 01A · 可读视图</small>
          </div>
          <nav class="tree nav-tree workspace-nav" aria-label="工作台视图">
            <details open>
              <summary><span aria-hidden="true">⌄</span> 世界</summary>
              ${renderAViewLink("overview")}
              ${renderAViewLink("events", `<small>${number(summary.historyEventCount)}</small>`)}
            </details>
            <details open>
              <summary><span aria-hidden="true">⌄</span> 焦点对象</summary>
              ${renderAViewLink("character")}
              ${renderAViewLink("relationships")}
            </details>
            <details open>
              <summary><span aria-hidden="true">⌄</span> 引擎</summary>
              ${renderAViewLink("proof", "<small>5</small>")}
            </details>
          </nav>
          <footer class="sidebar-footer">
            <span class="status ${model.phase === "after" ? "passed" : "pending"}">${model.phase === "after" ? "FOCUSED" : "BASELINE"}</span>
            <small>内存状态 · 刷新即重置</small>
          </footer>
        </aside>

        <main class="main-pane document-pane routed-view-pane" data-active-view="${escapeHtml(model.view)}">
          ${renderActiveAView(model)}
        </main>

        <aside class="inspector workspace-inspector">
          <div class="panel object-context-card">
            <p class="eyebrow">CURRENT VIEW</p>
            <h2>${currentMeta.icon} ${currentMeta.label}</h2>
            <dl class="state-ledger">
              <div><dt>焦点对象</dt><dd class="mono">${escapeHtml(model.residentId)}</dd></div>
              <div><dt>分辨率</dt><dd>${model.phase === "after" ? "详细" : "群体"}</dd></div>
              <div><dt>世界事件</dt><dd>${number(summary.historyEventCount)}</dd></div>
              <div><dt>投影</dt><dd class="mono" title="${escapeHtml(summary.projectionHash)}">${shortHash(summary.projectionHash)}</dd></div>
            </dl>
          </div>
          <div class="panel sticky-panel invariant-summary">
            <div class="panel-title"><div><p class="eyebrow">ALWAYS VISIBLE</p><h2>5 项检查</h2></div><span>${checks.filter((item) => item.status === "passed").length}/5</span></div>
            ${renderChecks(checks, { compact: true })}
          </div>
          <div class="panel note-panel prototype-boundary">
            <p class="eyebrow">PROTOTYPE BOUNDARY</p>
            <p>人物解释性文案分为“引擎已提交”“读取层转译”和“尚未建模”。它们不会因为出现在页面上就获得世界事实权威。</p>
          </div>
          <div class="panel note-panel">
            <p class="eyebrow">LAST ACTION</p>
            <p>${escapeHtml(model.note)}</p>
          </div>
        </aside>
      </div>
    </section>
    ${renderVariantSwitcher(model.variant)}
  `;
}

function renderGraphNode(id, title, value, meta, className = "") {
  return `
    <article id="${id}" class="graph-node ${className}">
      <p class="eyebrow">${escapeHtml(title)}</p>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(meta)}</small>
    </article>
  `;
}

/** Variant B — a causal/spatial canvas centered on conservation edges. */
export function renderVariantB(model) {
  const summary = currentSummary(model);
  const checks = deriveChecks(model);
  const focused = model.phase === "after";
  const resident = focusedResident(summary);
  return `
    <section class="view view-b" aria-labelledby="variant-b-title">
      <header class="canvas-header">
        <div>
          <p class="eyebrow">CAUSAL RESOLUTION MAP</p>
          <h1 id="variant-b-title">一张不允许偷改账本的世界图</h1>
        </div>
        ${renderActionBar(model, "展开节点")}
      </header>

      <main class="causal-layout">
        <section class="graph-canvas" aria-label="人口聚焦因果图">
          <div class="canvas-grid" aria-hidden="true"></div>
          <svg class="graph-edges" viewBox="0 0 1000 620" preserveAspectRatio="none" aria-hidden="true">
            <path d="M 160 125 C 310 125, 300 255, 440 255"></path>
            <path d="M 160 490 C 300 490, 310 355, 440 355"></path>
            <path d="M 560 285 C 700 285, 700 150, 840 150"></path>
            <path d="M 560 335 C 700 335, 700 485, 840 485"></path>
          </svg>
          <span class="edge-label edge-one">承诺 ${number(summary.historyEventCount)} 个事件</span>
          <span class="edge-label edge-two">包含 ${focused ? 199 : 200} 个低分辨率身份</span>
          <span class="edge-label edge-three">转移 ${focused ? 2 : 0} 袋</span>
          <span class="edge-label edge-four">保留历史指纹</span>

          ${renderGraphNode("node-history", "COMMITTED HISTORY", `${number(summary.historyEventCount)} events`, shortHash(summary.historyHash), "node-history")}
          ${renderGraphNode("node-population", "POPULATION RESIDUAL", `${number(summary.residualCount)} residents`, `${number(summary.residualGrain)} grain`, "node-population")}
          ${renderGraphNode("node-target", focused ? "RESOLUTION PROMOTED" : "STABLE IDENTITY", model.residentId, focused ? readableConcern(resident?.currentConcern) : "detail unresolved", `node-target ${focused ? "focused" : "dormant"}`)}
          ${renderGraphNode("node-ledger", "MATERIAL LEDGER", `${number(summary.totalGrain)} grain`, `${number(summary.residualGrain)} + ${number(summary.detailedGrain)}`, "node-ledger")}
          ${renderGraphNode("node-proof", "PROJECTION", shortHash(summary.projectionHash), `${checks.filter((item) => item.status === "passed").length}/5 checks passing`, "node-proof")}

          <div class="canvas-legend">
            <span><i class="legend-dot committed"></i>已承诺</span>
            <span><i class="legend-dot aggregate"></i>群体状态</span>
            <span><i class="legend-dot focused"></i>焦点对象</span>
          </div>
        </section>

        <aside class="causal-inspector">
          <section class="panel">
            <div class="panel-title"><div><p class="eyebrow">SELECTED NODE</p><h2>${escapeHtml(model.residentId)}</h2></div><span class="status ${focused ? "passed" : "pending"}">${focused ? "详细" : "低分辨率"}</span></div>
            ${renderResidentDetail(model)}
          </section>
          <section class="panel checks-panel">
            <div class="panel-title"><div><p class="eyebrow">LIVE PROOF</p><h2>5 项检查</h2></div></div>
            ${renderChecks(checks, { compact: true })}
          </section>
        </aside>
      </main>

      <section class="causal-footer-grid">
        <article class="panel state-panel">
          <div class="panel-title"><div><p class="eyebrow">COMPLETE STATE</p><h2>当前世界账本</h2></div><span class="status ${focused ? "passed" : "pending"}">${focused ? "AFTER" : "BEFORE"}</span></div>
          ${renderWorldState(summary)}
        </article>
        <article class="panel trace-panel">
          <div class="panel-title"><div><p class="eyebrow">TRANSITION TRACE</p><h2>唯一状态变化</h2></div></div>
          ${renderPromotion(summary, model.residentId)}
          ${renderHashes(summary)}
        </article>
      </section>

      <p class="canvas-note"><span class="mono">NOTE</span> ${escapeHtml(model.note)}</p>
    </section>
    ${renderVariantSwitcher(model.variant)}
  `;
}

function comparisonRow(label, beforeValue, currentValue, unit = "") {
  const changed = beforeValue !== currentValue;
  return `
    <tr class="${changed ? "changed" : "unchanged"}">
      <th scope="row">${escapeHtml(label)}</th>
      <td>${escapeHtml(beforeValue)}${unit}</td>
      <td>${escapeHtml(currentValue)}${unit}</td>
      <td><span class="status ${changed ? "pending" : "passed"}">${changed ? "有意变化" : "保持"}</span></td>
    </tr>
  `;
}

/** Variant C — a chronological before/action/after account with direct comparison. */
export function renderVariantC(model) {
  const before = model.before;
  const summary = currentSummary(model);
  const checks = deriveChecks(model);
  const focused = model.phase === "after";
  return `
    <section class="view view-c" aria-labelledby="variant-c-title">
      <header class="timeline-header">
        <div>
          <p class="eyebrow">BEFORE / ACTION / AFTER</p>
          <h1 id="variant-c-title">一次聚焦，<br>世界究竟改变了什么？</h1>
          <p class="lede">把状态转移摊开来看：身份与总量保持，只有观察分辨率和账本归属发生变化。</p>
        </div>
        ${renderActionBar(model, "执行聚焦")}
      </header>

      <main class="timeline-layout">
        <ol class="timeline">
          <li class="timeline-item completed">
            <span class="timeline-marker">01</span>
            <article>
              <p class="eyebrow">DAY 0–1 · COMMITTED</p>
              <h2>世界已经发生</h2>
              <p>城镇名册与道路中断是聚焦前已经提交的历史，之后不能为了人物方便而改写。</p>
              <div class="timeline-facts">
                <span><b>${number(before.historyEventCount)}</b> 个历史事件</span>
                <span class="mono" title="${escapeHtml(before.historyHash)}">${shortHash(before.historyHash)}</span>
              </div>
            </article>
          </li>
          <li class="timeline-item completed">
            <span class="timeline-marker">02</span>
            <article>
              <p class="eyebrow">BASELINE · LOW RESOLUTION</p>
              <h2>${number(before.residentCount)} 个稳定身份，共用群体账本</h2>
              <p>${escapeHtml(model.residentId)} 已在其中，但还没有独立人物细节。</p>
              <div class="timeline-facts"><span><b>${number(before.residualGrain)}</b> 袋群体粮食</span><span><b>${number(before.detailedCount)}</b> 名详细人物</span></div>
            </article>
          </li>
          <li class="timeline-item ${focused ? "completed active" : "pending active"}">
            <span class="timeline-marker">03</span>
            <article>
              <p class="eyebrow">AUTHOR ACTION · FOCUS REQUEST</p>
              <h2>${focused ? "同一位居民被展开" : "等待作者聚焦"}</h2>
              ${focused ? renderPromotion(summary, model.residentId) : `<p>点击“执行聚焦”，从预计算的确定性结果切换到详细视图。</p>`}
            </article>
          </li>
          <li class="timeline-item ${focused ? "completed" : "pending"}">
            <span class="timeline-marker">04</span>
            <article>
              <p class="eyebrow">RECONCILIATION · PROOF</p>
              <h2>${focused ? "变化已经守恒" : "检查已准备"}</h2>
              ${renderChecks(checks)}
            </article>
          </li>
        </ol>

        <aside class="comparison-pane">
          <section class="panel comparison-panel">
            <div class="panel-title"><div><p class="eyebrow">STATE DIFF</p><h2>基线 / 当前</h2></div><span class="status ${focused ? "passed" : "pending"}">${focused ? "AFTER" : "BEFORE"}</span></div>
            <div class="comparison-table-wrap">
              <table class="comparison-table">
                <thead><tr><th>状态</th><th>基线</th><th>当前</th><th>解释</th></tr></thead>
                <tbody>
                  ${comparisonRow("登记居民", number(before.residentCount), number(summary.residentCount), "")}
                  ${comparisonRow("低分辨率居民", number(before.residualCount), number(summary.residualCount), "")}
                  ${comparisonRow("详细人物", number(before.detailedCount), number(summary.detailedCount), "")}
                  ${comparisonRow("群体粮食", number(before.residualGrain), number(summary.residualGrain), " 袋")}
                  ${comparisonRow("独立账本贡献", number(before.detailedGrain), number(summary.detailedGrain), " 袋")}
                  ${comparisonRow("粮食总量", number(before.totalGrain), number(summary.totalGrain), " 袋")}
                  ${comparisonRow("历史事件", number(before.historyEventCount), number(summary.historyEventCount), "")}
                  ${comparisonRow("晋升记录", number(before.promotionCount), number(summary.promotionCount), "")}
                </tbody>
              </table>
            </div>
          </section>
          <section class="panel resident-panel">
            ${renderResidentDetail(model)}
          </section>
          <section class="panel hash-panel">
            <div class="panel-title"><div><p class="eyebrow">CONTENT ADDRESSES</p><h2>完整状态指纹</h2></div></div>
            ${renderHashes(summary)}
          </section>
          <p class="comparison-note"><span class="mono">LAST ACTION</span> ${escapeHtml(model.note)}</p>
        </aside>
      </main>
    </section>
    ${renderVariantSwitcher(model.variant)}
  `;
}

function viewModel() {
  return {
    ...state.payload,
    phase: state.phase,
    variant: state.variant,
    view: state.view,
    note: state.note,
  };
}

function render() {
  if (!root) return;
  if (state.loading) {
    root.setAttribute("aria-busy", "true");
    root.innerHTML = `
      <section class="loading" aria-label="正在载入">
        <p class="eyebrow">正在连接世界状态</p>
        <h1>载入 Proof 01A…</h1>
        <p class="muted">读取基线与聚焦后的确定性投影。</p>
      </section>
    `;
    return;
  }
  if (state.error) {
    root.setAttribute("aria-busy", "false");
    root.innerHTML = `
      <section class="error" role="alert">
        <p class="eyebrow">WORLD STATE UNAVAILABLE</p>
        <h1>没有读到 Proof 01A</h1>
        <p>${escapeHtml(state.error)}</p>
        <button class="action-button primary" type="button" data-action="retry">重新连接</button>
      </section>
    `;
    return;
  }

  root.setAttribute("aria-busy", "false");
  const model = viewModel();
  const renderer = {
    A: renderVariantA,
    B: renderVariantB,
    C: renderVariantC,
  }[state.variant];
  root.innerHTML = renderer(model);
}

function writeRoute(mode = "replace") {
  const url = new URL(window.location.href);
  url.searchParams.set("variant", state.variant);
  url.searchParams.set("view", state.view);
  url.searchParams.set("phase", state.phase);
  const method = mode === "push" ? "pushState" : "replaceState";
  window.history[method](
    { variant: state.variant, view: state.view, phase: state.phase },
    "",
    url,
  );
}

function setVariant(variant) {
  if (!VARIANTS.includes(variant) || variant === state.variant) return;
  state.variant = variant;
  writeRoute();
  render();
}

function setView(view) {
  if (!A_VIEWS.includes(view)) return;
  const changed = state.view !== view || state.variant !== "A";
  if (!changed) return;
  state.view = view;
  state.variant = "A";
  writeRoute("push");
  render();
}

function focus() {
  if (!state.payload) return;
  if (state.phase === "after") {
    state.note = `${state.payload.residentId} 已经处于详细分辨率；重复聚焦不会继续改变状态。`;
  } else {
    state.phase = "after";
    state.note = `${state.payload.residentId} 已从群体账本转为详细视图；身份、总人口、总粮食与既有历史保持不变。`;
  }
  writeRoute();
  render();
}

function reset() {
  if (!state.payload) return;
  state.phase = "before";
  state.note = "已重置到确定性的内存基线；没有写入任何持久化状态。";
  writeRoute();
  render();
}

async function load() {
  state.loading = true;
  state.error = null;
  render();
  try {
    const response = await fetch(API_URL, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`接口返回 HTTP ${response.status}`);
    const payload = await response.json();
    if (!payload || typeof payload !== "object" || !payload.before || !payload.after) {
      throw new Error("接口没有返回 before / after 状态。");
    }
    const residentId = payload.targetResidentId;
    if (typeof residentId !== "string" || !residentId) {
      throw new Error("接口没有返回 targetResidentId。");
    }
    state.payload = {
      residentId,
      before: payload.before,
      after: payload.after,
      worldHistory: Array.isArray(payload.worldHistory) ? payload.worldHistory : FALLBACK_WORLD_HISTORY,
      targetResidentRecord: payload.targetResidentRecord ?? null,
      anchoredRun: payload.anchoredRun ?? null,
    };
    state.phase = readPhase();
    state.note = state.phase === "after"
      ? `${residentId} 已按分享链接显示为聚焦后的详细状态。`
      : "世界仍处于低分辨率。聚焦不会创造替代身份，也不会重写历史。";
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.loading = false;
    render();
  }
}

root?.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const actionButton = target?.closest("[data-action]");
  if (actionButton) {
    const action = actionButton.getAttribute("data-action");
    if (action === "focus") focus();
    if (action === "reset") reset();
    if (action === "retry") load();
    return;
  }
  const variantButton = target?.closest("[data-variant]");
  if (variantButton) {
    setVariant(variantButton.getAttribute("data-variant"));
    return;
  }
  const viewLink = target?.closest("[data-view]");
  if (viewLink) {
    event.preventDefault();
    setView(viewLink.getAttribute("data-view"));
  }
});

window.addEventListener("keydown", (event) => {
  const target = event.target;
  const isTextInput = target instanceof HTMLElement &&
    (target.matches("input, textarea, select") || target.isContentEditable);
  if (isTextInput || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
  event.preventDefault();
  const index = VARIANTS.indexOf(state.variant);
  const offset = event.key === "ArrowRight" ? 1 : -1;
  const next = (index + offset + VARIANTS.length) % VARIANTS.length;
  setVariant(VARIANTS[next]);
});

window.addEventListener("popstate", () => {
  const variant = readVariant();
  const view = readView();
  const phase = readPhase();
  if (variant !== state.variant || view !== state.view || phase !== state.phase) {
    state.variant = variant;
    state.view = view;
    state.phase = phase;
    render();
  }
});

load();
