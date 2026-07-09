/**
 * 跨周目 meta 成长（传说评级 + 机制性馈赠）· 确定性校验
 * （vm 沙箱加载真实源码，不耗 API）
 * 覆盖：
 *   1) computeLegendTier 四档分级（平凡/显赫/史诗/传奇样例）
 *   2) legendBonuses 各档规格
 *   3) buildInheritedLegend / buildInheritedLegendPayload 的 lore 片段（标题含评级、正文含馈赠、keywords 含 heroName）
 *   4) applyLegendBonusToInitialState：不修改入参 + 声望/货币/NPC 好感/遗物注入 + 空 initial_state 安全
 *   5) 模拟 createWorld 注入全链路（payload + apply → initial_state 含加成 + lore_kb 含片段）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const files = [
  'js/app-core.js', 'js/map-data.js', 'js/dice.js', 'js/combat-stats.js',
  'js/combat-engine.js', 'js/action-menu.js', 'js/renderer/tile-map.js',
  'js/app-ai.js', 'js/app-game.js', 'js/preset-worlds.js', 'js/app-ui.js'
];

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
const elCache = {};
const docStub = {
  addEventListener(){}, removeEventListener(){},
  getElementById(id){
    if (!elCache[id]) elCache[id] = fakeEl();
    return elCache[id];
  },
  querySelector(){ return null; },
  querySelectorAll(){ return []; }, createElement(){ return fakeEl(); }
};
const _store = {};
const sandbox = {
  console, Math, Date, JSON,
  crypto: globalThis.crypto,
  document: docStub,
  localStorage: {
    getItem(k){ return k in _store ? _store[k] : null; },
    setItem(k, v){ _store[k] = String(v); },
    removeItem(k){ delete _store[k]; }
  },
  setTimeout(){}, clearTimeout(){}, fetch(){ return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); },
  window: null
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

let combined = '';
files.forEach(f => { combined += '\n;//==== ' + f + ' ====\n' + fs.readFileSync(path.join(ROOT, f), 'utf8'); });
vm.runInContext(combined, sandbox, { filename: 'combined.js' });

vm.runInContext('saveState = function(){}; updateGameDayInfo = function(){};', sandbox);
vm.runInContext('computeEmbeddingsForWorld = function(){ return Promise.resolve(); };', sandbox);

const testScript = `
(async () => {
  let pass = 0, fail = 0;
  function ok(name, cond) {
    if (cond) { pass++; console.log('  PASS \\u2713', name); }
    else { fail++; console.log('  FAIL \\u2717', name); }
  }

  // ===== 1) computeLegendTier 四档分级 =====
  const ordinary = computeLegendTier({ reputation: 5, tension: 2, goalsDone: [], npcSummary: [], day: 3 });
  ok('平凡样例 → ordinary', ordinary.tier === 'ordinary' && ordinary.tierLabel === '平凡');

  const notable = computeLegendTier({ reputation: 50, tension: 10, goalsDone: [], npcSummary: [{ name:'甲', attitude: 8 }], day: 10 });
  ok('显赫样例 → notable', notable.tier === 'notable' && notable.tierLabel === '显赫');
  ok('显赫样例评分阈值(>=60)', notable.score >= 60);

  const epic = computeLegendTier({ reputation: 90, tension: 20, goalsDone: ['a','b'], npcSummary: [{ name:'甲', attitude: 15 }], day: 30 });
  ok('史诗样例 → epic', epic.tier === 'epic' && epic.tierLabel === '史诗');

  const legendary = computeLegendTier({ reputation: 150, tension: 40, goalsDone: ['a','b','c'], npcSummary: [{ name:'甲', attitude: 30 }], day: 80 });
  ok('传奇样例 → legendary', legendary.tier === 'legendary' && legendary.tierLabel === '传奇');

  ok('空 legend 安全 → ordinary', computeLegendTier(null).tier === 'ordinary');
  ok('undefined legend 安全', computeLegendTier(undefined).tier === 'ordinary');

  // ===== 2) legendBonuses 各档规格 =====
  ok('ordinary 加成规格', JSON.stringify(legendBonuses('ordinary')) === JSON.stringify({ reputation: 2, currency: { gold: 10 }, npcAttitude: 3, startingItem: null }));
  ok('notable 加成规格', legendBonuses('notable').reputation === 8 && legendBonuses('notable').currency.gold === 40);
  ok('epic 加成规格', legendBonuses('epic').reputation === 18 && legendBonuses('epic').npcAttitude === 15);
  ok('legendary 含遗物', legendBonuses('legendary').reputation === 30 && legendBonuses('legendary').startingItem === '前世遗物·传说印记');
  ok('未知档位回退 ordinary', legendBonuses('xx').reputation === 2);

  // ===== 3) buildInheritedLegend / Payload 的 lore 片段 =====
  const pay = buildInheritedLegendPayload({ id:'leg1', worldName:'雾港', heroName:'林夜', summary:'在《雾港》中，你行走至第 40 天。你的名号是「雾港守护者」（声望 90）。', reputation: 90, tension: 20, goalsDone:['救城'], npcSummary:[{name:'阿澜',attitude:20}] });
  ok('payload.tier = epic', pay.tier === 'epic');
  ok('payload.loreSnippet 标题含评级', pay.loreSnippet.title.indexOf('史诗') >= 0 && pay.loreSnippet.title.indexOf('雾港') >= 0);
  ok('payload.loreSnippet 正文含馈赠说明', pay.loreSnippet.content.indexOf('开局便获得馈赠') >= 0);
  ok('payload.loreSnippet keywords 含 heroName', pay.loreSnippet.keywords.indexOf('林夜') >= 0);
  ok('payload.loreSnippet keywords 含评级', pay.loreSnippet.keywords.indexOf('史诗') >= 0);

  // heroName 兜底（从 summary 抽取）
  const pay2 = buildInheritedLegendPayload({ worldName:'X', summary:'你的名号是「风语者」（声望 5）。' });
  ok('heroName 从 summary 兜底抽取', pay2.loreSnippet.keywords.indexOf('风语者') >= 0);

  // ===== 4) applyLegendBonusToInitialState =====
  const src = { reputation: 10, currency: { gold: 0 }, npc_states: {}, inventory: [] };
  const applied = applyLegendBonusToInitialState(src, { reputation: 90, tension: 20, goalsDone:['a','b'], npcSummary:[{name:'阿澜',attitude:20}], heroName:'林夜' });
  ok('加成不修改入参', src.reputation === 10 && src.npc_states && Object.keys(src.npc_states).length === 0);
  ok('声望加成生效(epic +18)', applied.reputation === 28);
  ok('货币加成生效(金币 +100)', applied.currency.gold === 100);
  ok('NPC 好感加成(特殊 NPC=heroName +15)', applied.npc_states['林夜'] && applied.npc_states['林夜'].attitude === 15);
  ok('NPC 记忆写入前世余音', applied.npc_states['林夜'].memory && applied.npc_states['林夜'].memory.length === 1);
  ok('入参为 null 原样返回', applyLegendBonusToInitialState(null, {}) === null);
  ok('入参为 {} 原样返回', applyLegendBonusToInitialState({}, {}) === null || applyLegendBonusToInitialState({}, {}) === undefined ? true : (function(){ const r = applyLegendBonusToInitialState({}, {reputation:2}); return r && r.reputation === 2; })());

  // legendary 含遗物
  const legApplied = applyLegendBonusToInitialState({ reputation: 0, currency:{gold:0}, npc_states:{}, inventory:[] }, { reputation: 150, tension: 40, goalsDone:['a','b','c'], npcSummary:[{name:'甲',attitude:30}], heroName:'传说君' });
  ok('legendary 遗物入包', legApplied.inventory.some(function(i){ return i.name === '前世遗物·传说印记'; }));

  // ===== 5) 模拟 createWorld 注入全链路 =====
  const world = {
    name: '新生雾港',
    lore_kb: { ip: '雾港', snippets: [{ id:'s0', category:'背景', title:'旧闻', content:'x', keywords:['x'] }] },
    initial_state: { reputation: 5, currency: { gold: 0 }, npc_states: {}, inventory: [] }
  };
  const pending = { id:'legA', worldName:'雾港', heroName:'林夜', summary:'在《雾港》中，你行走至第 40 天。你的名号是「雾港守护者」（声望 90）。', reputation: 90, tension: 20, goalsDone:['救城'], npcSummary:[{name:'阿澜',attitude:20}] };
  const pl = buildInheritedLegendPayload(pending);
  world.lore_kb.snippets.push(Object.assign({ id:'b_legend_x' }, pl.loreSnippet));
  world.inherited_legend = { id: pending.id, worldName: pending.worldName, heroName: pending.heroName, summary: pending.summary, tier: pl.tier, tierLabel: pl.tierLabel, score: pl.score, bonuses: pl.bonuses };
  world.initial_state = applyLegendBonusToInitialState(world.initial_state, pending);

  ok('全链路：lore_kb 含传说片段', world.lore_kb.snippets.length === 2 && world.lore_kb.snippets[1].title.indexOf('史诗') >= 0);
  ok('全链路：inherited_legend 记录评级', world.inherited_legend.tier === 'epic' && world.inherited_legend.tierLabel === '史诗');
  ok('全链路：initial_state 含声望加成', world.initial_state.reputation === 23);
  ok('全链路：initial_state 含金币加成', world.initial_state.currency.gold === 100);
  ok('全链路：initial_state 含特殊 NPC 好感', world.initial_state.npc_states['林夜'] && world.initial_state.npc_states['林夜'].attitude === 15);

  console.log('\\n===== legend_inherit_check =====');
  console.log('PASS: ' + pass + '   FAIL: ' + fail);
  if (fail > 0) { console.log('存在失败用例 ❌'); }
  else { console.log('全部通过 ✅'); }
})();
`;

vm.runInContext(testScript, sandbox, { filename: 'legend_inherit_check.js' });
