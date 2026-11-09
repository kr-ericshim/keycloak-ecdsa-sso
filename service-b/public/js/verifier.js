// 서비스 B 서명 검증소 화면
import { $, el, api, toast, fmtTime, shortHex, fromBase64Url, takePendingHash, bootSession, renderIdentity, renderSessionStrip } from "./session.js";

const CONFIG = window.APP_CONFIG || { peerUrl: "http://localhost:3001", peerName: "서명 발급소" };
const SVG_NS = "http://www.w3.org/2000/svg";

// ---------- 입력 ----------

function setCertError(msg) {
  const input = $("#cert-input");
  input.setAttribute("aria-invalid", msg ? "true" : "false");
  $("#e-cert").textContent = msg || "";
}

function readCertificate() {
  const raw = $("#cert-input").value.trim();
  if (!raw) { setCertError("검증할 증명서 JSON을 넣으세요."); return null; }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    setCertError("JSON 형식이 아닙니다. 발급소에서 내려받은 파일 내용을 그대로 붙여넣으세요.");
    return null;
  }
}

function fillInput(cert) {
  $("#cert-input").value = JSON.stringify(cert, null, 2);
  setCertError("");
}

async function verify() {
  const cert = readCertificate();
  if (!cert) { $("#cert-input").focus(); return; }
  const btn = $("#verify-btn");
  btn.setAttribute("aria-busy", "true");
  btn.textContent = "검증하는 중…";
  try {
    const result = await api("/api/verify", { method: "POST", body: JSON.stringify({ certificate: cert }) });
    renderResult(result);
    loadHistory();
  } catch (e) {
    if (e.message !== "unauthenticated") toast(e.message, { error: true });
  } finally {
    btn.removeAttribute("aria-busy");
    btn.textContent = "서명 검증";
  }
}

// 위조 시연: 서명은 그대로 두고 받는 사람 이름의 마지막 글자만 바꾼다
function tamper() {
  const cert = readCertificate();
  if (!cert) return;
  const name = cert.payload?.recipientName;
  if (typeof name !== "string" || !name.length) {
    setCertError("payload.recipientName 이 없어 위조 시연을 할 수 없습니다.");
    return;
  }
  const chars = [...name];
  const last = chars[chars.length - 1];
  chars[chars.length - 1] = String.fromCodePoint(last.codePointAt(0) + 1);
  const forged = chars.join("");
  cert.payload.recipientName = forged;
  fillInput(cert);
  const note = $("#tamper-note");
  note.textContent = `받는 사람을 "${name}"에서 "${forged}"로 바꿨습니다. 서명값 r, s는 그대로입니다.`;
  note.hidden = false;
  verify();
}

function bindInput() {
  $("#verify-btn").addEventListener("click", verify);
  $("#tamper-btn").addEventListener("click", tamper);
  $("#clear-btn").addEventListener("click", () => {
    $("#cert-input").value = "";
    $("#tamper-note").hidden = true;
    setCertError("");
    $("#result").hidden = true;
    $("#result-empty").hidden = false;
  });
  $("#cert-input").addEventListener("input", () => { setCertError(""); $("#tamper-note").hidden = true; });

  const loadFile = async (file) => {
    if (!file) return;
    try {
      const text = await file.text();
      fillInput(JSON.parse(text));
      $("#tamper-note").hidden = true;
      verify();
    } catch {
      setCertError(`${file.name} 파일을 JSON으로 읽지 못했습니다.`);
    }
  };
  $("#file-input").addEventListener("change", (e) => loadFile(e.target.files?.[0]));
  const dz = $("#dropzone");
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("is-over"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("is-over"));
  dz.addEventListener("drop", (e) => { e.preventDefault(); dz.classList.remove("is-over"); loadFile(e.dataTransfer?.files?.[0]); });
}

// ---------- 결과 ----------

function renderResult(r) {
  $("#result-empty").hidden = true;
  $("#result").hidden = false;

  // 판정
  const verdict = $("#verdict");
  const failed = (r.steps || []).find((s) => s.ok === false);
  // 발급자 키를 모르는 경우는 위조와 다르다: 내용은 그대로일 수 있지만 누가 서명했는지 확인할 수 없다
  const unknownKey = !r.valid && failed?.key === "issuerKey";
  const hashOk = (r.steps || []).find((s) => s.key === "hash")?.ok === true;
  const v = r.valid
    ? { cls: "is-valid", stamp: "眞本", en: "VERIFIED", title: "진본입니다", lead: r.summary }
    : unknownKey
      ? { cls: "is-unknown", stamp: "未確認", en: "UNKNOWN KEY", title: "이 검증소가 모르는 발급 키입니다",
          lead: `이 증명서는 다른 서명 발급소(또는 예전 키)로 서명되었습니다.${hashOk ? " 내용이 바뀌지는 않았지만" : ""} 이 검증소가 신뢰하는 공개키가 아니라서 진위를 확인할 수 없습니다.` }
      : { cls: "is-invalid", stamp: "僞造", en: "FORGED", title: "위조되었거나 손상된 증명서입니다", lead: r.summary };
  verdict.className = `verdict ${v.cls}`;
  verdict.replaceChildren(
    el("div", { class: "stamp", "aria-hidden": "true" },
      el("span", {}, v.stamp, el("small", { text: v.en }))),
    el("div", {},
      el("h2", { text: v.title }),
      el("p", { text: v.lead || (failed ? `${failed.label} 단계에서 실패했습니다.` : "") }),
      el("div", { class: "verdict-meta" },
        el("span", { class: "badge badge-accent", text: `ECDSA ${r.math?.curve?.name || "P-256"}` }),
        r.payload ? el("span", { class: "badge", text: `kid ${shortHex(r.payload?.issuer?.kid, 6, 4)}` }) : null,
        failed ? el("span", { class: "badge badge-bad", text: `실패: ${failed.label}` }) : null,
      ),
    ),
  );

  // 단계 레일
  const steps = $("#steps");
  steps.classList.remove("is-animating");
  steps.replaceChildren(...(r.steps || []).map((s, i) => {
    const cls = s.ok === true ? "ok" : s.ok === false ? "fail" : "skip";
    return el("li", { class: `step ${cls}`, style: `--i:${i}` },
      el("div", {},
        el("div", { class: "step-label", text: s.label }),
        s.detail ? el("div", { class: "step-detail", text: s.detail }) : null,
        el("span", { class: "sr-only", text: cls === "ok" ? "통과" : cls === "fail" ? "실패" : "건너뜀" }),
      ));
  }));
  void steps.offsetWidth; // 애니메이션 재시작
  steps.classList.add("is-animating");

  // 증명서 내용
  const p = r.payload;
  const kv = $("#payload-kv");
  if (p) {
    kv.replaceChildren(
      el("dt", { text: "종류" }), el("dd", { text: p.type || "-" }),
      el("dt", { text: "받는 사람" }), el("dd", { text: p.recipientName || "-" }),
      el("dt", { text: "제목" }), el("dd", { text: p.title || "-" }),
      el("dt", { text: "발급자" }), el("dd", { text: `${p.issuer?.name || "-"} (${p.subject?.username || "-"})` }),
      el("dt", { text: "발급일" }), el("dd", { text: fmtTime(p.issuedAt) }),
      el("dt", { text: "증명서 ID" }), el("dd", { class: "mono", text: shortHex(p.id, 8, 6) }),
    );
  } else {
    kv.replaceChildren(el("dt", { text: "상태" }), el("dd", { class: "muted", text: "형식이 맞지 않아 내용을 읽지 못했습니다." }));
  }

  renderMath(r.math, r.valid);
}

function big(hex) {
  try { return hex ? BigInt(`0x${hex}`) : null; } catch { return null; }
}

function eq(formula, note, value) {
  return el("div", { class: "eq" },
    el("div", { class: "eq-formula" }, formula, note ? el("span", { class: "eq-note", text: note }) : null),
    el("div", { class: "eq-value", text: value ?? "계산할 수 없음" }));
}

function renderMath(m, valid) {
  const box = $("#math");
  if (!m) { box.hidden = true; return; }
  box.hidden = false;

  const chip = (label, v) => el("span", { class: `badge ${v === true ? "badge-ok" : v === false ? "badge-bad" : ""}`, text: `${label} ${v === true ? "통과" : v === false ? "실패" : "-"}` });
  $("#math-chips").replaceChildren(chip("직접 구현(BigInt)", m.manualValid), chip("Node crypto", m.libraryValid));

  // R.x mod n 과 r 비교
  const n = big(m.curve?.n);
  const Rx = big(m.R?.x);
  const r = big(m.r);
  const RxModN = Rx != null && n ? (Rx % n).toString(16).padStart(64, "0") : null;
  const match = RxModN != null && r != null ? big(RxModN) === r : null;

  const compare = el("div", { class: `eq is-compare ${match === true ? "match" : match === false ? "mismatch" : ""}` },
    el("div", { class: "eq-formula" }, "R.x mod n  =?  r", el("span", { class: "eq-note", text: "같으면 서명이 맞다" })),
    el("dl", { class: "compare-row" },
      el("dt", { text: "R.x" }), el("dd", { text: RxModN ?? "계산할 수 없음" }),
      el("dt", { text: "r" }), el("dd", { text: m.r ?? "-" }),
    ),
    el("div", { class: "compare-verdict", text: match === true ? "일치: 이 개인키로 이 내용에 서명한 것이 맞습니다." : match === false ? "불일치: 내용이 바뀌었거나 다른 키로 서명했습니다." : "비교할 값이 없습니다." }),
  );

  $("#equations").replaceChildren(
    eq("e = SHA-256(정규화한 payload)", "재계산한 해시를 정수로 본 값", m.e),
    eq("w = s⁻¹ mod n", "s의 모듈러 역원", m.w),
    eq("u₁ = e · w mod n", null, m.u1),
    eq("u₂ = r · w mod n", null, m.u2),
    eq("Q = d · G", "발급소 공개키 (d는 비밀)", m.Q ? `x ${m.Q.x}\ny ${m.Q.y}` : null),
    eq("R = u₁·G + u₂·Q", "타원곡선 위 점 덧셈", m.R ? `x ${m.R.x}\ny ${m.R.y}` : null),
    compare,
  );
  $("#equations").querySelectorAll(".eq-value").forEach((n) => (n.style.whiteSpace = "pre-wrap"));

  drawCurve(match ?? valid);

  const c = m.curve || {};
  $("#curve-params").replaceChildren(
    el("dt", { text: "식" }), el("dd", { text: "y² = x³ + ax + b (mod p)" }),
    el("dt", { text: "p" }), el("dd", { text: c.p || "-" }),
    el("dt", { text: "a" }), el("dd", { text: c.a || "-" }),
    el("dt", { text: "b" }), el("dd", { text: c.b || "-" }),
    el("dt", { text: "n" }), el("dd", { text: c.n || "-" }),
    el("dt", { text: "G.x" }), el("dd", { text: c.G?.x || "-" }),
    el("dt", { text: "G.y" }), el("dd", { text: c.G?.y || "-" }),
  );
}

// ---------- 곡선 개념도: y² = x³ − 3x + 3 (실수) ----------
// P-256 과 같은 a = −3 을 쓰고 b 만 작게 바꿔 그린 그림이다.
function drawCurve(ok) {
  const svgEl = $("#curve");
  const W = 320, H = 260;
  const X0 = -2.6, X1 = 3.1, Y = 5.2;
  const sx = (x) => ((x - X0) / (X1 - X0)) * (W - 20) + 10;
  const sy = (y) => H / 2 - (y / Y) * (H / 2 - 12);
  const f = (x) => x ** 3 - 3 * x + 3;
  const node = (tag, attrs, text) => {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text) n.textContent = text;
    return n;
  };

  // 곡선 경로 (위쪽 가지 + 아래쪽 가지)
  const root = -2.10380340273554;
  let upper = "", lower = "";
  const steps = 160;
  for (let i = 0; i <= steps; i++) {
    const x = root + ((X1 - root) * (i / steps) ** 1.6);
    const y = Math.sqrt(Math.max(0, f(x)));
    if (y > Y) break;
    upper += `${i ? "L" : "M"}${sx(x).toFixed(1)} ${sy(y).toFixed(1)}`;
    lower += `${i ? "L" : "M"}${sx(x).toFixed(1)} ${sy(-y).toFixed(1)}`;
  }

  // 점 덧셈: P1 = u1·G, P2 = u2·Q 를 대표하는 두 점
  const x1 = -1.6, y1 = Math.sqrt(f(x1));
  const x2 = 0.6, y2 = Math.sqrt(f(x2));
  const m = (y2 - y1) / (x2 - x1);
  const x3 = m * m - x1 - x2;
  const y3 = y1 + m * (x3 - x1); // 직선과 곡선의 세 번째 교점
  const Rx = x3, Ry = -y3; // x축 대칭 = R

  const ext = (x) => y1 + m * (x - x1);
  svgEl.replaceChildren(
    node("title", {}, "타원곡선 점 덧셈 개념도"),
    node("line", { x1: 10, y1: sy(0), x2: W - 10, y2: sy(0), class: "curve-axis" }),
    node("line", { x1: sx(0), y1: 8, x2: sx(0), y2: H - 8, class: "curve-axis" }),
    node("path", { d: upper, class: "curve-line" }),
    node("path", { d: lower, class: "curve-line" }),
    node("line", { x1: sx(-2.3), y1: sy(ext(-2.3)), x2: sx(2.0), y2: sy(ext(2.0)), class: "curve-chord" }),
    node("line", { x1: sx(x3), y1: sy(y3), x2: sx(Rx), y2: sy(Ry), class: "curve-reflect" }),
    node("circle", { cx: sx(x1), cy: sy(y1), r: 4.5, class: "curve-pt" }),
    node("text", { x: sx(x1) - 8, y: sy(y1) - 10, class: "curve-label", "text-anchor": "middle" }, "u₁·G"),
    node("circle", { cx: sx(x2), cy: sy(y2), r: 4.5, class: "curve-pt" }),
    node("text", { x: sx(x2) - 4, y: sy(y2) - 10, class: "curve-label", "text-anchor": "middle" }, "u₂·Q"),
    node("circle", { cx: sx(x3), cy: sy(y3), r: 4, class: "curve-pt-third" }),
    node("text", { x: sx(x3) + 10, y: sy(y3) - 6, class: "curve-label" }, "−R"),
    node("circle", { cx: sx(Rx), cy: sy(Ry), r: 5.5, class: "curve-pt-r" }),
    node("text", { x: sx(Rx) + 10, y: sy(Ry) + 4, class: "curve-label curve-label-r" }, ok === false ? "R  (x ≠ r)" : "R  (x = r)"),
  );
  const fig = svgEl.closest(".curve-figure");
  fig.classList.remove("curve-draw");
  void fig.offsetWidth;
  fig.classList.add("curve-draw");
}

// ---------- 기록 ----------

async function loadHistory() {
  const list = $("#history");
  try {
    const data = await api("/api/verifications");
    const items = data.items || [];
    if (!items.length) {
      list.replaceChildren(el("li", { class: "muted history-empty", text: "아직 검증한 증명서가 없습니다." }));
      return;
    }
    list.replaceChildren(...items.slice(0, 8).map((h) =>
      el("li", {},
        el("span", { class: `badge ${h.valid ? "badge-ok" : "badge-bad"}`, text: h.valid ? "진본" : "실패" }),
        el("span", { class: "h-title", text: `${h.title || "(제목 없음)"} · ${h.recipientName || "-"}` }),
        el("span", { class: "h-time", text: fmtTime(h.verifiedAt) }),
      )));
  } catch (e) {
    if (e.message === "unauthenticated") return;
    list.replaceChildren(el("li", { class: "history-empty", text: `기록을 불러오지 못했습니다. ${e.message}` }));
  }
}

// ---------- 시작 ----------

async function main() {
  const pendingHash = takePendingHash();
  const me = await bootSession();
  if (!me) return;
  renderIdentity(me);
  renderSessionStrip(me, { peerName: CONFIG.peerName });
  const peer = $("#peer-link");
  peer.href = CONFIG.peerUrl;
  peer.textContent = `${CONFIG.peerName}로 이동 ↗`;
  bindInput();
  loadHistory();

  // 발급소의 "검증소에서 확인"으로 들어온 경우: #cert=<base64url JSON>
  const match = /^#cert=([A-Za-z0-9_-]+)$/.exec(pendingHash || "");
  if (match) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
    try {
      fillInput(JSON.parse(fromBase64Url(match[1])));
      verify();
    } catch {
      setCertError("링크로 받은 증명서를 읽지 못했습니다. JSON 파일로 다시 시도하세요.");
    }
  }
}

main();
