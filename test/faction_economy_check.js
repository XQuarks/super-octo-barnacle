/**
 * 第⑤项：势力声望/阵营 + 经济/合成/装备 确定性校验
 * 加载真实产品代码（vm 拼接 app-core+map-data+dice+combat-stats+combat-engine+action-menu+tile-map+app-game+app-ai）
 * 不耗 API、不依赖真实浏览器 DOM（document/localStorage 打桩）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = 'C:/Users/guoxiaoyan/WorkBuddy/C项目';
const files = [
  'js/app-core.js', 'js/map-data.js', 'js/dice.js', 'js/combat-stats.js',
  'js/combat-engine.js', 'js/action-menu.js', 'js/renderer/tile-map.js',
  'js/app-game.js', 'js/app-ai.js'
];

function fakeEl() {
  return {
    innerHTML: '', value: '', style: {}, textContent: '',
    classList: { add(){}, remove(){}, contains(){ return false; } },
    setAttribute(){}, removeAttribute(){}, getAttribute(){ return null; },
    addEventListener(){}, querySelector(){ return null; }, querySelectorAll(){ return []; }
  };
}
const mapContainerEl = fakeEl();
const docStub = {
  getElementById(id){ return id === 'mapContainer' ? mapContainerEl : fakeEl(); },
  querySelector(){ return null; }, querySelectorAll(){ return []; }, createElement(){ return fakeEl(); }
};
const sandbox = {
  console,
  document: docStub,
  localStorage: { getItem(){ return null; }, setItem(){}, removeItem(){} },
  setTimeout(){}, fetch(){}, Date,
  SANDBOX_GAMESTATE: null
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

let combined = '';
files.forEach(f => { combined += '\n;//==== ' + f + ' ====\n' + fs.readFileSync(path.join(ROOT, f), 'utf8'); });
vm.runInContext(combined, sandbox, { filename: 'combined.js' });

// 中性化有副作用 / 外部依赖的函数
vm.runInContext('saveState = function(){}; updateGameDayInfo = function(){}; addBehaviorRecords = function(){};', sandbox);
vm.runInContext('getTimeConfig = function(){ return { mode:"periods", periods:["早晨","上午","下午","傍晚","夜晚"] }; };', sandbox);
vm.runInContext('isNarrativeMode = function(){ return false; };', sandbox);
vm.runInContext('reputationTitle = function(v){ return "凡人"; }; tensionTitle = function(v){ return "平静"; };', sandbox);

// 暴露被测函数（vm 顶层 function 声明未必全部成为 sandbox 属性）
vm.runInContext('Object.assign(this, { applyStateChanges, buildCompactGameState, equipItem, unequipItem, getEquippedItem, getWeaponDamageBonus, getArmorAcBonus });', sandbox);

function setGameState(gs) {
  sandbox.SANDBOX_GAMESTATE = gs;
  sandbox.gameState = gs;
  vm.runInContext('gameState = SANDBOX_GAMESTATE;', sandbox);
}
function setWorld(w){
  sandbox.SANDBOX_WORLD = w;
  vm.runInContext('currentWorld = SANDBOX_WORLD;', sandbox);
}

// 最小 gameState 骨架（足以让 applyStateChanges 跑通，且不污染 factions/currency 等被测字段）
function baseGs(extra) {
  return Object.assign({
    current_location: '初始地点',
    current_date: { day: 1, period: 'morning' },
    attributes: {}, relationships: {}, skills: {}, progression: {},
    inventory: [], completed_events: [], goals: [], status_effects: [],
    factions: {}, currency: { gold: 0 }, crafting_recipes: [], equipped: {}
  }, extra || {});
}

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  PASS ✓', name); }
  else { fail++; console.log('  FAIL ✗', name); }
}

// ============ [1] 兜底：旧存档无 factions/currency/crafting_recipes/equipped 时不崩 ============
console.log('\n[1] 兜底创建默认字段（旧存档兼容）');
{
  const gs = baseGs({ factions: undefined, currency: undefined, crafting_recipes: undefined, equipped: undefined });
  // 注意：上面 Object.assign 仍写了空对象；这里用更彻底的无字段 gs
  const legacy = {
    current_location: '旧地', current_date: { day: 1, period: 'morning' },
    attributes: {}, relationships: {}, skills: {}, progression: {},
    inventory: [], completed_events: [], goals: [], status_effects: []
  };
  setGameState(legacy);
  sandbox.applyStateChanges({});
  ok('factions 被兜底为 {}', legacy.factions && typeof legacy.factions === 'object' && Object.keys(legacy.factions).length === 0);
  ok('currency 被兜底为 {gold:0}', legacy.currency && legacy.currency.gold === 0);
  ok('crafting_recipes 被兜底为 []', Array.isArray(legacy.crafting_recipes) && legacy.crafting_recipes.length === 0);
  ok('equipped 被兜底为 {}', legacy.equipped && typeof legacy.equipped === 'object');
}

// ============ [2] factions 声望累加 / 立场覆盖 / 边界 clamp ============
console.log('\n[2] factions 声望累加与立场');
{
  const gs = baseGs({ factions: { '帝国': { reputation: 0, stance: '中立' } } });
  setGameState(gs);
  sandbox.applyStateChanges({ factions: { '帝国': { reputation_delta: 5, stance: '友善', desc: '护送商队' } } });
  ok('声望 +5', gs.factions['帝国'].reputation === 5);
  ok('立场覆盖为友善', gs.factions['帝国'].stance === '友善');
  ok('desc 记录', gs.factions['帝国'].desc === '护送商队');
  sandbox.applyStateChanges({ factions: { '帝国': { reputation_delta: 10 } } });
  ok('声望累加至 15', gs.factions['帝国'].reputation === 15);
  sandbox.applyStateChanges({ factions: { '帝国': { reputation_delta: -200 } } });
  ok('声望下界 clamp -100', gs.factions['帝国'].reputation === -100);
  sandbox.applyStateChanges({ factions: { '帝国': { reputation_delta: 500 } } });
  ok('声望上界 clamp 100', gs.factions['帝国'].reputation === 100);
  // 新势力自动初始化
  sandbox.applyStateChanges({ factions: { '兄弟会': { reputation_delta: -3 } } });
  ok('新势力自动建户', gs.factions['兄弟会'] && gs.factions['兄弟会'].reputation === -3);
}

// ============ [3] currency delta / 边界 / 新币种 ============
console.log('\n[3] currency 货币经济');
{
  const gs = baseGs({ currency: { gold: 100 } });
  setGameState(gs);
  sandbox.applyStateChanges({ currency: { gold: -30 } });
  ok('金币扣减 100→70', gs.currency.gold === 70);
  sandbox.applyStateChanges({ currency: { gold: -999 } });
  ok('扣减不为负，clamp 0', gs.currency.gold === 0);
  sandbox.applyStateChanges({ currency: { gold: 50 } });
  ok('金币回复 0→50', gs.currency.gold === 50);
  sandbox.applyStateChanges({ currency: { spirit_stone: 3 } });
  ok('新币种灵石建立', gs.currency.spirit_stone === 3);
}

// ============ [4] crafting add_recipe 去重 ============
console.log('\n[4] crafting 配方去重');
{
  const gs = baseGs();
  setGameState(gs);
  const r1 = { id: 'forge_iron', name: '锻造铁器', inputs: [{ item_id: 'iron_ore', count: 2 }], output: { item_id: 'iron_sword', name: '铁剑', count: 1 }, desc: '熔炉锻打' };
  sandbox.applyStateChanges({ crafting: { add_recipe: r1 } });
  ok('首次加入配方', gs.crafting_recipes.length === 1 && gs.crafting_recipes[0].id === 'forge_iron');
  sandbox.applyStateChanges({ crafting: { add_recipe: r1 } });
  ok('重复 id 不去重新增', gs.crafting_recipes.length === 1);
  const r2 = { id: 'brew_potion', name: '酿制药剂', inputs: [], output: { item_id: 'potion', name: '治疗药剂', count: 1 }, desc: '' };
  sandbox.applyStateChanges({ crafting: { add_recipe: r2 } });
  ok('第二配方加入', gs.crafting_recipes.length === 2);
  ok('配方保留 inputs/output', gs.crafting_recipes[0].inputs.length === 1 && gs.crafting_recipes[0].output.item_id === 'iron_sword');
}

// ============ [5] inventory 扩展字段保留 ============
console.log('\n[5] inventory 扩展字段（装备/类型/加成）');
{
  const gs = baseGs();
  setGameState(gs);
  sandbox.applyStateChanges({ inventory: [{ op: 'add', item_id: 'iron_sword', name: '铁剑', count: 1, type: 'weapon', equippable: true, slot: 'weapon', damage_bonus: 2, ac_bonus: 0, desc: '粗犷但锋利' }] });
  const it = gs.inventory.find(i => i.item_id === 'iron_sword');
  ok('扩展字段 type/equippable/slot 保留', it && it.type === 'weapon' && it.equippable === true && it.slot === 'weapon');
  ok('damage_bonus/ac_bonus/desc 保留', it && it.damage_bonus === 2 && it.ac_bonus === 0 && it.desc === '粗犷但锋利');
  sandbox.applyStateChanges({ inventory: [{ op: 'add', item_id: 'iron_sword', count: 1 }] });
  ok('同 id 叠加数量', gs.inventory.find(i => i.item_id === 'iron_sword').count === 2);
}

// ============ [6] equip / unequip / getWeaponDamageBonus ============
console.log('\n[6] 装备系统辅助函数');
{
  const gs = baseGs({
    inventory: [{ item_id: 'iron_sword', name: '铁剑', count: 1, type: 'weapon', equippable: true, slot: 'weapon', damage_bonus: 2, ac_bonus: 0, desc: '' }],
    equipped: {}
  });
  setGameState(gs);
  const okEquip = sandbox.equipItem(gs, 'iron_sword');
  ok('装备成功返回 true', okEquip === true);
  ok('equipped.weapon 写入', gs.equipped.weapon === 'iron_sword');
  ok('武器伤害加成 = 2', sandbox.getWeaponDamageBonus(gs) === 2);
  // 非装备物
  gs.inventory.push({ item_id: 'herb', name: '草药', count: 1, type: 'consumable', equippable: false, slot: null, damage_bonus: 0, ac_bonus: 0, desc: '' });
  ok('非装备物 equip 返回 false', sandbox.equipItem(gs, 'herb') === false);
  ok('非装备物不影响 equipped', gs.equipped.weapon === 'iron_sword');
  sandbox.unequipItem(gs, 'weapon');
  ok('卸下后 weapon 为 null', gs.equipped.weapon === null);
  ok('卸下后加成 = 0', sandbox.getWeaponDamageBonus(gs) === 0);
}

// ============ [7] ActionMenu.dispatch('attack') 接入武器伤害加成 ============
console.log('\n[7] 攻击伤害接入已装备武器加成（mock 骰子）');
{
  // 固定骰子：命中（success=true），基础伤害 5
  vm.runInContext('Dice.checkAgainst = function(mod, dc){ return { roll: 15, mod: mod, total: 15 + mod, success: true, nat1: false, nat20: false, degree: 5 }; };', sandbox);
  vm.runInContext('Dice.roll = function(){ return { total: 5 }; };', sandbox);

  const gsNoEq = baseGs({
    combat_stats: { strength: { value: 10, mod: 0 }, current_enemy: null, ac: 12 },
    inventory: [{ item_id: 'iron_sword', name: '铁剑', count: 1, type: 'weapon', equippable: true, slot: 'weapon', damage_bonus: 2, ac_bonus: 0, desc: '' }],
    equipped: {}
  });
  setGameState(gsNoEq);
  const r1 = sandbox.ActionMenu.dispatch('attack', gsNoEq);
  ok('未装备：伤害 = 基础5', r1.rulesResult.damage === 5);

  const gsEq = baseGs({
    combat_stats: { strength: { value: 10, mod: 0 }, current_enemy: null, ac: 12 },
    inventory: [{ item_id: 'iron_sword', name: '铁剑', count: 1, type: 'weapon', equippable: true, slot: 'weapon', damage_bonus: 2, ac_bonus: 0, desc: '' }],
    equipped: { weapon: 'iron_sword' }
  });
  setGameState(gsEq);
  const r2 = sandbox.ActionMenu.dispatch('attack', gsEq);
  ok('已装备铁剑(伤害+2)：伤害 = 7', r2.rulesResult.damage === 7);

  const gsShield = baseGs({
    combat_stats: { strength: { value: 10, mod: 0 }, current_enemy: null, ac: 12 },
    inventory: [{ item_id: 'iron_sword', name: '铁剑', count: 1, type: 'weapon', equippable: true, slot: 'weapon', damage_bonus: 3, ac_bonus: 0, desc: '' }],
    equipped: { weapon: 'iron_sword' }
  });
  setGameState(gsShield);
  const r3 = sandbox.ActionMenu.dispatch('attack', gsShield);
  ok('已装备伤害+3 的武器：伤害 = 8', r3.rulesResult.damage === 8);
}

// ============ [8] buildCompactGameState 注入 factions/currency/crafting_recipes ============
console.log('\n[8] AI 紧凑状态注入 factions/currency/crafting');
{
  setWorld({ hero: '测试旅人' });
  const gs = baseGs({
    factions: { '帝国': { reputation: 20, stance: '友善' }, '兄弟会': { reputation: -10, stance: '敌视' } },
    currency: { gold: 120, spirit_stone: 3 },
    crafting_recipes: [{ id: 'forge_iron', name: '锻造铁器', inputs: [{ item_id: 'iron_ore', count: 2 }], output: { item_id: 'iron_sword' } }]
  });
  setGameState(gs);
  const json = sandbox.buildCompactGameState();
  let parsed = null;
  try { parsed = JSON.parse(json); } catch (e) { /* ignore */ }
  ok('compact 可解析', parsed !== null);
  ok('注入 factions', parsed && parsed.factions && parsed.factions['帝国'] && parsed.factions['帝国'].reputation === 20);
  ok('注入 currency', parsed && parsed.currency && parsed.currency.gold === 120 && parsed.currency.spirit_stone === 3);
  ok('注入 crafting_recipes(id/name)', parsed && Array.isArray(parsed.crafting_recipes) && parsed.crafting_recipes.length === 1 && parsed.crafting_recipes[0].id === 'forge_iron');
  ok('crafting_recipes 仅含 id/name（不泄露 inputs 细节）', parsed && parsed.crafting_recipes[0].inputs === undefined);
}

// ============ [9] 兼容回归：仅 inventory 变更不影响 factions/currency 结构 ============
console.log('\n[9] 兼容回归');
{
  const gs = baseGs({ factions: { '帝国': { reputation: 5, stance: '中立' } }, currency: { gold: 10 } });
  setGameState(gs);
  sandbox.applyStateChanges({ inventory: [{ op: 'add', item_id: 'coin', name: '铜钱', count: 5 }] });
  ok('factions 不受影响', gs.factions['帝国'].reputation === 5);
  ok('currency 不受影响', gs.currency.gold === 10);
  ok('inventory 正常新增', gs.inventory.find(i => i.item_id === 'coin').count === 5);
}

console.log('\n==== 第⑤项校验汇总: ' + pass + ' PASS, ' + fail + ' FAIL ====');
process.exit(fail === 0 ? 0 : 1);
