/**
 * C) 阵营任务 / 商店 NPC（固定货架/定价）· 确定性校验（vm 沙箱加载真实源码，不耗 API）
 * 覆盖：
 *   1) 纯函数 buyFromShop / sellToShop（价格/库存/货币校验/入包/回补）
 *   2) 纯函数 acceptQuest / turnInQuest / getQuestsForFaction / grantQuestReward
 *   3) applyStateChanges 的 shops / quest_board / quests AI 合并
 *   4) loadWorlds 迁移 + seedDefaultShops 注入
 *   5) 空 world / 空背包 等边界安全
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
    querySelector(){ return fakeEl(); }, querySelectorAll(){ return []; },
    focus(){}, blur(){}, click(){}
  };
}
const elCache = {};
const docStub = {
  addEventListener(){}, removeEventListener(){},
  getElementById(id){ if (!elCache[id]) elCache[id] = fakeEl(); return elCache[id]; },
  querySelector(){ return fakeEl(); },
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

// 中性化外部副作用 + 打桩 embedding 重算（避免真实耗 API）
vm.runInContext('saveState = function(){}; updateGameDayInfo = function(){};', sandbox);
vm.runInContext('computeEmbeddingsForWorld = function(){ return Promise.resolve(); };', sandbox);
vm.runInContext('showToast = function(){};', sandbox);

const testScript = `
(async () => {
  let pass = 0, fail = 0;
  function ok(name, cond) {
    if (cond) { pass++; console.log('  PASS \\u2713', name); }
    else { fail++; console.log('  FAIL \\u2717', name); }
  }

  function freshWorld() {
    return {
      id: 'w_test', name: '测试世界', preset: false, type: 'ip',
      shops: [{
        id: 'shop_1', name: '杂货铺', owner: '老掌柜', location: '集市', currency: 'gold',
        stock: [
          { item_id: 'potion', name: '治疗药水', price: 20, count: 5, type: 'consumable' },
          { item_id: 'bread', name: '干粮', price: 3, count: 20, type: 'consumable' }
        ]
      }],
      quest_board: [{
        id: 'q1', faction: '蜀汉', title: '护送粮草', desc: '送粮草',
        requirements: { deliver: [{ item_id: 'grain', count: 2, name: '粮草' }] },
        reward: { currency: { gold: 50 }, items: [{ item_id: 'sword', name: '铁剑', count: 1, type: 'weapon', equippable: true, slot: 'weapon', damage_bonus: 2 }], reputation: { '蜀汉': 10 } },
        status: 'open'
      }]
    };
  }
  function freshGS(over) {
    const gs = { inventory: [], currency: { gold: 100 }, factions: {}, active_quests: [] };
    return Object.assign(gs, over || {});
  }

  // ===== 1) buyFromShop =====
  let w = freshWorld(); let gs = freshGS();
  const r1 = buyFromShop(gs, w, 'shop_1', 'potion', 2);
  ok('buyFromShop 成功', r1.ok === true);
  ok('buyFromShop 扣货币', gs.currency.gold === 60);
  ok('buyFromShop 减库存', w.shops[0].stock.find(i=>i.item_id==='potion').count === 3);
  ok('buyFromShop 入背包', gs.inventory.find(i=>i.item_id==='potion').count === 2);

  const r2 = buyFromShop(gs, w, 'shop_1', 'potion', 99);
  ok('buyFromShop 库存不足拦截', r2.ok === false && w.shops[0].stock.find(i=>i.item_id==='potion').count === 3);

  const poor = freshGS({ currency: { gold: 5 } });
  const r3 = buyFromShop(poor, freshWorld(), 'shop_1', 'potion', 1);
  ok('buyFromShop 货币不足拦截', r3.ok === false);

  const r4 = buyFromShop(gs, w, 'nope', 'potion', 1);
  ok('buyFromShop 店铺不存在', r4.ok === false);

  // 阵营折扣：声望≥20 → 9 折
  let wd = freshWorld(); wd.shops[0].faction = '蜀汉';
  let gsd = freshGS({ factions: { '蜀汉': { reputation: 20, stance: '友善' } } });
  const pDisc = shopItemPrice(wd.shops[0], 'potion', gsd);
  ok('shopItemPrice 阵营折扣(9折)', pDisc === 18);
  const pNorm = shopItemPrice(wd.shops[0], 'potion', freshGS());
  ok('shopItemPrice 无折扣(原价)', pNorm === 20);

  // ===== 2) sellToShop =====
  let ws = freshWorld(); let gss = freshGS({ inventory: [{ item_id: 'potion', name: '治疗药水', count: 3, type: 'consumable' }] });
  const s1 = sellToShop(gss, ws, 'shop_1', 'potion', 1);
  ok('sellToShop 成功', s1.ok === true);
  ok('sellToShop 回购价=半价(10)', s1.gained === 10);
  ok('sellToShop 加货币', gss.currency.gold === 110);
  ok('sellToShop 出背包', gss.inventory.find(i=>i.item_id==='potion').count === 2);
  ok('sellToShop 回补库存', ws.shops[0].stock.find(i=>i.item_id==='potion').count === 6);
  const s2 = sellToShop(gss, ws, 'shop_1', 'missing', 1);
  ok('sellToShop 不收购拦截', s2.ok === false);

  // ===== 3) 阵营任务 =====
  let wq = freshWorld(); let gq = freshGS();
  const qf = getQuestsForFaction(wq, '蜀汉');
  ok('getQuestsForFaction 过滤开放任务', qf.length === 1 && qf[0].id === 'q1');
  const a1 = acceptQuest(gq, wq, 'q1');
  ok('acceptQuest 成功', a1.ok === true);
  ok('acceptQuest 写入 active_quests', gq.active_quests.length === 1);
  ok('acceptQuest 世界板状态→accepted', wq.quest_board[0].status === 'accepted');
  const a2 = acceptQuest(gq, wq, 'q1');
  ok('acceptQuest 重复接取拦截', a2.ok === false);
  const a3 = acceptQuest(gq, wq, 'nope');
  ok('acceptQuest 不存在拦截', a3.ok === false);

  // 交付物不足 → 拦截
  const t0 = turnInQuest(gq, wq, 'q1');
  ok('turnInQuest 交付物不足拦截', t0.ok === false);
  // 给齐交付物再交付
  gq.inventory.push({ item_id: 'grain', name: '粮草', count: 2, type: 'material' });
  const t1 = turnInQuest(gq, wq, 'q1');
  ok('turnInQuest 成功', t1.ok === true);
  ok('turnInQuest 发金币奖励', gq.currency.gold === 50 + 100);
  ok('turnInQuest 发物品奖励(铁剑)', gq.inventory.find(i=>i.item_id==='sword') !== undefined);
  ok('turnInQuest 加阵营声望', (gq.factions['蜀汉']||{}).reputation === 10);
  ok('turnInQuest 任务置 completed', gq.active_quests[0].status === 'completed' && wq.quest_board[0].status === 'completed');
  const t2 = turnInQuest(gq, wq, 'q1');
  ok('turnInQuest 已完成不可重复交付', t2.ok === false);

  // grantQuestReward 独立校验
  let gr = freshGS();
  const ap = grantQuestReward(gr, { currency: { gold: 10, silver: 5 }, items: [{ item_id: 'x', name: 'X', count: 2 }], reputation: { '曹魏': 8 } });
  ok('grantQuestReward 货币', gr.currency.gold === 110 && gr.currency.silver === 5);
  ok('grantQuestReward 物品', gr.inventory.find(i=>i.item_id==='x').count === 2);
  ok('grantQuestReward 声望', (gr.factions['曹魏']||{}).reputation === 8);
  ok('grantQuestReward 返回摘要', ap.items[0].indexOf('X') >= 0);

  // ===== 4) applyStateChanges · shops / quest_board / quests =====
  worlds = [];
  currentWorld = freshWorld();
  gameState = freshGS();
  applyStateChanges({ shops: [{ id: 'shop_2', name: '兵器铺', owner: '铁匠', currency: 'gold', stock: [{ item_id: 'spear', name: '长枪', price: 30, count: 2, type: 'weapon' }] }] });
  ok('applyStateChanges 合并新店铺', currentWorld.shops.length === 2 && currentWorld.shops[1].id === 'shop_2');
  // 补货既有店铺
  applyStateChanges({ shops: [{ id: 'shop_1', stock: [{ item_id: 'potion', price: 25, count: 10 }] }] });
  ok('applyStateChanges 既有店补货/改价', currentWorld.shops[0].stock.find(i=>i.item_id==='potion').count === 10 && currentWorld.shops[0].stock.find(i=>i.item_id==='potion').price === 25);

  applyStateChanges({ quest_board: [{ id: 'q2', faction: '曹魏', title: '刺探', desc: 'd', reward: { currency: { gold: 20 } }, status: 'open' }] });
  ok('applyStateChanges 发布阵营任务', currentWorld.quest_board.length === 2 && currentWorld.quest_board[1].id === 'q2');

  applyStateChanges({ quests: { accept: 'q2' } });
  ok('applyStateChanges quests.accept 接取', gameState.active_quests.length === 1 && gameState.active_quests[0].id === 'q2');

  // ===== 5) loadWorlds 迁移 + seedDefaultShops =====
  worlds = buildPresetWorlds();
  // 清空 shops/quest_board 模拟旧世界，再 loadWorlds 应补齐
  worlds.forEach(function(x){ x.shops = []; x.quest_board = []; });
  // 直接调用迁移逻辑（loadWorlds 读 localStorage，这里用内存 worlds 模拟）
  worlds.forEach(function(x){ if (!Array.isArray(x.shops)) x.shops = []; if (!Array.isArray(x.quest_board)) x.quest_board = []; seedDefaultShops(x); });
  const seeded = worlds.every(function(x){ return x.shops.length >= 1 && x.quest_board.length >= 1; });
  ok('seedDefaultShops 给每个世界注入店铺+任务', seeded);
  const hasGeneral = worlds[0].shops.some(function(s){ return s.id.indexOf('shop_general_') === 0; });
  ok('seedDefaultShops 通用杂货铺 id 前缀正确', hasGeneral);
  const hasRunner = worlds[0].quest_board.some(function(q){ return q.id.indexOf('q_runner_') === 0; });
  ok('seedDefaultShops 通用跑腿任务 id 前缀正确', hasRunner);

  // ===== 6) 边界安全 =====
  ok('buyFromShop 空 world 安全', buyFromShop(freshGS(), null, 's', 'i', 1).ok === false);
  ok('sellToShop 空背包安全', sellToShop(freshGS(), freshWorld(), 'shop_1', 'potion', 1).ok === false);
  ok('acceptQuest 空任务板安全', acceptQuest(freshGS(), { id:'x' }, 'q').ok === false);
  ok('turnInQuest 空进行中安全', turnInQuest(freshGS(), freshWorld(), 'q1').ok === false);
  ok('getQuestsForFaction 空 world 返回 []', getQuestsForFaction(null, 'f').length === 0);
  ok('getShop 空 world 返回 null', getShop(null, 's') === null);

  console.log('\\n==== C 确定性测试：PASS=' + pass + ' FAIL=' + fail + ' ====');
  if (fail > 0) { console.log('存在失败用例'); }
  else { console.log('全部通过 \\u2705'); }
})();
`;

vm.runInContext(testScript, sandbox, { filename: 'c_test.js' });
