const API = {
  create: "/api/proof01b/session",
  snapshot: "/api/proof01b/snapshot",
  action: "/api/proof01b/action",
  reset: "/api/proof01b/reset",
};

const SESSION_KEY = "world-studio-proof01b-session";
const PRESET_KEY = "world-studio-proof01b-preset";
const VARIANTS = ["A", "B", "C"];
const VARIANT_NAMES = {
  A: "世界现场",
  B: "因果脉络",
  C: "活的编年史",
};

const root = document.querySelector("#app-root");

const ui = {
  snapshot: null,
  loading: true,
  pending: false,
  error: null,
  auditOpen: false,
  variant: readVariant(),
};

function readVariant() {
  const requested = new URL(window.location.href).searchParams.get("variant")?.toUpperCase();
  return VARIANTS.includes(requested) ? requested : "A";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function short(value, length = 12) {
  const text = String(value ?? "—");
  const separator = text.indexOf(":");
  if (separator > 0 && text.length > separator + length) {
    return `${text.slice(0, separator + 1)}${text.slice(separator + 1, separator + 7)}…`;
  }
  return text.length > length + 8 ? `${text.slice(0, length)}…${text.slice(-5)}` : text;
}

function value(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function world(snapshot = ui.snapshot) {
  return snapshot?.base?.world ?? { roadOpen: true, councilAlerted: false, watchLevel: 0 };
}

function worldSituation(snapshot = ui.snapshot) {
  const current = world(snapshot);
  if (current.watchLevel > 0) {
    return {
      eyebrow: "T1 · 秩序响应已经形成",
      title: "议会已调动守望队，市场入口开始设防。",
      detail: "这不是预写剧情：它来自暴雨、道路中断、守望队报告与议会反应连续发布后的世界状态。",
      tone: "violet",
    };
  }
  if (current.councilAlerted) {
    return {
      eyebrow: "T1 · 警报抵达议会",
      title: "议会已经知道补给路中断，但尚未形成新的公共秩序行动。",
      detail: "下一阶段可能由议会警报触发；在 Receipt 出现以前，它仍只是候选后果。",
      tone: "amber",
    };
  }
  if (!current.roadOpen) {
    return {
      eyebrow: "T1 · 补给被切断",
      title: "洪水封住了唯一补给路，议会还没有收到可靠警报。",
      detail: "道路关闭已经写入历史；守望队是否把消息带给议会，要经过下一条因果链。",
      tone: "rose",
    };
  }
  return {
    eyebrow: "T0 · 暴雨正在逼近",
    title: "小镇仍然平静，唯一补给路保持畅通。",
    detail: "世界已有一个激活输入：暴雨前锋将在 T1 抵达山口。接下来先核对当前所有因果边界。",
    tone: "cyan",
  };
}

function phaseMeaning(mode) {
  return ({
    "boundary-open": ["等待核对", "先找齐当前时刻所有可能发生的边界。"],
    "source-collection": ["等待世界响应", "边界已经选定，正在向相关机制收集候选变化。"],
    "frontier-frozen": ["候选已冻结", "所有来源都已回答；现在才能判断是否允许继续。"],
    admitted: ["允许推进", "这条同时间因果仍在预算内，可以在私有区准备结果。"],
    ready: ["等待写入", "候选世界已经准备好，但还没有成为事实。"],
    incomplete: ["推进已停止", "存在真实的下一条因果，但它超过本 Run 的预算。"],
    "empty-closed": ["当前分支收束", "所有来源明确没有新提案，因此没有创建空历史。"],
    "later-boundary-unmodeled": ["等待未来时刻", "同时间因果已经结束；T2 的过程边界不在本原型范围内。"],
  })[mode] ?? [mode ?? "未知阶段", "等待状态机给出进一步信息。"];
}

function proposalCopy(proposal) {
  const kind = proposal?.payload?.proposalKind;
  return ({
    "close-road": {
      title: "洪水关闭唯一补给路",
      reason: "暴雨前锋抵达暴露的山口，水位使道路无法通行。",
      output: "道路中断成为新的世界因果输入。",
    },
    "alert-council": {
      title: "守望队把道路警报送往议会",
      reason: "道路关闭触发了守望队的报告职责。",
      output: "议会收到经过确认的补给中断警报。",
    },
    "mobilize-watch": {
      title: "议会要求加强市场入口守卫",
      reason: "补给中断可能引发抢购与公共秩序压力。",
      output: "一支加强后的守望队被部署到市场周边。",
    },
    "hold-watch": {
      title: "加强后的守望队维持岗位",
      reason: "没有新的骚乱改变既有命令。",
      output: "没有产生新的同时间因果输入。",
    },
  })[kind] ?? {
    title: proposal?.payload?.summary ?? "尚未生成候选变化",
    reason: proposal?.payload?.rationale ?? "等待世界机制响应。",
    output: proposal?.payload?.worldCausalOutput?.summary ?? "暂无新输出。",
  };
}

function historyCopy(entry) {
  if (entry.includes("begins with an open supply road")) {
    return "小镇开始时补给路畅通，议会没有收到任何警报。";
  }
  if (entry.includes("Floodwater closes")) return "洪水关闭了唯一补给路。";
  if (entry.includes("watch carries")) return "守望队把道路警报送到了议会。";
  if (entry.includes("council asks")) return "议会要求守望队加强市场入口防卫。";
  if (entry.includes("reinforced watch holds")) return "加强后的守望队继续维持岗位。";
  return entry.replace(/^T\d+:\s*/, "");
}

function lastActionCopy(action) {
  const key = `${action?.status}:${action?.action}`;
  const known = {
    "accepted:reset": "新的临时 Run 已建立，T0 世界成为当前权威 Base。",
    "accepted:complete-boundary": "当前所有边界都已回答，并选出了最早的世界时间。",
    "accepted:collect-non-empty": "世界机制返回了一个候选变化；Frontier 已冻结。",
    "accepted:collect-zero": "所有来源都明确没有新变化；当前分支正常收束。",
    "accepted:admit": "候选因果仍在预算内，获得了推进许可。",
    "accepted:prepare": "候选世界已在私有区准备完成，尚未写入历史。",
    "accepted:publish": "Publication Barrier 已通过，新 Base 与历史 Receipt 同时生效。",
    "accepted:arm-barrier-failure": "下一次写入会在权威变化前失败，用于观察原子边界。",
    "barrier-failed:publish": "写入失败；Base、历史与因果深度都没有变化，可以重试同一候选。",
    "rejected:publish": "当前工件链不完整或已过期，因此没有写入任何世界事实。",
  };
  if (known[key]) return known[key];
  if (action?.status === "rejected") return `动作被拒绝：${action.message ?? "当前阶段不允许这样做。"}`;
  return action?.message ?? "等待第一个动作。";
}

function statusClass(status) {
  if (status === "PASS" || status === "accepted") return "passed";
  if (status === "FAIL" || status === "rejected") return "failed";
  if (status === "barrier-failed") return "warning";
  return "pending";
}

function renderTopline() {
  const snapshot = ui.snapshot;
  const run = snapshot.run;
  const base = snapshot.base;
  const depth = value(run.completedDepth);
  const budget = value(run.budget);
  const canAdvance = Boolean(snapshot.recommendedAction);
  const runLabel = snapshot.phase.mode === "empty-closed"
    ? "当前因果分支已收束"
    : snapshot.phase.mode === "incomplete"
      ? "本 Run 已到预算边界"
      : snapshot.phase.mode === "later-boundary-unmodeled"
        ? "等待未来时间边界"
        : canAdvance
          ? "世界正在等待下一步"
          : "当前没有可继续动作";
  return `
    <section class="topline" aria-label="当前世界摘要">
      <div class="topline-identity">
        <span class="world-pulse ${canAdvance ? "live" : "stopped"}" aria-hidden="true"></span>
        <div>
          <span class="eyebrow">CUT-OFF TOWN · ${escapeHtml(snapshot.session.preset)}</span>
          <strong>${escapeHtml(runLabel)}</strong>
        </div>
      </div>
      <dl class="topline-facts">
        <div><dt>世界时间</dt><dd>${escapeHtml(base.worldTime)}</dd></div>
        <div><dt>权威 Base</dt><dd>v${value(base.version)}</dd></div>
        <div><dt>同时间深度</dt><dd>${depth}<span> / ${budget}</span></dd></div>
        <div><dt>当前阶段</dt><dd>${escapeHtml(phaseMeaning(snapshot.phase.mode)[0])}</dd></div>
      </dl>
      <button class="quiet-button" type="button" data-audit-toggle aria-expanded="${ui.auditOpen}">
        ${ui.auditOpen ? "收起引擎审计" : "查看引擎审计"}
      </button>
    </section>
  `;
}

function objectCard(kind, title, stateText, detail, active, glyph) {
  return `
    <article class="world-object ${active ? "active" : "quiet"}">
      <span class="object-glyph" aria-hidden="true">${glyph}</span>
      <div class="object-copy">
        <span class="object-kind">${escapeHtml(kind)}</span>
        <h3>${escapeHtml(title)}</h3>
        <strong>${escapeHtml(stateText)}</strong>
        <p>${escapeHtml(detail)}</p>
      </div>
      <span class="object-state ${active ? "active" : "quiet"}">${active ? "已进入因果链" : "当前稳定"}</span>
    </article>
  `;
}

function renderWorldObjects() {
  const current = world();
  return `
    <div class="world-object-grid">
      ${objectCard(
        "PLACE · 山口",
        "北方补给路",
        current.roadOpen ? "仍可通行" : "已被洪水封闭",
        current.roadOpen ? "商旅与粮车仍能进入小镇。" : "粮车无法穿过山口，市场补给被切断。",
        !current.roadOpen,
        "路",
      )}
      ${objectCard(
        "ORGANIZATION · 治理",
        "镇议会",
        current.councilAlerted ? "已收到警报" : "尚不知情",
        current.councilAlerted ? "道路中断已进入议会的共同认知。" : "没有可靠报告抵达，议会不会凭空行动。",
        current.councilAlerted,
        "议",
      )}
      ${objectCard(
        "ORGANIZATION · 执行",
        "城镇守望队",
        current.watchLevel > 0 ? `戒备等级 ${current.watchLevel}` : "常态巡逻",
        current.watchLevel > 0 ? "守望队已经在市场入口增派人手。" : "守望队尚未收到需要升级戒备的正式命令。",
        current.watchLevel > 0,
        "卫",
      )}
    </div>
  `;
}

function renderCandidate() {
  const candidate = ui.snapshot.phase.candidate;
  const proposal = ui.snapshot.phase.proposals?.[0];
  if (!candidate && !proposal) {
    return `
      <article class="candidate-card dormant">
        <span class="candidate-marker" aria-hidden="true"></span>
        <div>
          <span class="eyebrow">尚未形成候选后果</span>
          <h3>世界不会因为按钮被点击就直接改变。</h3>
          <p>边界、来源和许可都齐全以后，才会出现一个仍未提交的候选世界。</p>
        </div>
      </article>
    `;
  }
  const copy = proposalCopy(proposal);
  const changed = candidate?.world ?? null;
  return `
    <article class="candidate-card ${candidate ? "ready" : "forming"}">
      <span class="candidate-marker" aria-hidden="true"></span>
      <div>
        <span class="eyebrow">${candidate ? "UNCOMMITTED CANDIDATE · 尚未成为事实" : "MODEL CONTRIBUTION · 受约束提案"}</span>
        <h3>${escapeHtml(copy.title)}</h3>
        <p>${escapeHtml(copy.reason)}</p>
        <div class="candidate-delta">
          <span>道路 ${changed ? (changed.roadOpen ? "开放" : "封闭") : "待计算"}</span>
          <span>议会 ${changed ? (changed.councilAlerted ? "已警觉" : "未警觉") : "待计算"}</span>
          <span>守望 ${changed ? changed.watchLevel : "—"}</span>
        </div>
      </div>
      <span class="candidate-badge">${candidate ? "等待写入" : "等待许可"}</span>
    </article>
  `;
}

function renderWhyPanel() {
  const snapshot = ui.snapshot;
  const [phaseTitle, phaseDetail] = phaseMeaning(snapshot.phase.mode);
  const input = snapshot.base.activeInputs?.[0];
  const proposal = snapshot.phase.proposals?.[0];
  const copy = proposalCopy(proposal);
  return `
    <aside class="why-panel panel">
      <header class="panel-heading">
        <div><span class="eyebrow">WHY NOW?</span><h2>为什么停在这里</h2></div>
        <span class="phase-number mono">P${value(snapshot.phase.generation)}</span>
      </header>
      <div class="why-current">
        <span class="status-dot ${statusClass(snapshot.lastAction.status)}"></span>
        <div><strong>${escapeHtml(phaseTitle)}</strong><p>${escapeHtml(phaseDetail)}</p></div>
      </div>
      <dl class="why-ledger">
        <div><dt>当前激活输入</dt><dd>${escapeHtml(input?.kind ?? "无")}</dd></div>
        <div><dt>边界核对</dt><dd>${escapeHtml(snapshot.phase.boundaryAccounting)}</dd></div>
        <div><dt>来源响应</dt><dd>${escapeHtml(snapshot.phase.sourceAccounting)}</dd></div>
        <div><dt>Frontier</dt><dd>${escapeHtml(snapshot.phase.frontier?.kind ?? "尚未冻结")}</dd></div>
      </dl>
      <div class="why-proposal">
        <span>当前解释</span>
        <strong>${escapeHtml(proposal ? copy.title : "等待世界机制给出可审计的变化")}</strong>
        <p>${escapeHtml(proposal ? copy.output : "没有 Proposal 时，模型不能凭空向历史写入内容。")}</p>
      </div>
    </aside>
  `;
}

function renderHistoryList({ compact = false } = {}) {
  const history = ui.snapshot.base.history ?? [];
  return `
    <ol class="history-list ${compact ? "compact" : ""}">
      ${history.map((entry, index) => {
        const [time] = String(entry).split(":");
        return `
          <li>
            <span class="history-time mono">${escapeHtml(time)}</span>
            <span class="history-line" aria-hidden="true"></span>
            <div><small>COMMITTED · Base v${index}</small><strong>${escapeHtml(historyCopy(entry))}</strong></div>
          </li>
        `;
      }).join("")}
    </ol>
  `;
}

function renderVariantA() {
  const situation = worldSituation();
  return `
    <section class="variant variant-a">
      <div class="scene-hero ${situation.tone}">
        <div class="scene-weather" aria-hidden="true"><i></i><i></i><i></i></div>
        <div class="scene-copy">
          <span class="eyebrow">${escapeHtml(situation.eyebrow)}</span>
          <h1>${escapeHtml(situation.title)}</h1>
          <p>${escapeHtml(situation.detail)}</p>
        </div>
        ${renderPrimaryAction("推进世界一步")}
      </div>
      <div class="observatory-layout">
        <main class="observatory-main">
          <section class="section-block">
            <div class="section-heading"><div><span class="eyebrow">WORLD OBJECTS</span><h2>现在真实存在的状态</h2></div><span>只有 Receipt 能改变这里</span></div>
            ${renderWorldObjects()}
          </section>
          <section class="section-block split-section">
            <div>
              <div class="section-heading"><div><span class="eyebrow">POSSIBLE NEXT</span><h2>正在形成的后果</h2></div></div>
              ${renderCandidate()}
            </div>
            <div>
              <div class="section-heading"><div><span class="eyebrow">CHRONICLE</span><h2>已经发生</h2></div></div>
              ${renderHistoryList({ compact: true })}
            </div>
          </section>
        </main>
        ${renderWhyPanel()}
      </div>
      ${renderActionDock()}
    </section>
  `;
}

function causalNode(id, kicker, title, state, detail) {
  return `
    <article class="causal-node ${state}" data-node="${escapeHtml(id)}">
      <span class="node-port input" aria-hidden="true"></span>
      <span class="node-kicker">${escapeHtml(kicker)}</span>
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(detail)}</p>
      <span class="node-state">${state === "committed" ? "已写入" : state === "candidate" ? "候选" : "尚未发生"}</span>
      <span class="node-port output" aria-hidden="true"></span>
    </article>
  `;
}

function renderCausalGraph() {
  const current = world();
  const candidateWorld = ui.snapshot.phase.candidate?.world;
  const candidateProposal = proposalCopy(ui.snapshot.phase.proposals?.[0]);
  const roadState = !current.roadOpen ? "committed" : candidateWorld?.roadOpen === false ? "candidate" : "future";
  const councilState = current.councilAlerted ? "committed" : candidateWorld?.councilAlerted ? "candidate" : "future";
  const watchState = current.watchLevel > 0 ? "committed" : value(candidateWorld?.watchLevel) > 0 ? "candidate" : "future";
  return `
    <div class="causal-graph" aria-label="世界因果脉络">
      ${causalNode("storm", "ACTIVATION · T1", "暴雨抵达山口", "committed", "初始设定已经声明的世界输入")}
      <span class="causal-edge ${roadState}" aria-hidden="true"><i></i></span>
      ${causalNode("road", "PLACE", "补给路中断", roadState, roadState === "candidate" ? candidateProposal.reason : "洪水让粮车无法通行")}
      <span class="causal-edge ${councilState}" aria-hidden="true"><i></i></span>
      ${causalNode("council", "INFORMATION", "警报抵达议会", councilState, "守望队把道路事实变成组织认知")}
      <span class="causal-edge ${watchState}" aria-hidden="true"><i></i></span>
      ${causalNode("watch", "ORGANIZATION", "市场加强守卫", watchState, "议会根据警报形成公共秩序行动")}
    </div>
  `;
}

function renderPhaseRail() {
  const phase = ui.snapshot.phase;
  const terminal = ["empty-closed", "incomplete", "later-boundary-unmodeled"].includes(phase.mode);
  const steps = [
    ["Boundary", Boolean(phase.boundarySelectionId)],
    ["Frontier", Boolean(phase.frontier)],
    ["Admission", Boolean(phase.admission || phase.limitReached)],
    ["Stage", Boolean(phase.stagedResult)],
    ["Publication", Boolean(phase.bundle && ui.snapshot.lastAction.action === "publish" && ui.snapshot.lastAction.status === "accepted")],
  ];
  let firstOpenSeen = false;
  return `
    <ol class="phase-rail">
      ${steps.map(([label, complete], index) => {
        const current = !terminal && !complete && !firstOpenSeen;
        if (current) firstOpenSeen = true;
        return `<li class="${complete ? "complete" : current ? "current" : "waiting"}"><span>${index + 1}</span><strong>${label}</strong></li>`;
      }).join("")}
    </ol>
  `;
}

function renderVariantB() {
  const situation = worldSituation();
  const proposal = proposalCopy(ui.snapshot.phase.proposals?.[0]);
  return `
    <section class="variant variant-b">
      <div class="loom-header">
        <div><span class="eyebrow">CAUSAL LOOM · ${escapeHtml(situation.eyebrow)}</span><h1>一件事怎样成为下一件事的原因</h1><p>${escapeHtml(situation.detail)}</p></div>
        ${renderPrimaryAction("继续形成因果链")}
      </div>
      <section class="loom-canvas panel">
        <div class="canvas-grid" aria-hidden="true"></div>
        <div class="canvas-toolbar"><span>同一世界时间 T1</span><span class="mono">Cascade ${short(ui.snapshot.run.cascadeId)}</span></div>
        ${renderCausalGraph()}
        <div class="limit-gate ${ui.snapshot.phase.limitReached ? "visible" : ""}">
          <span aria-hidden="true">Ⅱ</span><strong>Run Budget Gate</strong><small>${value(ui.snapshot.run.completedDepth)} / ${value(ui.snapshot.run.budget)}</small>
        </div>
      </section>
      <div class="loom-bottom">
        <section class="panel phase-panel"><div class="panel-heading"><div><span class="eyebrow">CONTROL PHASE</span><h2>当前因果如何获得权威</h2></div></div>${renderPhaseRail()}</section>
        <section class="panel node-inspector">
          <div class="panel-heading"><div><span class="eyebrow">CURRENT SIGNAL</span><h2>${escapeHtml(proposal.title)}</h2></div></div>
          <p>${escapeHtml(proposal.reason)}</p><div class="signal-output"><span>若成功发布</span><strong>${escapeHtml(proposal.output)}</strong></div>
        </section>
      </div>
      ${renderActionDock()}
    </section>
  `;
}

function renderChronicleCards() {
  const history = ui.snapshot.base.history ?? [];
  const receipts = ui.snapshot.publication.receipts ?? [];
  return `
    <div class="chronicle-cards">
      ${history.map((entry, index) => {
        const time = String(entry).split(":")[0];
        const receipt = receipts[index - 1];
        return `
          <article class="chronicle-card committed">
            <header><span class="time-seal">${escapeHtml(time)}</span><span>${index === 0 ? "初始世界" : `同时间阶段 ${index}`}</span></header>
            <div class="chronicle-copy"><small>${index === 0 ? "BASE v0" : "SUCCESSFUL PUBLICATION"}</small><h3>${escapeHtml(historyCopy(entry))}</h3></div>
            <footer><span class="mono">${short(receipt?.id ?? ui.snapshot.base.id)}</span><strong>已进入历史</strong></footer>
          </article>
        `;
      }).join("")}
      <article class="chronicle-card current">
        <header><span class="time-seal">${escapeHtml(ui.snapshot.phase.selectedWorldTime ?? ui.snapshot.base.worldTime)}</span><span>当前尝试</span></header>
        <div class="chronicle-copy"><small>NOT COMMITTED</small><h3>${escapeHtml(phaseMeaning(ui.snapshot.phase.mode)[0])}</h3><p>${escapeHtml(phaseMeaning(ui.snapshot.phase.mode)[1])}</p></div>
        <footer><span class="mono">Attempt ${value(ui.snapshot.phase.generation)}</span><strong>不属于历史</strong></footer>
      </article>
      <article class="chronicle-card future">
        <header><span class="time-seal">T2</span><span>未来过程边界</span></header>
        <div class="chronicle-copy"><small>OUTSIDE THIS SLICE</small><h3>暴雨之后，恢复过程仍可能继续。</h3><p>这个原型只验证 T1 的同时间因果级联，不会假装已经推演了 T2。</p></div>
      </article>
    </div>
  `;
}

function renderVariantC() {
  return `
    <section class="variant variant-c">
      <div class="chronicle-header">
        <div><span class="eyebrow">LIVING CHRONICLE</span><h1>历史只在世界真正写入后增长</h1><p>多个因果阶段可以发生在同一个 T1；它们不会伪装成时间已经向前推进。</p></div>
        ${renderPrimaryAction("播放下一个因果阶段")}
      </div>
      <div class="time-ruler" aria-hidden="true"><span class="active">T0</span><i></i><span class="active">T1</span><i></i><span>T2</span></div>
      <div class="chronicle-layout">
        <main>${renderChronicleCards()}</main>
        <aside class="chronicle-aside">
          <section class="panel world-diff">
            <div class="panel-heading"><div><span class="eyebrow">WORLD NOW</span><h2>当前权威世界</h2></div></div>
            ${renderWorldDiff()}
          </section>
          <section class="panel attempt-note">
            <span class="eyebrow">LATEST ATTEMPT</span>
            <strong>${escapeHtml(lastActionCopy(ui.snapshot.lastAction))}</strong>
            <small class="mono">revision ${ui.snapshot.session.revision}</small>
          </section>
        </aside>
      </div>
      ${renderActionDock()}
    </section>
  `;
}

function renderWorldDiff() {
  const current = world();
  return `
    <dl class="world-diff-list">
      <div><dt>补给路</dt><dd class="${current.roadOpen ? "stable" : "changed"}">${current.roadOpen ? "畅通" : "封闭"}</dd></div>
      <div><dt>议会认知</dt><dd class="${current.councilAlerted ? "changed" : "stable"}">${current.councilAlerted ? "已收到警报" : "尚不知情"}</dd></div>
      <div><dt>守望戒备</dt><dd class="${current.watchLevel ? "changed" : "stable"}">等级 ${current.watchLevel}</dd></div>
      <div><dt>历史事件</dt><dd>${ui.snapshot.base.history?.length ?? 0} 条</dd></div>
      <div><dt>成功 Receipt</dt><dd>${ui.snapshot.publication.receipts?.length ?? 0} 条</dd></div>
    </dl>
  `;
}

function renderPrimaryAction(fallbackLabel) {
  const action = ui.snapshot.recommendedAction;
  const control = ui.snapshot.controls.find((item) => item.action === action);
  const terminal = !action;
  return `
    <button class="world-action" type="button" data-action="${escapeHtml(action ?? "")}" ${terminal || ui.pending ? "disabled" : ""}>
      <span class="action-orb" aria-hidden="true">${terminal ? "■" : "→"}</span>
      <span><small>${terminal ? "CURRENT RUN" : "NEXT LEGAL ACTION"}</small><strong>${escapeHtml(control?.label ?? (terminal ? "当前没有可继续动作" : fallbackLabel))}</strong></span>
    </button>
  `;
}

function renderActionDock() {
  const controls = ui.snapshot.controls;
  return `
    <section class="action-dock panel" aria-label="状态机操作">
      <div class="dock-heading">
        <div><span class="eyebrow">SIMULATION CONTROLS</span><h2>逐步观察，不跳过权威边界</h2></div>
        <span class="last-action ${statusClass(ui.snapshot.lastAction.status)}">${escapeHtml(lastActionCopy(ui.snapshot.lastAction))}</span>
      </div>
      <div class="dock-actions">
        ${controls.filter((control) => control.kind !== "test").map((control, index) => `
          <button type="button" data-action="${control.action}" ${!control.enabled || ui.pending ? "disabled" : ""} class="step-button ${control.enabled ? "current" : ""}">
            <span>0${index + 1}</span>${escapeHtml(control.label)}
          </button>
        `).join("")}
      </div>
      <div class="dock-tools">
        <button type="button" data-action="arm-barrier-failure" ${!controls.find((item) => item.action === "arm-barrier-failure")?.enabled || ui.pending ? "disabled" : ""}>模拟写入失败</button>
        <button type="button" data-reset="same" ${ui.pending ? "disabled" : ""}>重开当前夹具</button>
        <button type="button" data-reset="limit" ${ui.pending ? "disabled" : ""}>B+1 夹具</button>
        <button type="button" data-reset="zero-after-two" ${ui.pending ? "disabled" : ""}>Zero 夹具</button>
      </div>
    </section>
  `;
}

function renderAudit() {
  if (!ui.auditOpen) return "";
  const snapshot = ui.snapshot;
  return `
    <section class="audit-drawer">
      <header><div><span class="eyebrow">ENGINE AUDIT · READ ONLY</span><h2>同一状态的协议视图</h2></div><button type="button" data-audit-toggle>关闭</button></header>
      <div class="audit-grid">
        <section class="audit-section"><h3>权威链</h3><dl>
          <div><dt>Run</dt><dd class="mono" title="${escapeHtml(snapshot.run.id)}">${escapeHtml(short(snapshot.run.id))}</dd></div>
          <div><dt>Run Commitment</dt><dd class="mono" title="${escapeHtml(snapshot.authority.runCommitmentId)}">${escapeHtml(short(snapshot.authority.runCommitmentId))}</dd></div>
          <div><dt>Authority Head</dt><dd class="mono" title="${escapeHtml(snapshot.authority.committedAuthorityHash)}">${escapeHtml(short(snapshot.authority.committedAuthorityHash, 18))}</dd></div>
          <div><dt>Base</dt><dd class="mono" title="${escapeHtml(snapshot.base.id)}">${escapeHtml(short(snapshot.base.id))}</dd></div>
          <div><dt>Cascade</dt><dd class="mono">${escapeHtml(short(snapshot.run.cascadeId))}</dd></div>
        </dl></section>
        <section class="audit-section"><h3>当前工件</h3><dl>
          <div><dt>Boundary Manifest</dt><dd class="mono">${escapeHtml(short(snapshot.phase.boundaryManifestId))}</dd></div>
          <div><dt>Frontier</dt><dd class="mono">${escapeHtml(short(snapshot.phase.frontier?.id))}</dd></div>
          <div><dt>Admission</dt><dd class="mono">${escapeHtml(short(snapshot.phase.admission?.id))}</dd></div>
          <div><dt>Plan</dt><dd class="mono">${escapeHtml(short(snapshot.phase.planId))}</dd></div>
          <div><dt>Bundle</dt><dd class="mono">${escapeHtml(short(snapshot.phase.bundleId))}</dd></div>
        </dl></section>
        <section class="audit-section wide"><h3>可见不变量</h3><ol class="audit-checks">
          ${(snapshot.checks ?? []).map((check) => `<li class="${statusClass(check.status)}"><span>${escapeHtml(check.status)}</span><div><strong>${escapeHtml(check.label)}</strong><small>${escapeHtml(check.detail)}</small></div></li>`).join("")}
        </ol></section>
        <section class="audit-section wide"><h3>Receipt lineage</h3><div class="receipt-lineage">
          ${(snapshot.publication.receipts ?? []).map((receipt) => `<article><span>${receipt.position}</span><div><strong class="mono">${escapeHtml(short(receipt.id))}</strong><small>${escapeHtml(receipt.triggerProof?.kind)} · ${escapeHtml(receipt.effectiveWorldTime)} · ${receipt.publishedOutputIds?.length ?? 0} output</small></div></article>`).join("") || "<p>尚无成功 Receipt；深度仍为 0。</p>"}
        </div></section>
      </div>
    </section>
  `;
}

function renderSwitcher() {
  return `
    <nav class="variant-switcher" aria-label="切换视觉方案">
      <button type="button" data-variant-step="-1" aria-label="上一个视觉方案">←</button>
      ${VARIANTS.map((variant) => `
        <button type="button" class="variant-choice ${ui.variant === variant ? "active" : ""}" data-variant="${variant}" aria-pressed="${ui.variant === variant}">
          <b>${variant}</b><span>${VARIANT_NAMES[variant]}</span>
        </button>
      `).join("")}
      <button type="button" data-variant-step="1" aria-label="下一个视觉方案">→</button>
      <span class="switcher-hint mono">← →</span>
    </nav>
  `;
}

function render() {
  if (ui.loading) return;
  if (!ui.snapshot) {
    root.innerHTML = `
      <section class="error-state">
        <span>连接失败</span><h1>没有拿到世界状态</h1><p>${escapeHtml(ui.error ?? "未知错误")}</p>
        <button type="button" data-retry>重新连接</button>
      </section>
    `;
    root.setAttribute("aria-busy", "false");
    return;
  }
  const variants = { A: renderVariantA, B: renderVariantB, C: renderVariantC };
  root.innerHTML = `
    ${renderTopline()}
    ${variants[ui.variant]()}
    ${renderAudit()}
    ${renderSwitcher()}
    ${ui.error ? `<div class="toast failed" role="alert">${escapeHtml(ui.error)}</div>` : ""}
  `;
  root.setAttribute("aria-busy", String(ui.pending));
}

async function apiRequest(url, options = {}) {
  const sessionId = sessionStorage.getItem(SESSION_KEY);
  const headers = new Headers(options.headers ?? {});
  if (sessionId) headers.set("X-Proof01B-Session", sessionId);
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...options, headers });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.message ?? payload?.error ?? `HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function createSession(preset = "limit") {
  const snapshot = await apiRequest(API.create, {
    method: "POST",
    body: JSON.stringify({ preset }),
  });
  sessionStorage.setItem(SESSION_KEY, snapshot.session.id);
  sessionStorage.setItem(PRESET_KEY, snapshot.session.preset);
  return snapshot;
}

async function loadSnapshot() {
  if (!sessionStorage.getItem(SESSION_KEY)) return createSession();
  try {
    return await apiRequest(API.snapshot);
  } catch (error) {
    if (error.status === 404) {
      sessionStorage.removeItem(SESSION_KEY);
      return createSession(sessionStorage.getItem(PRESET_KEY) ?? "limit");
    }
    throw error;
  }
}

async function mutate(url, body) {
  if (ui.pending || !ui.snapshot) return;
  ui.pending = true;
  ui.error = null;
  render();
  try {
    ui.snapshot = await apiRequest(url, {
      method: "POST",
      body: JSON.stringify({
        expectedRevision: ui.snapshot.session.revision,
        ...body,
      }),
    });
    sessionStorage.setItem(PRESET_KEY, ui.snapshot.session.preset);
  } catch (error) {
    if (error.status === 409 && error.payload?.snapshot) {
      ui.snapshot = error.payload.snapshot;
      ui.error = "另一个页面已经推进了这条 Run；已同步到最新状态。";
    } else if (error.status === 404) {
      const preset = ui.snapshot?.session?.preset ?? sessionStorage.getItem(PRESET_KEY) ?? "limit";
      sessionStorage.removeItem(SESSION_KEY);
      ui.snapshot = await createSession(preset);
      ui.error = "临时 Session 已过期，已经创建一条新的 Run。";
    } else {
      ui.error = error.message;
    }
  } finally {
    ui.pending = false;
    render();
  }
}

function setVariant(variant) {
  if (!VARIANTS.includes(variant)) return;
  ui.variant = variant;
  const url = new URL(window.location.href);
  url.searchParams.set("variant", variant);
  history.replaceState(null, "", url);
  render();
}

function stepVariant(delta) {
  const index = VARIANTS.indexOf(ui.variant);
  setVariant(VARIANTS[(index + delta + VARIANTS.length) % VARIANTS.length]);
}

root.addEventListener("click", (event) => {
  const target = event.target.closest("button, [data-variant]");
  if (!target) return;
  if (target.dataset.action) {
    void mutate(API.action, { action: target.dataset.action });
    return;
  }
  if (target.dataset.reset) {
    void mutate(API.reset, { preset: target.dataset.reset });
    return;
  }
  if (target.dataset.variant) {
    setVariant(target.dataset.variant);
    return;
  }
  if (target.dataset.variantStep) {
    stepVariant(Number(target.dataset.variantStep));
    return;
  }
  if (target.hasAttribute("data-audit-toggle")) {
    ui.auditOpen = !ui.auditOpen;
    render();
    return;
  }
  if (target.hasAttribute("data-retry")) void initialize();
});

window.addEventListener("keydown", (event) => {
  const focused = document.activeElement;
  if (focused?.matches("input, textarea, select, [contenteditable='true']")) return;
  if (event.key === "ArrowLeft") stepVariant(-1);
  if (event.key === "ArrowRight") stepVariant(1);
});

window.addEventListener("popstate", () => {
  ui.variant = readVariant();
  render();
});

async function initialize() {
  ui.loading = true;
  ui.error = null;
  try {
    ui.snapshot = await loadSnapshot();
  } catch (error) {
    ui.snapshot = null;
    ui.error = error.message;
  } finally {
    ui.loading = false;
    render();
  }
}

void initialize();
