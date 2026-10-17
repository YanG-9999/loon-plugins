/* Loon 插件脚本测试 harness：mock Loon 运行时，跑 7 个场景 */
const fs = require("fs");
const path = require("path");

const SCRIPT = fs.readFileSync(path.join(__dirname, "workbuddy-checkin.js"), "utf8");

let doneResolve;
const results = { notifies: [], prefs: {}, doneArg: null };

function installRuntime(scenario) {
  // 重置(注意: prefs 跨场景保持, 模拟 Loon 真实持久化行为)
  results.notifies = [];
  results.doneArg = null;
  results.requests = [];
  if (scenario.clearToken) results.prefs["wb_bearer_token"] = null;
  if (scenario.reseedToken) results.prefs["wb_bearer_token"] = "Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6.IiLCJ0eXAiOiJKV1QifQ.abcdefg";

  global.$prefs = {
    valueForKey: (k) => (k in results.prefs ? results.prefs[k] : null),
    setValueForKey: (v, k) => { results.prefs[k] = v; },
    removeValueForKey: (k) => { delete results.prefs[k]; }
  };
  global.$notify = (t, s, b) => { results.notifies.push({ title: t, sub: s, body: b }); };
  global.$done = (v) => { results.doneArg = v === undefined ? null : v; if (doneResolve) { doneResolve(); doneResolve = null; } };

  // 按场景编排 mock 响应: [{ match, method, resp }]
  const scripted = scenario.responses || [];
  let callCount = 0;
  global.$httpClient = {
    get(opts, cb) { handle("GET", opts, cb); },
    post(opts, cb) { handle("POST", opts, cb); }
  };
  function handle(method, opts, cb) {
    results.requests.push(method + " " + opts.url);
    callCount++;
    const hit = scripted.shift();
    if (!hit) return cb(null, { status: 200, headers: {} }, JSON.stringify({ code: 0, msg: "OK", data: { data: {} } }));
    if (hit.netErr) return cb(new Error(hit.netErr), null, null);
    setTimeout(() => cb(null, { status: hit.status, headers: {} }, typeof hit.body === "string" ? hit.body : JSON.stringify(hit.body)), 1);
  }

  if (scenario.request) global.$request = scenario.request;
  else delete global.$request;
  if (scenario.argument) global.$argument = scenario.argument;
  else delete global.$argument;
  if (scenario.scriptType) global.$script = { type: scenario.scriptType };
  else delete global.$script;
}

function runScenario(name, scenario) {
  return new Promise((resolve) => {
    installRuntime(scenario);
    doneResolve = resolve;
    const timer = setTimeout(() => { resolve({ timeout: true }); }, 5000);
    const origResolve = resolve;
    // 包一层：$done 时清 timer
    const realDone = global.$done;
    global.$done = (v) => { clearTimeout(timer); realDone(v); };
    eval(SCRIPT);
    // eval 是同步执行 IIFE；main() 异步，等 $done 或超时
  }).then((r) => {
    const summary = {
      scenario: name,
      timeout: !!(r && r.timeout),
      notifies: results.notifies,
      requests: results.requests,
      tokenStored: results.prefs["wb_bearer_token"] ? "YES(" + results.prefs["wb_bearer_token"].slice(0, 18) + "...)" : "NO"
    };
    console.log("\n=== " + name + " ===");
    console.log(JSON.stringify(summary, null, 1));
    return summary;
  });
}

const J = (code, data) => JSON.stringify({ code, msg: code === 0 ? "OK" : "err", requestId: "x", data });

(async () => {
  // 1. http-request 捕获令牌
  await runScenario("S1 捕获令牌", {
    request: {
      url: "https://www.codebuddy.cn/v2/billing/meter/checkin-activity-status",
      method: "POST",
      headers: { Authorization: "Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6.IiLCJ0eXAiOiJKV1QifQ.abcdefg", "Content-Type": "application/json" }
    },
    responses: []
  });

  // 2. cron 全流程: 签到成功 + 派猫 idle → depart
  await runScenario("S2 签到成功+派猫", {
    argument: { token: "", location: "0", notify: true },
    responses: [
      { status: 200, body: J(0, { data: { daily_credit: 100, today_checked_in: true } }) },
      { status: 200, body: J(0, { data: { streak_days: 4, today_credit: 100, total_credits: 400, end_time: "2026-10-15 23:59:59" } }) },
      { status: 200, body: J(0, { data: { state: "idle" } }) },
      { status: 200, body: J(0, { data: { locations: [{ location_id: 11, name: "咖啡馆" }, { location_id: 12, name: "古镇客栈" }] } }) },
      { status: 200, body: J(0, { data: { duration: 14400 } }) }
    ]
  });

  // 3. cron: 已签 + traveling → 静默无通知
  await runScenario("S3 已签+旅行中(应静默)", {
    argument: { token: "", location: "0", notify: true },
    responses: [
      { status: 200, body: J(10001, null) },
      { status: 200, body: J(0, { data: { state: "traveling", location: "咖啡馆", countdown: 7200 } }) }
    ]
  });

  // 4. cron: 旅行回来 → claim 领积分
  await runScenario("S4 领取旅行奖励", {
    argument: { token: "", location: "0", notify: true },
    responses: [
      { status: 200, body: J(10001, null) },
      { status: 200, body: J(0, { data: { state: "returned", reward: 8 } }) },
      { status: 200, body: J(0, { data: { credit: 8, gift: "盲盒" } }) }
    ]
  });

  // 5. cron: 401 令牌失效
  await runScenario("S5 令牌失效401", {
    argument: { token: "", location: "0", notify: true },
    responses: [
      { status: 401, body: "401 Authorization Required" }
    ]
  });

  // 6. cron: 无令牌(清掉已捕获的)
  await runScenario("S6 无令牌", {
    argument: { token: "", location: "0", notify: true },
    clearToken: true,
    responses: []
  });

  // 6b. cron: 今日已派过猫猫(10001)
  await runScenario("S6b 已派过跳过", {
    argument: { token: "", location: "0", notify: true },
    reseedToken: true,
    responses: [
      { status: 200, body: J(10001, null) },
      { status: 200, body: J(0, { data: { state: "idle" } }) },
      { status: 200, body: J(0, { data: { locations: [{ location_id: 11, name: "咖啡馆" }] } }) },
      { status: 200, body: J(10001, null) }
    ]
  });

  // 7. cron: 第一域名网络错误 → 切换第二域名
  await runScenario("S7 域名切换", {
    argument: { token: "", location: "0", notify: true },
    responses: [
      { netErr: "timeout" },
      { status: 200, body: J(0, { data: { daily_credit: 100 } }) },
      { status: 200, body: J(0, { data: { state: "traveling" } }) }
    ]
  });

  // 8. notify=false 时不通知
  await runScenario("S8 关闭通知", {
    argument: { token: "", location: "0", notify: false },
    responses: [
      { status: 200, body: J(0, { data: { daily_credit: 100 } }) },
      { status: 200, body: J(0, { data: { state: "idle" } }) },
      { status: 200, body: J(0, { data: { locations: [{ location_id: 11, name: "咖啡馆" }] } }) },
      { status: 200, body: J(0, { data: {} }) }
    ]
  });

  // 9. generic 手动运行入口: 与 cron 同参数, 验证分发正确
  await runScenario("S9 generic手动运行", {
    scriptType: "generic",
    argument: { token: "", location: "0", notify: true },
    responses: [
      { status: 200, body: J(0, { data: { daily_credit: 100 } }) },
      { status: 200, body: J(0, { data: { streak_days: 5, today_credit: 100, total_credits: 500, end_time: "2026-10-15 23:59:59" } }) },
      { status: 200, body: J(0, { data: { state: "idle" } }) },
      { status: 200, body: J(0, { data: { locations: [{ location_id: 11, name: "咖啡馆" }] } }) },
      { status: 200, body: J(0, { data: { duration: 14400 } }) }
    ]
  });
  console.log("\n全部场景执行完毕");
})();
