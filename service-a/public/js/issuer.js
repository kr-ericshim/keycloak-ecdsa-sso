// 서비스 A 서명 발급소 화면
import { $, el, api, toast, fmtTime, shortHex, toBase64Url, bootSession, renderIdentity, renderSessionStrip } from "./session.js";

const CONFIG = window.APP_CONFIG || { peerUrl: "http://localhost:3002", peerName: "서명 검증소" };
const SVG_NS = "http://www.w3.org/2000/svg";

const state = { me: null, items: [], selectedId: null, debugById: new Map() };

// ---------- 정규화: 백엔드와 같은 규칙 (키 사전순 재귀 정렬, 공백 없는 JSON) ----------
function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// ---------- 그림: 보안 무늬(guilloche)와 관인 ----------
function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

// 하이포트로코이드 여러 겹으로 지폐 같은 무늬를 만든다
function guilloche(className, seed = 7) {
  const root = svg("svg", { viewBox: "-100 -100 200 200", class: `guilloche ${className}`, "aria-hidden": "true" });
  const R = 60, r = 60 / seed * 2 + 4;
  for (let layer = 0; layer < 5; layer++) {
    const d = 26 + layer * 6;
    let path = "";
    const steps = 1400;
    const turns = 2 * Math.PI * 12;
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * turns;
      const x = (R - r) * Math.cos(t) + d * Math.cos(((R - r) / r) * t);
      const y = (R - r) * Math.sin(t) - d * Math.sin(((R - r) / r) * t);
      path += `${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`;
    }
    root.append(svg("path", { d: path, fill: "none", stroke: "currentColor", "stroke-width": "0.35" }));
  }
  return root;
}

function seal(cert, fresh) {
  const kid = cert.signature?.kid || "";
  const r = cert.signature?.r || "";
  const root = svg("svg", { viewBox: "0 0 100 100", class: `seal${fresh ? " seal-fresh" : ""}`, role: "img", "aria-label": `발급소 관인, 키 ${kid.slice(0, 8)}` });
  const ringId = `ring-${Math.random().toString(36).slice(2, 8)}`;
  root.append(
    svg("circle", { cx: 50, cy: 50, r: 46, fill: "none", stroke: "currentColor", "stroke-width": 3.2 }),
    svg("circle", { cx: 50, cy: 50, r: 39.5, fill: "none", stroke: "currentColor", "stroke-width": 0.9 }),
  );
  const defs = svg("defs");
  defs.append(svg("path", { id: ringId, d: "M50,50 m-33,0 a33,33 0 1,1 66,0 a33,33 0 1,1 -66,0" }));
  root.append(defs);
  const ring = svg("text", { "font-size": "8.2", fill: "currentColor", "font-family": "Pretendard Variable, sans-serif", "font-weight": "700", "letter-spacing": "1.6" });
  const tp = svg("textPath", { href: `#${ringId}`, startOffset: "0" });
  tp.textContent = `서명발급소 · ES256 · P-256 · ${kid.slice(0, 6)} ·`;
  ring.append(tp);
  root.append(ring);
  const center = svg("text", { x: 50, y: 55, "text-anchor": "middle", "font-size": "19", "font-weight": "700", fill: "currentColor", "font-family": "Nanum Myeongjo, serif" });
  center.textContent = "發給";
  const sub = svg("text", { x: 50, y: 67, "text-anchor": "middle", "font-size": "6.4", fill: "currentColor", "font-family": "JetBrains Mono, monospace" });
  sub.textContent = `r·${r.slice(0, 6)}`;
  root.append(center, sub);
  return root;
}

// ---------- 증명서 렌더 ----------
function renderCertificate(cert, { fresh = false } = {}) {
  const p = cert.payload || {};
  const s = cert.signature || {};
  const spaced = (p.type || "증명서").replace(/\s+/g, "");

  const fields = el("dl", { class: "cert-fields" },
    el("dt", { text: "성명" }), el("dd", { text: p.recipientName || "-" }),
    el("dt", { text: "제목" }), el("dd", { text: p.title || "-" }),
  );
  if (p.description) fields.append(el("dt", { text: "내용" }), el("dd", { class: "cert-desc", text: p.description }));
  fields.append(el("dt", { text: "발급일" }), el("dd", { text: fmtTime(p.issuedAt) }));

  const sigBlock = el("dl", { class: "cert-sig", "aria-label": "전자서명 값" },
    el("dt", { text: "alg" }), el("dd", { text: `${s.alg || "?"} (ECDSA ${s.curve || "P-256"} + SHA-256)` }),
    el("dt", { text: "kid" }), el("dd", { text: s.kid || "-" }),
    el("dt", { text: "hash" }), el("dd", { text: s.hash || "-" }),
    el("dt", { text: "r" }), el("dd", { text: s.r || "-" }),
    el("dt", { text: "s" }), el("dd", { text: s.s || "-" }),
  );

  const frame = el("div", { class: "certificate-frame" },
    el("div", { class: "cert-top" },
      el("span", { text: `No. ${shortHex(p.id, 8, 4)}` }),
      el("span", { text: `발급자 ${p.subject?.username || "-"}` }),
    ),
    el("h3", { class: "cert-type", text: spaced }),
    fields,
    el("p", { class: "cert-attest", text: "위 사실을 타원곡선 전자서명(ECDSA P-256)으로 증명합니다." }),
    el("div", { class: "cert-issuer-line" }, el("span", { text: "서명발급소장" }), seal(cert, fresh)),
    sigBlock,
  );

  const paper = el("article", { class: "certificate", "aria-label": `${p.type || "증명서"} ${p.title || ""}` }, frame);
  paper.prepend(guilloche("guilloche-main", 7), guilloche("guilloche-corner", 5));
  return paper;
}

function select(id, { fresh = false } = {}) {
  const cert = state.items.find((c) => c.payload?.id === id);
  if (!cert) return;
  state.selectedId = id;

  $("#certificate-slot").replaceChildren(renderCertificate(cert, { fresh }));
  $("#preview-actions").hidden = false;
  $("#verify-link").href = `${CONFIG.peerUrl}/#cert=${toBase64Url(JSON.stringify(cert))}`;
  $("#verify-link").target = "_blank";
  $("#verify-link").rel = "noopener";

  const debug = state.debugById.get(id);
  $("#canonical-text").textContent = debug?.canonicalPayload || canonicalize(cert.payload);
  $("#canonical").hidden = false;

  document.querySelectorAll(".row-btn").forEach((b) => b.setAttribute("aria-current", String(b.dataset.id === id)));
}

function renderList() {
  const list = $("#cert-list");
  $("#list-count").textContent = state.items.length ? `${state.items.length}건` : "";
  if (!state.items.length) {
    list.replaceChildren(el("li", { class: "cert-list-empty muted", text: "아직 발급한 증명서가 없습니다. 증명서 발급 양식으로 첫 증명서를 만들어 보세요." }));
    return;
  }
  list.replaceChildren(...state.items.map((c) => {
    const p = c.payload;
    return el("li", {},
      el("button", { type: "button", class: "row-btn", "data-id": p.id, "aria-current": String(p.id === state.selectedId), onclick: () => select(p.id) },
        el("span", { class: "row-type", text: p.type }),
        el("span", { class: "row-main" },
          el("div", { class: "row-title", text: p.title }),
          el("div", { class: "row-meta", text: `${p.recipientName} · r ${shortHex(c.signature?.r, 6, 4)}` }),
        ),
        el("span", { class: "row-time", text: fmtTime(p.issuedAt) }),
      ));
  }));
}

async function loadList() {
  try {
    const data = await api("/api/certificates");
    state.items = data.items || [];
    renderList();
    if (!state.selectedId && state.items[0]) select(state.items[0].payload.id);
  } catch (e) {
    if (e.message === "unauthenticated") return;
    $("#cert-list").replaceChildren(el("li", { class: "cert-list-empty", text: `목록을 불러오지 못했습니다. ${e.message}` }));
  }
}

async function loadKey() {
  const host = $("#key-info");
  try {
    const k = await api("/api/issuer-key");
    host.replaceChildren(
      el("dt", { text: "kid" }), el("dd", { class: "mono", text: k.kid }),
      el("dt", { text: "곡선" }), el("dd", { text: `${k.curve} (secp256r1) · ${k.alg}` }),
      el("dt", { text: "Q.x" }), el("dd", { class: "hex", text: k.point?.x || "-" }),
      el("dt", { text: "Q.y" }), el("dd", { class: "hex", text: k.point?.y || "-" }),
      el("dt", { text: "생성" }), el("dd", { text: fmtTime(k.createdAt) }),
    );
  } catch (e) {
    if (e.message === "unauthenticated") return;
    host.replaceChildren(el("dt", { text: "상태" }), el("dd", { class: "muted", text: `공개키를 불러오지 못했습니다. ${e.message}` }));
  }
}

function setFieldError(input, errorEl, msg) {
  input.setAttribute("aria-invalid", msg ? "true" : "false");
  errorEl.textContent = msg || "";
}

function bindForm() {
  const form = $("#issue-form");
  const recipient = $("#f-recipient");
  const title = $("#f-title");
  recipient.addEventListener("input", () => setFieldError(recipient, $("#e-recipient"), ""));
  title.addEventListener("input", () => setFieldError(title, $("#e-title"), ""));

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const body = {
      type: $("#f-type").value,
      recipientName: recipient.value.trim(),
      title: title.value.trim(),
      description: $("#f-desc").value.trim(),
    };
    let bad = false;
    if (!body.recipientName) { setFieldError(recipient, $("#e-recipient"), "받는 사람 이름을 입력하세요."); bad = true; }
    if (!body.title) { setFieldError(title, $("#e-title"), "증명서 제목을 입력하세요."); bad = true; }
    if (bad) { (body.recipientName ? title : recipient).focus(); return; }

    const btn = $("#issue-btn");
    btn.setAttribute("aria-busy", "true");
    btn.textContent = "서명하는 중…";
    try {
      const data = await api("/api/certificates", { method: "POST", body: JSON.stringify(body) });
      const cert = data.certificate;
      state.items = [cert, ...state.items.filter((c) => c.payload.id !== cert.payload.id)];
      if (data.debug) state.debugById.set(cert.payload.id, data.debug);
      renderList();
      select(cert.payload.id, { fresh: true });
      title.value = "";
      $("#f-desc").value = "";
      toast("증명서에 서명해 발급했습니다.");
    } catch (e) {
      if (e.message !== "unauthenticated") toast(e.message, { error: true });
    } finally {
      btn.removeAttribute("aria-busy");
      btn.textContent = "서명하고 발급";
    }
  });
}

function bindActions() {
  $("#download-btn").addEventListener("click", () => {
    const cert = state.items.find((c) => c.payload.id === state.selectedId);
    if (!cert) return;
    const blob = new Blob([JSON.stringify(cert, null, 2)], { type: "application/json" });
    const a = el("a", { href: URL.createObjectURL(blob), download: `certificate-${cert.payload.id.slice(0, 8)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
}

async function main() {
  const me = await bootSession();
  if (!me) return;
  state.me = me;
  renderIdentity(me);
  renderSessionStrip(me, { peerName: CONFIG.peerName });
  const peer = $("#peer-link");
  peer.href = CONFIG.peerUrl;
  peer.textContent = `${CONFIG.peerName}로 이동 ↗`;
  $("#f-recipient").value = me.user?.name || me.user?.username || "";
  bindForm();
  bindActions();
  await Promise.all([loadKey(), loadList()]);
}

main();
