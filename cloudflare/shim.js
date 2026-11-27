// แทน google.script.run ของ Apps Script ด้วยการเรียก /api ของ Cloudflare Worker
window.PD_CF = true;
(function () {
  function runner(ok, fail) {
    return new Proxy({}, { get: function (_, fn) {
      if (fn === 'withSuccessHandler') return function (h) { return runner(h, fail); };
      if (fn === 'withFailureHandler') return function (h) { return runner(ok, h); };
      return function () {
        var args = Array.prototype.slice.call(arguments);
        fetch('/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fn: fn, args: args }) })
          .then(function (r) { return r.json(); })
          .then(function (j) { if (j.ok) { ok && ok(j.result); } else { fail && fail(new Error(j.error || 'เกิดข้อผิดพลาด')); } })
          .catch(function (e) { fail && fail(new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — ' + e.message)); });
      };
    } });
  }
  var q = {}; new URLSearchParams(location.search).forEach(function (v, k) { q[k] = v; });
  window.google = { script: { run: runner(null, null), url: { getLocation: function (cb) { cb({ parameter: q }); } } } };
})();
