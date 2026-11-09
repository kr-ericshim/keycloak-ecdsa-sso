// 공통 세션 모듈: 서비스 A와 B가 같은 파일을 쓴다.
// 1) /api/me 로 로그인 상태를 확인하고
// 2) 로그인 안 됐으면 Keycloak 로그인(/login)으로 보내고
// 3) 로그인 됐으면 상단 신원 칩과 하단 "SSO 세션" 패널을 그린다.

const PENDING_HASH_KEY = "sso-demo:pending-hash";

export function $(sel, root = document) { return root.querySelector(sel); }

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function fmtTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function fmtClock(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function shortHex(hex, head = 8, tail = 6) {
  if (!hex) return "-";
  const s = String(hex);
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

// UTF-8 JSON <-> base64url (증명서를 URL fragment 로 넘길 때 사용)
export function toBase64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromBase64Url(b64) {
  const norm = b64.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(norm + "===".slice((norm.length + 3) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

let toastTimer;
export function toast(message, { error = false } = {}) {
  let node = $("#toast");
  if (!node) {
    node = el("div", { id: "toast", class: "toast", role: "status", "aria-live": "polite" });
    document.body.append(node);
  }
  node.textContent = message;
  node.classList.toggle("is-error", error);
  node.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("is-visible"), 3200);
}

export async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    ...options,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 본문이 없거나 JSON 이 아님 */ }
  if (res.status === 401) {
    redirectToLogin();
    throw new Error("unauthenticated");
  }
  if (!res.ok) {
    const err = new Error(data?.message || `요청이 실패했습니다 (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function currentPath() {
  return window.location.pathname + window.location.search.replace(/[?&]loggedOut=1/, "");
}

export function redirectToLogin() {
  // fragment(#cert=...)는 서버로 가지 않으므로 로그인 왕복 동안 sessionStorage 에 보관한다
  if (window.location.hash) {
    try { sessionStorage.setItem(PENDING_HASH_KEY, window.location.hash); } catch { /* 무시 */ }
  }
  const returnTo = currentPath() || "/";
  window.location.assign(`/login?returnTo=${encodeURIComponent(returnTo)}`);
}

export function takePendingHash() {
  let hash = window.location.hash;
  try {
    const saved = sessionStorage.getItem(PENDING_HASH_KEY);
    if (!hash && saved) hash = saved;
    sessionStorage.removeItem(PENDING_HASH_KEY);
  } catch { /* 무시 */ }
  return hash;
}

// 페이지 진입점. 로그인돼 있으면 me 를 돌려주고, 아니면 로그인으로 보내거나 로그아웃 화면을 보여준다.
export async function bootSession() {
  const params = new URLSearchParams(window.location.search);
  let res;
  try {
    res = await fetch("/api/me", { credentials: "same-origin" });
  } catch {
    showGate("error");
    return null;
  }
  if (res.status === 401) {
    if (params.get("loggedOut") === "1") {
      showGate("loggedOut");
      return null;
    }
    redirectToLogin();
    return null;
  }
  if (!res.ok) { showGate("error"); return null; }
  const me = await res.json();
  if (params.has("loggedOut")) {
    const url = new URL(window.location.href);
    url.searchParams.delete("loggedOut");
    history.replaceState(null, "", url);
  }
  document.querySelectorAll("[data-gate]").forEach((n) => (n.hidden = true));
  $("#app").hidden = false;
  return me;
}

function showGate(kind) {
  document.querySelectorAll("[data-gate]").forEach((n) => (n.hidden = n.dataset.gate !== kind));
  $("#app").hidden = true;
}

export function renderIdentity(me) {
  const host = $("#identity");
  if (!host) return;
  const name = me.user?.name || me.user?.username || "사용자";
  host.replaceChildren(
    el("div", { class: "identity-text" },
      el("span", { class: "identity-name", text: name }),
      el("span", { class: "identity-meta", text: `Keycloak SSO · ${me.token?.header?.alg || "?"}` }),
    ),
    el("form", { method: "post", action: "/logout" },
      el("button", { class: "btn btn-ghost btn-sm", type: "submit", text: "로그아웃" }),
    ),
  );
}

// "이 서비스는 새로 인증하지 않았다"는 증거: authTime(= ID 토큰 auth_time)과 이 서비스의 loginAt 비교
export function renderSessionStrip(me, { peerName }) {
  const host = $("#session-strip");
  if (!host) return;
  const s = me.session || {};
  const t = me.token || {};
  const authMs = Date.parse(s.authTime);
  const loginMs = Date.parse(s.loginAt);
  const gapSec = Number.isFinite(authMs) && Number.isFinite(loginMs) ? Math.round((loginMs - authMs) / 1000) : null;
  const reused = gapSec != null && gapSec >= 2;

  const lead = reused
    ? `이 서비스에 세션이 생긴 시각이 Keycloak 인증 시각보다 ${gapSec}초 늦습니다. 이미 있던 SSO 세션으로 들어왔고, 비밀번호를 다시 입력하지 않았다는 뜻입니다.`
    : `방금 Keycloak에서 인증했습니다. 이제 ${peerName}에 들어가면 인증 시각이 이 값과 같게 나옵니다.`;

  const cell = (label, value, key = false) =>
    el("div", { class: `session-cell${key ? " is-key" : ""}` },
      el("div", { class: "label", text: label }),
      el("div", { class: "value", text: value }));

  host.replaceChildren(
    el("div", {},
      el("h2", { text: "이 로그인 세션" }),
      el("p", { class: "lead", text: lead }),
    ),
    el("div", { class: "session-grid" },
      cell("Keycloak 인증 시각 (auth_time)", fmtTime(s.authTime), true),
      cell(`이 서비스 세션 생성 (서비스 ${me.service})`, fmtTime(s.loginAt)),
      cell("SSO 세션 ID (sid)", shortHex(s.sid, 10, 6)),
      cell("ID 토큰 서명", `${t.header?.alg || "?"} · kid ${shortHex(t.header?.kid, 6, 4)} · ${t.signatureVerified ? "검증됨" : "미검증"}`),
      cell("토큰 발급자 (iss)", t.claims?.iss || "-"),
      cell("대상 클라이언트 (aud)", Array.isArray(t.claims?.aud) ? t.claims.aud.join(", ") : (t.claims?.aud || "-")),
    ),
  );
}
