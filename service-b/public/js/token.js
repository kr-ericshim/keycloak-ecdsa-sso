// 로그인 토큰 해부 화면 (A, B 공통)
import { $, el, api, toast, fmtTime, shortHex, bootSession, renderIdentity, renderSessionStrip } from "./session.js";

const CONFIG = window.APP_CONFIG || {};
const SERVICES = {
  A: { mark: "發", name: "서명 발급소" },
  B: { mark: "檢", name: "서명 검증소" },
};
const CLIENT_NAMES = { "service-a": "서명 발급소", "service-b": "서명 검증소" };
const CLAIM_LABELS = { preferred_username: "아이디를", name: "이름을", email: "이메일을", sub: "사용자 ID를" };

const state = { proof: null, original: null }; // original: 위조하지 않은 토큰의 내용

// ---------- 그리기 도우미 ----------

function fact(label, value, { sub, mono = false, changed = false } = {}) {
  return el("div", { class: changed ? "is-changed" : null },
    el("dt", { text: label }),
    el("dd", { class: mono ? "mono-dd" : null }, value, sub ? el("small", { text: sub }) : null));
}

function duration(sec) {
  if (sec == null) return "-";
  if (sec <= 0) return "만료됨";
  const m = Math.floor(sec / 60), s = sec % 60;
  return m ? `${m}분 ${s}초 남음` : `${s}초 남음`;
}

function hostOf(url) {
  try { const u = new URL(url); return { host: u.host, path: u.pathname }; } catch { return { host: url, path: "" }; }
}

// 64자 hex 를 4자씩 끊고, 상대 값과 같은 묶음은 초록, 다른 묶음은 빨강
function hexGroups(hex, other) {
  if (!hex) return [el("span", { class: "faint", text: "계산할 수 없음" })];
  const groups = hex.match(/.{1,4}/g);
  const otherGroups = other ? other.match(/.{1,4}/g) : [];
  return groups.map((g, i) => el("span", { class: `g ${otherGroups[i] === g ? "eq" : "ne"}`, text: g }));
}

// ---------- 화면 ----------

function render(p) {
  state.proof = p;
  const seg = p.segments || {};
  const H = seg.header?.json || {};
  const P = seg.payload?.json || {};
  const changedClaim = p.tampered?.claim;

  // 1. 토큰 문자열
  const part = (s, cls, changed) => el("span", { class: `part ${cls}${changed ? " changed" : ""}` },
    s?.head || "", el("span", { class: "gap", text: " … " }), s?.tail || "");
  $("#jwt-line").replaceChildren(
    part(seg.header, "part-h"), el("span", { class: "dotsep", text: "." }),
    part(seg.payload, "part-p", !!changedClaim), el("span", { class: "dotsep", text: "." }),
    part(seg.signature, "part-s"),
  );
  $("#len-h").textContent = seg.header ? `${seg.header.length}자` : "";
  $("#len-p").textContent = seg.payload ? `${seg.payload.length}자` : "";
  $("#len-s").textContent = seg.signature ? `${seg.signature.length}자` : "";

  // 2. 세 조각
  $("#facts-h").replaceChildren(
    fact("서명 방식", H.alg || "-", { sub: H.alg === "ES256" ? "타원곡선 P-256 위의 ECDSA + SHA-256" : "" }),
    fact("토큰 종류", H.typ || "-"),
    fact("서명 키 이름 (kid)", shortHex(H.kid, 10, 6), { mono: true }),
  );

  const iss = hostOf(P.iss);
  const aud = Array.isArray(P.aud) ? P.aud : [P.aud].filter(Boolean);
  $("#facts-p").replaceChildren(
    fact("누가", P.name || "-", { sub: `아이디 ${P.preferred_username || "-"}`, changed: changedClaim === "name" || changedClaim === "preferred_username" }),
    fact("이메일", P.email || "-", { changed: changedClaim === "email" }),
    fact("사용자 ID (sub)", shortHex(P.sub, 8, 6), { mono: true, changed: changedClaim === "sub" }),
    fact("누가 발급했나", iss.host, { sub: iss.path }),
    fact("어느 서비스에 주는 토큰인가", aud.map((a) => CLIENT_NAMES[a] || a).join(", ") || "-", { sub: aud.join(", ") }),
    fact("언제 로그인했나", P.auth_time ? fmtTime(new Date(P.auth_time * 1000).toISOString()) : "-", { sub: duration(p.expiresInSeconds) }),
  );

  $("#facts-s").replaceChildren(
    fact("r", shortHex(p.signature?.r, 12, 8), { mono: true }),
    fact("s", shortHex(p.signature?.s, 12, 8), { mono: true }),
    fact("길이", "64바이트", { sub: "r 32바이트 + s 32바이트" }),
  );

  // 3. 도장 대조
  const ok = !!p.valid;
  const match = $("#match");
  match.classList.toggle("is-valid", ok);
  match.classList.toggle("is-invalid", !ok);

  let lead;
  if (ok) {
    lead = "공개키로 다시 계산한 값이 서명 r과 한 글자도 다르지 않습니다. 이 토큰은 Keycloak이 발급한 그대로이고, 아무도 내용을 고치지 않았습니다.";
  } else if (p.tampered) {
    lead = `${CLAIM_LABELS[p.tampered.claim] || p.tampered.claim} "${p.tampered.from}"에서 "${p.tampered.to}"로 바꾸자 해시가 달라졌고, 계산 결과가 r과 어긋났습니다. 서비스는 이 토큰을 받아들이지 않습니다.`;
  } else {
    const failed = (p.checks || []).find((c) => c.ok === false);
    lead = failed ? `${failed.label} 단계에서 실패했습니다. ${failed.detail || ""}` : "검증하지 못했습니다.";
  }
  $("#match-lead").textContent = lead;

  const stamp = $("#verdict-stamp");
  stamp.textContent = ok ? "일치" : "위조";
  stamp.classList.remove("fresh");
  void stamp.offsetWidth;
  stamp.classList.add("fresh");

  const r = p.signature?.r, rx = p.math?.RxModN;
  $("#hex-r").replaceChildren(...hexGroups(r, rx));
  $("#hex-rx").replaceChildren(...hexGroups(rx, r));

  $("#checks").replaceChildren(...(p.checks || []).map((c) =>
    el("li", { class: c.ok ? "ok" : "fail", title: c.detail || "" }, c.label)));

  const k = p.key || {};
  $("#key-desc").textContent = k.kid
    ? `kid ${shortHex(k.kid, 8, 4)} · ${k.crv || "P-256"} · 점 Q = (${(k.Q?.x || "").slice(0, 8)}…, ${(k.Q?.y || "").slice(0, 8)}…)`
    : "공개키를 찾지 못했습니다.";
  const link = $("#jwks-link");
  link.hidden = !k.jwksUrl;
  if (k.jwksUrl) link.href = k.jwksUrl;

  const m = p.math || {};
  $("#workings").replaceChildren(
    el("dt", { text: "서명된 바이트" }), el("dd", { text: p.hash?.signedBytes ? `${p.hash.signedBytes}바이트 (헤더.내용)` : "-" }),
    el("dt", { text: "e = SHA-256" }), el("dd", { text: p.hash?.e || "-" }),
    el("dt", { text: "w = s⁻¹ mod n" }), el("dd", { text: m.w || "-" }),
    el("dt", { text: "u₁ = e·w" }), el("dd", { text: m.u1 || "-" }),
    el("dt", { text: "u₂ = r·w" }), el("dd", { text: m.u2 || "-" }),
    el("dt", { text: "R = u₁G + u₂Q" }), el("dd", { text: m.R ? `x ${m.R.x}\ny ${m.R.y}` : "-" }),
    el("dt", { text: "판정" }), el("dd", { text: `직접 구현 ${p.manualValid ? "통과" : "실패"} · Node crypto ${p.libraryValid ? "통과" : "실패"}` }),
  );
  $("#workings").querySelectorAll("dd").forEach((d) => (d.style.whiteSpace = "pre-wrap"));

  $("#reset-btn").hidden = !p.tampered;
}

// ---------- 위조 시연 ----------

function suggestValue() {
  const claim = $("#t-claim").value;
  const base = state.original?.[claim];
  if (typeof base !== "string" || !base) { $("#t-value").value = ""; return; }
  const chars = [...base];
  chars[chars.length - 1] = String.fromCodePoint(chars[chars.length - 1].codePointAt(0) + 1);
  $("#t-value").value = chars.join("");
}

async function load(tamper) {
  const btn = $("#tamper-btn");
  btn.setAttribute("aria-busy", "true");
  try {
    const p = tamper
      ? await api("/api/token-proof", { method: "POST", body: JSON.stringify({ tamper }) })
      : await api("/api/token-proof");
    render(p);
    if (!tamper) { state.original = p.segments?.payload?.json || {}; suggestValue(); }
  } catch (e) {
    if (e.message !== "unauthenticated") toast(e.message, { error: true });
  } finally {
    btn.removeAttribute("aria-busy");
  }
}

function bindTamper() {
  $("#t-claim").addEventListener("change", suggestValue);
  $("#t-value").addEventListener("input", () => { $("#e-value").textContent = ""; $("#t-value").removeAttribute("aria-invalid"); });
  $("#tamper-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const value = $("#t-value").value.trim();
    const claim = $("#t-claim").value;
    const error = !value ? "바꿀 값을 입력하세요."
      : value === state.original?.[claim] ? "원래 값과 같습니다. 한 글자라도 다르게 입력하세요." : "";
    if (error) {
      $("#e-value").textContent = error;
      $("#t-value").setAttribute("aria-invalid", "true");
      return;
    }
    load({ claim, value });
  });
  $("#reset-btn").addEventListener("click", () => load());
}

async function main() {
  const me = await bootSession();
  if (!me) return;
  const svc = SERVICES[me.service] || SERVICES.A;
  document.body.dataset.service = me.service;
  $("#brand-mark").textContent = svc.mark;
  $("#brand-name").textContent = svc.name;
  document.title = `로그인 토큰 해부 · ${svc.name}`;
  renderIdentity(me);
  renderSessionStrip(me, { peerName: CONFIG.peerName || "상대 서비스" });
  bindTamper();
  await load();
}

main();
