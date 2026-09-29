/* Cross-device sync for Task Management. Mirrors every planner-* key to your own private Firebase space.
   Works only after you sign in with Google. Without it the app still works on this device. */
(function () {
  var EX = { "planner-view-v1": 1, "planner-notified-v1": 1, "planner-alerts-hint-v1": 1, "planner-sync-meta": 1 };
  var CH = 60000, MK = "planner-sync-meta";
  var ls, OS, OR;
  try { ls = window.localStorage; OS = Storage.prototype.setItem; OR = Storage.prototype.removeItem; } catch (e) { return; }
  var ready = false, kv = null, kc = null, dirty = {}, timer = 0, flushing = false, pill = null, banner = null, fbAuth = null, user = null, signoutArmed = 0;

  function syncKey(k) { return typeof k === "string" && k.indexOf("planner-") === 0 && !EX[k]; }
  function meta() { try { return JSON.parse(ls.getItem(MK) || "{}"); } catch (e) { return {}; } }
  function putMeta(m) { try { OS.call(ls, MK, JSON.stringify(m)); } catch (e) {} }
  function touch(k) {
    if (!ready) return;
    var m = meta(); m[k] = Date.now(); putMeta(m); dirty[k] = 1;
    clearTimeout(timer); timer = setTimeout(flush, 900); status("saving");
  }
  Storage.prototype.setItem = function (k, v) { OS.call(this, k, v); if (this === ls && syncKey(k)) touch(k); };
  Storage.prototype.removeItem = function (k) { OR.call(this, k); if (this === ls && syncKey(k)) touch(k); };

  function status(s) {
    if (!pill) {
      pill = document.createElement("button");
      pill.type = "button";
      pill.style.cssText = "position:fixed;left:10px;bottom:calc(10px + env(safe-area-inset-bottom,0px));z-index:99998;font:600 11px system-ui,sans-serif;padding:6px 11px;border-radius:99px;border:0;background:#2C3B4D;color:#EEE9DF;opacity:.85;cursor:pointer;max-width:80vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      pill.onclick = onPill;
      document.body.appendChild(pill);
    }
    var t = {
      saving: "☁ saving…",
      ok: "☁ synced" + (user && user.displayName ? " · " + user.displayName.split(" ")[0] : ""),
      out: "☁ Sign in with Google to sync your devices",
      none: "☁ sync not set up yet (see setup guide)",
      err: "☁ sync problem, will retry",
      arm: "Tap again to sign out",
      wait: "☁ signing in…"
    }[s] || "";
    pill.textContent = t;
    pill.style.opacity = (s === "ok") ? ".4" : ".9";
  }
  function onPill() {
    if (!fbAuth) return;
    if (!user) {
      status("wait");
      var p = new firebase.auth.GoogleAuthProvider();
      fbAuth.signInWithPopup(p).catch(function (e) {
        if (e && (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment")) fbAuth.signInWithRedirect(p);
        else { status("out"); if (e && e.code === "auth/unauthorized-domain") alert("Add this website address to Firebase: Authentication > Settings > Authorized domains."); }
      });
    } else if (!signoutArmed) {
      signoutArmed = 1; status("arm");
      setTimeout(function () { signoutArmed = 0; status("ok"); }, 3000);
    } else { signoutArmed = 0; fbAuth.signOut(); }
  }

  function push(k) {
    var v = ls.getItem(k), ts = meta()[k] || Date.now(), n, i, p = Promise.resolve();
    if (v === null) return kv.doc(k).set({ k: k, ts: ts, del: true, n: 0 });
    n = Math.max(1, Math.ceil(v.length / CH));
    function w(i) { p = p.then(function () { return kc.doc(k + "-" + i).set({ s: v.slice(i * CH, (i + 1) * CH) }); }); }
    for (i = 0; i < n; i++) w(i);
    return p.then(function () { return kv.doc(k).set({ k: k, ts: ts, n: n }); });
  }
  function flush() {
    if (flushing || !kv) return;
    flushing = true;
    (function loop() {
      var ks = Object.keys(dirty);
      if (!ks.length) { flushing = false; status("ok"); return; }
      var k = ks[0]; delete dirty[k];
      push(k).then(loop, function () {
        flushing = false; status("err"); dirty[k] = 1;
        setTimeout(flush, 15000);
      });
    })();
  }
  async function fetchVal(x) {
    if (x.del) return null;
    var out = "", i, d;
    for (i = 0; i < x.n; i++) { d = await kc.doc(x.k + "-" + i).get(); if (!d.exists) return undefined; out += d.data().s; }
    return out;
  }
  async function applyRemote(list) {
    var m = meta(), n = 0, i, v;
    for (i = 0; i < list.length; i++) {
      v = await fetchVal(list[i]); if (v === undefined) continue;
      if (v === null) OR.call(ls, list[i].k); else OS.call(ls, list[i].k, v);
      m[list[i].k] = list[i].ts; n++;
    }
    putMeta(m); return n;
  }
  function showBanner(getList) {
    if (banner) return;
    banner = document.createElement("div");
    banner.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:calc(50px + env(safe-area-inset-bottom,0px));z-index:99999;background:#2C3B4D;color:#EEE9DF;font:600 13px system-ui,sans-serif;padding:10px 14px;border-radius:14px;box-shadow:0 8px 24px rgba(0,0,0,.3);display:flex;gap:12px;align-items:center;max-width:92vw";
    banner.innerHTML = "<span>Updated on another device</span>";
    var b = document.createElement("button");
    b.textContent = "Refresh";
    b.style.cssText = "font:700 13px system-ui,sans-serif;border:0;border-radius:99px;padding:6px 14px;background:#FFB162;color:#1B2632;cursor:pointer";
    b.onclick = async function () { b.textContent = "…"; await applyRemote(getList()); location.reload(); };
    banner.appendChild(b); document.body.appendChild(banner);
  }
  var unsub = null;
  async function startSync(u) {
    user = u;
    var db = firebase.firestore(), base = db.collection("users").doc(u.uid);
    kv = base.collection("kv"); kc = base.collection("kc");
    status("saving");
    try {
      var snap = await kv.get(), remote = {}, m = meta(), newer = [], k, i;
      snap.forEach(function (d) { var x = d.data(); if (x && x.k) remote[x.k] = x; });
      for (k in remote) if ((m[k] || 0) < remote[k].ts) newer.push(remote[k]);
      var applied = newer.length ? await applyRemote(newer) : 0;
      m = meta();
      for (i = 0; i < ls.length; i++) {
        k = ls.key(i); if (!syncKey(k)) continue;
        if (!remote[k] || ((m[k] || 0) > remote[k].ts && !newer.some(function (x) { return x.k === k; }))) {
          if (!m[k]) m[k] = Date.now(); dirty[k] = 1;
        }
      }
      putMeta(m);
      if (applied) { location.reload(); return; }
      ready = true; flush();
      if (!Object.keys(dirty).length) status("ok");
      unsub = kv.onSnapshot(function (s) {
        var m2 = meta(), pend = [];
        s.forEach(function (d) { var x = d.data(); if (x && x.k && (m2[x.k] || 0) < x.ts) pend.push(x); });
        if (pend.length) showBanner(function () { return pend; });
      }, function () {});
    } catch (e) { status("err"); }
  }
  function stopSync() { ready = false; kv = kc = null; user = null; if (unsub) { unsub(); unsub = null; } status("out"); }

  function init() {
    var cfg = window.FIREBASE_CONFIG;
    if (!cfg || !cfg.apiKey || cfg.apiKey.indexOf("PASTE") === 0) { status("none"); return; }
    if (!window.firebase) { status("err"); return; }
    try {
      firebase.initializeApp(cfg);
      fbAuth = firebase.auth();
      status("out");
      fbAuth.onAuthStateChanged(function (u) { if (u) startSync(u); else stopSync(); });
    } catch (e) { status("err"); }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
  document.addEventListener("visibilitychange", function () { if (document.hidden && ready && Object.keys(dirty).length) flush(); });
})();
