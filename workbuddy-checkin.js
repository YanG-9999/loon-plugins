/*
 * WorkBuddy 每日签到 + 派猫猫旅行自动化 (Loon 插件脚本)
 * =====================================================
 * 入口1 http-request : 捕获 iOS 端 WorkBuddy(App/网页) 请求中的
 *                      Authorization: Bearer 令牌，存入 $prefs
 * 入口2 cron         : 每天定时执行
 *                      - Buddy加油站每日签到（100积分/天，7天循环共1600）
 *                      - 派猫猫旅行状态机：空闲→派出 / 旅行中→等待 / 回来→领取
 *
 * 接口（2026-10 实测，双域名自动切换，仅需 Bearer 令牌）：
 *   POST https://www.codebuddy.cn/v2/billing/meter/daily-checkin          签到
 *   POST https://www.codebuddy.cn/v2/billing/meter/checkin-activity-status 查状态
 *   GET  https://www.workbuddy.cn/activity/growth/buddy/travel/status     旅行状态
 *   GET  https://www.workbuddy.cn/activity/growth/buddy/travel/config     地点列表
 *   POST https://www.workbuddy.cn/activity/growth/buddy/travel/depart     派遣
 *   POST https://www.workbuddy.cn/activity/growth/buddy/travel/claim      领取
 */

(function () {
  "use strict";

  var CONF = {
    domains: ["www.codebuddy.cn", "www.workbuddy.cn"],
    prefToken: "wb_bearer_token",
    prefTokenAt: "wb_bearer_token_at",
    epCheckin: "/v2/billing/meter/daily-checkin",
    epStatus: "/v2/billing/meter/checkin-activity-status",
    epTravelStatus: "/activity/growth/buddy/travel/status",
    epTravelConfig: "/activity/growth/buddy/travel/config",
    epTravelDepart: "/activity/growth/buddy/travel/depart",
    epTravelClaim: "/activity/growth/buddy/travel/claim",
    httpTimeout: 10000
  };

  /* ---------------- 工具 ---------------- */

  function argOf(key, def) {
    try {
      if (typeof $argument === "undefined" || $argument === null) return def;
      var v = $argument[key];
      if (v === undefined || v === null || v === "") return def;
      return v;
    } catch (e) { return def; }
  }

  function parseJson(data) {
    if (data && typeof data === "object") return data;
    if (typeof data !== "string") return null;
    try { return JSON.parse(data); } catch (e) { return null; }
  }

  // BFS 深查找：返回第一个包含指定字段名的值（兼容 data.data 双层结构）
  function deepFind(obj, names, maxDepth) {
    if (!obj || typeof obj !== "object") return undefined;
    maxDepth = maxDepth || 6;
    var lower = names.map(function (n) { return String(n).toLowerCase(); });
    var queue = [[obj, 0]];
    while (queue.length) {
      var item = queue.shift();
      var cur = item[0], depth = item[1];
      if (!cur || typeof cur !== "object" || depth > maxDepth) continue;
      var keys = Object.keys(cur);
      var i, v;
      for (i = 0; i < keys.length; i++) {
        if (lower.indexOf(keys[i].toLowerCase()) !== -1) return cur[keys[i]];
      }
      for (i = 0; i < keys.length; i++) {
        v = cur[keys[i]];
        if (v && typeof v === "object") queue.push([v, depth + 1]);
      }
    }
    return undefined;
  }

  // BFS 深查找：返回第一个"元素为对象的数组"
  function deepFindArray(obj, maxDepth) {
    if (!obj || typeof obj !== "object") return null;
    maxDepth = maxDepth || 6;
    var queue = [[obj, 0]];
    while (queue.length) {
      var item = queue.shift();
      var cur = item[0], depth = item[1];
      if (!cur || typeof cur !== "object" || depth > maxDepth) continue;
      if (Array.isArray(cur) && cur.length && cur[0] && typeof cur[0] === "object") return cur;
      var vals = Array.isArray(cur) ? cur : Object.keys(cur).map(function (k) { return cur[k]; });
      for (var i = 0; i < vals.length; i++) {
        var v = vals[i];
        if (v && typeof v === "object") queue.push([v, depth + 1]);
      }
    }
    return null;
  }

  // WorkBuddy 业务数据可能在 data.data（双层）或 data
  function bizData(json) {
    if (!json) return null;
    if (json.data && json.data.data && typeof json.data.data === "object") return json.data.data;
    if (json.data && typeof json.data === "object") return json.data;
    return json;
  }

  function http(method, url, token, bodyObj) {
    return new Promise(function (resolve, reject) {
      var headers = {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        "Accept": "application/json, text/plain, */*"
      };
      if (token) headers["Authorization"] = token;
      var opts = { url: url, headers: headers, timeout: CONF.httpTimeout };
      if (bodyObj !== null && bodyObj !== undefined) {
        opts.body = JSON.stringify(bodyObj);
        headers["Content-Type"] = "application/json";
      }
      var fn = (method === "GET") ? $httpClient.get : $httpClient.post;
      try {
        fn(opts, function (err, resp, data) {
          if (err) return reject(new Error("NET:" + (err.message || JSON.stringify(err))));
          var status = resp ? (resp.status || resp.statusCode || 0) : 0;
          resolve({ status: status, data: data });
        });
      } catch (e) { reject(e); }
    });
  }

  /* ---------------- 派猫猫状态解析 ---------------- */

  function travelStateOf(parsed, raw) {
    // 1) 结构化字段优先
    var v = deepFind(parsed, ["state", "travel_state", "trip_status", "status", "phase", "stage"]);
    var s = (v === undefined || v === null) ? "" : String(v).toLowerCase();
    if (s) {
      if (/travel|out|ing|way|busy|walk/.test(s)) return "traveling";
      if (/return|claim|back|finish|done|reward|gift|complete/.test(s)) return "returned";
      if (/idle|ready|home|none|standby|wait|rest/.test(s)) return "idle";
      return "unknown";
    }
    // 2) 可领取标志位
    var flag = deepFind(parsed, ["can_claim", "claimable", "can_claim_reward", "can_receive"]);
    if (flag === true || flag === "true" || flag === 1) return "returned";
    // 3) 字符串特征兜底
    var t = String(raw || "").toLowerCase();
    if (t.indexOf("traveling") !== -1 || t.indexOf("in_trip") !== -1 || t.indexOf("\u65c5\u884c\u4e2d") !== -1) return "traveling";
    if (t.indexOf("\"can_claim\":true") !== -1 || t.indexOf("\"claimable\":true") !== -1 ||
        t.indexOf("canclaim\":true") !== -1 || t.indexOf("\u53ef\u9886\u53d6") !== -1) return "returned";
    if (t.indexOf("returned") !== -1 || t.indexOf("trip_finish") !== -1) return "returned";
    if (t.indexOf("idle") !== -1 || t.indexOf("\u6d3e\u9053") !== -1 || t.indexOf("\u6d3e\u51fa") !== -1) return "idle";
    return "unknown";
  }

  function parseLocations(parsed) {
    var arr = deepFindArray(parsed);
    if (!arr) return [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var it = arr[i];
      if (!it || typeof it !== "object") continue;
      var id = deepFind(it, ["location_id", "id", "loc_id", "location", "value", "key"]);
      var name = deepFind(it, ["name", "title", "label", "text", "desc"]);
      if (id !== undefined && id !== null) {
        out.push({
          id: id,
          name: (name === undefined || name === null || name === "") ? ("\u5730\u70b9" + (i + 1)) : String(name)
        });
      }
    }
    return out;
  }

  /* ---------------- 主流程 ---------------- */

  function notify(title, subtitle, body) {
    try { $notify(title, subtitle || "", body); } catch (e) {}
  }

  // 单域名执行：返回 true=域名可用(业务已处理)，false=域名不可用换下一个
  async function runDomain(base, token, locIdx, log) {
    var r, j, code, d;

    /* 1. Buddy加油站每日签到（幂等，重复调用不会多领） */
    r = await http("POST", base + CONF.epCheckin, token, {});
    if (r.status === 401 || r.status === 403) { log.authFail = true; return true; }
    if (r.status !== 200) return false;
    j = parseJson(r.data);
    code = j ? j.code : undefined;
    if (code === 0) {
      d = bizData(j);
      var got = (d && d.daily_credit !== undefined) ? d.daily_credit :
                (d && d.today_credit !== undefined ? d.today_credit : 100);
      log.actions.push("\u2705 Buddy\u52a0\u6cb9\u7ad9\u7b7e\u5230\u6210\u529f +" + got + " \u79ef\u5206");
      // 成功时顺带查一次状态，供通知展示连续天数/累计
      try {
        var s = await http("POST", base + CONF.epStatus, token, {});
        if (s.status === 200) {
          var sd = bizData(parseJson(s.data));
          if (sd) log.info = { streak: sd.streak_days, today: sd.today_credit, total: sd.total_credits, end: sd.end_time };
        }
      } catch (e) {}
    } else if (code === 10001) {
      log.actions.push("\u00b7 \u4eca\u65e5\u5df2\u7b7e\u5230\uff0c\u8df3\u8fc7");
    } else {
      log.actions.push("\u26a0\ufe0f \u7b7e\u5230\u63a5\u53e3\u8fd4\u56de\u5f02\u5e38 code=" + code + " msg=" + (j ? j.msg : "?"));
    }

    /* 2. 派猫猫旅行状态机 */
    r = await http("GET", base + CONF.epTravelStatus, token, null);
    if (r.status === 401 || r.status === 403) { log.authFail = true; return true; }
    if (r.status !== 200) return false;
    var tj = parseJson(r.data);
    var state = travelStateOf(tj, r.data);

    // traveling 与 can_claim 可能并存，以可领为准
    if (state === "traveling") {
      var cc = deepFind(tj, ["can_claim", "claimable", "can_claim_reward"]);
      if (cc === true || cc === "true" || cc === 1) state = "returned";
    }

    if (state === "returned") {
      var c = await http("POST", base + CONF.epTravelClaim, token, {});
      if (c.status === 401 || c.status === 403) { log.authFail = true; return true; }
      if (c.status === 200) {
        var cj = parseJson(c.data);
        if (cj && cj.code === 0) {
          var credit = deepFind(cj, ["credit", "credits", "reward", "reward_credit", "bonus", "point", "points", "gift_credit"]);
          log.actions.push("\ud83c\udf81 \u6d3e\u732b\u732b\u65c5\u884c\u5956\u52b1\u5df2\u9886\u53d6" +
            (credit !== undefined && credit !== null ? " (+" + credit + " \u79ef\u5206)" : ""));
        } else if (cj && cj.code === 10001) {
          log.actions.push("\u00b7 \u65c5\u884c\u5956\u52b1\u5df2\u9886\u8fc7\uff0c\u8df3\u8fc7");
        } else {
          log.actions.push("\u26a0\ufe0f \u9886\u53d6\u65c5\u884c\u5956\u52b1\u5931\u8d25 code=" + (cj ? cj.code : "?") + " msg=" + (cj ? cj.msg : "?"));
        }
      } else {
        log.actions.push("\u26a0\ufe0f \u9886\u53d6\u65c5\u884c\u5956\u52b1 HTTP " + c.status);
      }
    } else if (state === "idle") {
      // 先拿地点列表，取第 locIdx 个（默认第一个，通常是咖啡馆）
      var locId = locIdx, locName = "";
      try {
        var cfg = await http("GET", base + CONF.epTravelConfig, token, null);
        if (cfg.status === 200) {
          var locs = parseLocations(parseJson(cfg.data));
          if (locs.length) {
            var idx = Math.min(Math.max(locIdx, 0), locs.length - 1);
            locId = locs[idx].id;
            locName = locs[idx].name;
          }
        }
      } catch (e) {}
      var dep = await http("POST", base + CONF.epTravelDepart, token, { location_id: locId });
      if (dep.status === 401 || dep.status === 403) { log.authFail = true; return true; }
      if (dep.status === 200) {
        var dj = parseJson(dep.data);
        if (dj && dj.code === 0) {
          log.actions.push("\ud83d\ude80 \u5df2\u6d3e\u732b\u732b\u524d\u5f80\u300c" + (locName || ("#" + locId)) + "\u300d\uff0c1-4 \u5c0f\u65f6\u540e\u56de\u6765");
        } else if (dj && dj.code === 10001) {
          log.actions.push("\u00b7 \u4eca\u65e5\u5df2\u6d3e\u8fc7\u732b\u732b\uff0c\u8df3\u8fc7");
        } else {
          log.actions.push("\u26a0\ufe0f \u6d3e\u9053\u5931\u8d25 code=" + (dj ? dj.code : "?") + " msg=" + (dj ? dj.msg : "?"));
        }
      } else {
        log.actions.push("\u26a0\ufe0f \u6d3e\u9053 HTTP " + dep.status);
      }
    } else if (state === "traveling") {
      log.actions.push("\u00b7 \u732b\u732b\u65c5\u884c\u4e2d\uff0c\u7b49\u5f85\u56de\u6765");
    } else {
      log.actions.push("\u2753 \u6d3e\u732b\u732b\u72b6\u6001\u65e0\u6cd5\u8bc6\u522b\uff0c\u672c\u6b21\u4e0d\u64cd\u4f5c");
    }
    return true;
  }

  async function main() {
    var log = { actions: [], authFail: false, info: null };
    var token = String(argOf("token", "") || "").trim();
    if (!token) {
      try { token = String($prefs.valueForKey(CONF.prefToken) || "").trim(); } catch (e) {}
    }
    var notifyOn = argOf("notify", true);
    if (notifyOn === "false" || notifyOn === false) notifyOn = false;
    var locIdx = parseInt(argOf("location", "0"), 10);
    if (isNaN(locIdx) || locIdx < 0) locIdx = 0;

    if (!token) {
      notify("WorkBuddy \u81ea\u52a8\u7b7e\u5230", "\u672a\u83b7\u53d6\u5230\u767b\u5f55\u4ee4\u724c",
        "\u8bf7\u7528 iOS Safari \u6253\u5f00 www.codebuddy.cn \u5e76\u767b\u5f55\u4e00\u6b21\n\u63d2\u4ef6\u4f1a\u81ea\u52a8\u6355\u83b7\u4ee4\u724c\uff0c\u4e4b\u540e\u6bcf\u5929\u81ea\u52a8\u8fd0\u884c");
      $done();
      return;
    }

    var handled = false, lastErr = null;
    for (var i = 0; i < CONF.domains.length; i++) {
      try {
        handled = await runDomain("https://" + CONF.domains[i], token, locIdx, log);
        if (handled) break;
      } catch (e) { lastErr = e; }
    }

    if (!handled) {
      notify("WorkBuddy \u81ea\u52a8\u7b7e\u5230", "\u7f51\u7edc\u8bf7\u6c42\u5931\u8d25",
        "\u4e24\u4e2a\u57df\u540d\u5747\u65e0\u6cd5\u8fde\u901a\uff0c\u8bf7\u68c0\u67e5 Loon \u7f51\u7edc/\u4ee3\u7406\u72b6\u6001" +
        (lastErr ? "\n" + (lastErr.message || lastErr) : ""));
      $done();
      return;
    }
    if (log.authFail) {
      notify("WorkBuddy \u81ea\u52a8\u7b7e\u5230", "\u767b\u5f55\u4ee4\u724c\u5df2\u5931\u6548 (401)",
        "\u8bf7\u91cd\u65b0\u6253\u5f00 iOS \u4e0a\u7684 WorkBuddy App\n\u6216\u7528 Safari \u767b\u5f55\u4e00\u6b21 www.codebuddy.cn\n\u5237\u65b0\u540e\u81ea\u52a8\u6062\u590d");
      $done();
      return;
    }

    // 只在"有实际动作 / 异常"时通知，纯跳过保持静默
    var meaningful = log.actions.filter(function (a) {
      return a.indexOf("\u2705") === 0 || a.indexOf("\ud83d\ude80") === 0 || a.indexOf("\ud83c\udf81") === 0 ||
             a.indexOf("\u26a0\ufe0f") === 0 || a.indexOf("\u2753") === 0;
    });
    if (notifyOn && meaningful.length) {
      var body = meaningful.join("\n");
      if (log.info) {
        var ci = log.info;
        body += "\n————\n\u8fde\u7eed " + (ci.streak === undefined ? "?" : ci.streak) + " \u5929" +
                " \uff5c \u4eca\u65e5 " + (ci.today === undefined ? "?" : ci.today) + " \u5206" +
                " \uff5c \u672c\u5b63\u7d2f\u8ba1 " + (ci.total === undefined ? "?" : ci.total) + " \u5206";
        if (ci.end) body += "\n\u672c\u671f\u6d3b\u52a8\u81f3 " + String(ci.end).slice(0, 10);
      }
      notify("WorkBuddy \u81ea\u52a8\u7b7e\u5230", "", body);
    }
    $done();
  }

  /* ---------------- 入口分发 ---------------- */

  function capture() {
    try {
      var h = ($request && $request.headers) || {};
      var auth = h["Authorization"] || h["authorization"] || h["AUTHORIZATION"];
      if (auth && /^Bearer\s+\S{10,}/.test(auth)) {
        var old = "";
        try { old = String($prefs.valueForKey(CONF.prefToken) || ""); } catch (e) {}
        if (auth !== old) {
          $prefs.setValueForKey(auth, CONF.prefToken);
          $prefs.setValueForKey(String(Date.now()), CONF.prefTokenAt);
        }
      }
    } catch (e) {}
    $done({});
  }

  var hasReq = false;
  try { hasReq = (typeof $request !== "undefined") && !!$request && !!$request.url; } catch (e) {}

  if (hasReq) {
    capture();
  } else {
    main().catch(function (e) {
      notify("WorkBuddy \u81ea\u52a8\u7b7e\u5230", "\u811a\u672c\u6267\u884c\u5f02\u5e38", String((e && e.message) || e));
      $done();
    });
  }
})();
