/**
 * H) 基调显式持久化 · 确定性校验（vm 沙箱加载真实源码，不耗 API）
 * 覆盖：
 *   1) normalizeTone 对象 / 字符串 / 无效输入 的规范化
 *   2) resolveToneGuide 优先采纳持久化 world.tone，否则降级为文本推断（旧世界兼容）
 *   3) mockGenerateWorld 各分支均返回合法 tone
 *   4) applyStateChanges({tone}) 切换基调 → 更新 currentWorld.tone + 持久化到 worlds 存档 + 刷新 system prompt 缓存
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const files = [
  'js/app-core.js', 'js/map-data.js', 'js/dice.js', 'js/combat-stats.js',
  'js/combat-engine.js', 'js/action-menu.js', 'js/renderer/tile-map.js',
  'js/app-game.js', 'js/app-ai.js', 'js/preset-worlds.js', 'js/app-ui.js'
];

const _store = {};
const localStorageStub = {
  getItem(k) { return k in _store ? _store[k] : null; },
  setItem(k, v) { _store[k] = String(v); },
  removeItem(k) { delete _store[k]; }
};
function fakeEl() {
  return {
    innerHTML: '', value: '', checked: false, textContent: '',
    style: {}, classList: { add(){}, remove(){}, contains(){ return false; } },
    setAttribute(){}, removeAttribute(){}, getAttribute(){ return null; },
    addEventListener(){}, appendChild(){}, removeChild(){},
    querySelector(){ return null; }, querySelectorAll(){ return []; },
    focus(){}, blur(){}, click(){}
  };
}
const docStub = {
  addEventListener(){}, removeEventListener(){},
  getElementById(id){ return fakeEl(); },
  querySelector(){ return null; }, querySelectorAll(){ return []; }, createElement(){ return fakeEl(); }
};
const sandbox = {
  console, Math, Date, JSON,
  crypto: globalThis.crypto,
  document: docStub,
  localStorage: localStorageStub,
  setTimeout(){}, clearTimeout(){}, fetch(){ return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); },
  window: null
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

let combined = '';
files.forEach(f => { combined += '\n;//==== ' + f + ' ====\n' + fs.readFileSync(path.join(ROOT, f), 'utf8'); });
vm.runInContext(combined, sandbox, { filename: 'combined.js' });

// 中性化有副作用 / 外部依赖的函数
vm.runInContext('saveState = function(){}; updateGameDayInfo = function(){}; addBehaviorRecords = function(){};', sandbox);
vm.runInContext('syncMapPlayerFromNarrative = function(){}; syncNpcEntitiesOnMap = function(){}; addMapEnemiesForCombat = function(){};', sandbox);
// 暴露被测函数（确保成为 sandbox 属性，便于直接调用）
vm.runInContext('Object.assign(this, { normalizeTone, inferToneFromWorld, resolveToneGuide, buildToneGuideString, applyStateChanges, mockGenerateWorld, saveWorlds, loadWorlds });', sandbox);

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  PASS ✓', name); }
  else { fail++; console.log('  FAIL ✗', name); }
}

try {
  // 1) normalizeTone 规范化
  const t1 = sandbox.normalizeTone({ primary: "高张力", labels: ["高张力", "悬疑"], description: "危机降临" });
  ok('normalizeTone 对象 → 规范结构', t1 && t1.primary === "高张力" && Array.isArray(t1.labels) && t1.labels.length === 2 && t1.description === "危机降临");
  const t2 = sandbox.normalizeTone("悬疑");
  ok('normalizeTone 字符串 → 单标签', t2 && t2.primary === "悬疑" && t2.labels.length === 1 && t2.description === "");
  ok('normalizeTone 无效 → null', sandbox.normalizeTone(null) === null && sandbox.normalizeTone({ foo: 1 }) === null);

  // 2) resolveToneGuide 优先采纳显式 tone，否则文本推断
  const wExplicit = { tone: { primary: "高张力", labels: ["高张力"], description: "末日废土" } };
  const g1 = sandbox.resolveToneGuide(wExplicit);
  ok('resolveToneGuide 采纳显式 tone（含描述）', /高张力/.test(g1) && /末日废土/.test(g1));
  const wInfer = { desc: "一场充满战斗与阴谋的末日战争，幸存者在废墟中求生", hero: "", opening_narrative: "" };
  ok('resolveToneGuide 无 tone → 文本推断「高张力」', /高张力/.test(sandbox.resolveToneGuide(wInfer)));
  const wDaily = { desc: "温馨的校园日常与甜甜的恋爱生活", hero: "", opening_narrative: "" };
  ok('resolveToneGuide 文本推断「日常」', /日常/.test(sandbox.resolveToneGuide(wDaily)));

  // 3) mockGenerateWorld 各分支返回合法 tone
  const mg1 = sandbox.mockGenerateWorld("霍格沃茨魔法学院", "original", "一所教授魔法的学校", "", "");
  ok('mockGenerateWorld 魔法校园 → tone', !!(mg1 && mg1.tone && mg1.tone.primary && mg1.tone.primary.length > 0));
  const mg2 = sandbox.mockGenerateWorld("青云山修仙界", "original", "修仙门派林立，正邪相争", "", "");
  ok('mockGenerateWorld 修仙 → tone', !!(mg2 && mg2.tone && mg2.tone.primary && mg2.tone.primary.length > 0));
  const mg3 = sandbox.mockGenerateWorld("未知的旅途", "original", "一段平凡的探险", "", "");
  ok('mockGenerateWorld 默认 → tone', !!(mg3 && mg3.tone && mg3.tone.primary && mg3.tone.primary.length > 0));

  // 4) applyStateChanges({tone}) 切换基调 → 更新 + 持久化 + 刷新缓存
  vm.runInContext(`
    worlds = [{ id:'w_h', name:'末日废土', desc:'充满战斗与阴谋的末日废土', hero:'', opening_narrative:'', tone:{ primary:'日常', labels:['日常'], description:'' } }];
    currentWorld = worlds[0];
    gameState = { current_location:'起点', current_date:{day:1,period:'morning'}, npc_states:{}, currency:{}, factions:{}, inventory:[], combat_stats:{in_combat:false} };
    cachedSystemPrompt = 'CACHED';
    cachedSysPromptWorldId = 'w_h';
  `, sandbox);

  sandbox.applyStateChanges({ tone: { primary: "高张力", labels: ["高张力"], reason: "末日危机爆发" } });

  ok('applyStateChanges 切基调 → 更新 currentWorld.tone', vm.runInContext('currentWorld.tone.primary', sandbox) === "高张力");
  ok('applyStateChanges 切基调 → resolveToneGuide 反映新基调', vm.runInContext('/高张力/.test(resolveToneGuide(currentWorld))', sandbox));
  ok('applyStateChanges 切基调 → 刷新 system prompt 缓存', vm.runInContext('cachedSystemPrompt', sandbox) === null);
  const stored = vm.runInContext('localStorage.getItem(STORAGE_KEYS.worlds)', sandbox);
  const parsed = JSON.parse(stored || "[]");
  ok('applyStateChanges 切基调 → 持久化到 worlds 存档', !!(parsed[0] && parsed[0].tone && parsed[0].tone.primary === "高张力"));

  // 空变更不应破坏（tone 块跳过）
  ok('applyStateChanges 空变更不报错', (function () { try { sandbox.applyStateChanges({}); return true; } catch (e) { console.log("    err:", e.message); return false; } })());

} catch (e) {
  fail++;
  console.log('  FAIL ✗ 测试执行异常:', e.message);
}

console.log(`\n[H 基调显式持久化] 通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
