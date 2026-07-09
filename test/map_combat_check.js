/**
 * ② 地图⇄战斗 集成 确定性校验
 * 加载真实产品代码（vm 拼接 app-core+map-data+dice+combat-stats+combat-engine+action-menu+tile-map+app-game）
 * 不耗 API、不依赖浏览器 DOM（document/localStorage 打桩）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = 'C:/Users/guoxiaoyan/WorkBuddy/C项目';
const files = [
  'js/app-core.js', 'js/map-data.js', 'js/dice.js', 'js/combat-stats.js',
  'js/combat-engine.js', 'js/action-menu.js', 'js/renderer/tile-map.js', 'js/app-game.js'
];

// --- DOM / 浏览器 API 打桩 ---
function fakeEl() {
  return {
    innerHTML: '', value: '', style: {},
    classList: { add(){}, remove(){}, contains(){ return false; } },
    setAttribute(){}, removeAttribute(){}, getAttribute(){ return null; },
    addEventListener(){},
    querySelector(){ return null; },
    querySelectorAll(){ return []; }
  };
}
const docStub = {
  getElementById(){ return fakeEl(); },
  querySelector(){ return null; },
  querySelectorAll(){ return []; },
  createElement(){ return fakeEl(); }
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

// 中性化有副作用的保存/UI 函数（不影响被测逻辑）
vm.runInContext('saveState = function(){};', sandbox);

// 把辅助函数显式挂到 sandbox 属性（vm 顶层函数声明未必全部暴露为属性）
vm.runInContext('Object.assign(this, { findPlayerPos, findPath, movePlayerOnMap, addMapEnemiesForCombat, syncMapCombatEntities });', sandbox);

// 把测试 gameState 注入词法全局 gameState，并挂到 sandbox 属性（供 window.gameState 读取）
function setGameState(gs) {
  sandbox.SANDBOX_GAMESTATE = gs;
  sandbox.gameState = gs;
  vm.runInContext('gameState = SANDBOX_GAMESTATE;', sandbox);
}

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  PASS ✓', name); }
  else { fail++; console.log('  FAIL ✗', name); }
}

// ===== 构建一个测试地图 =====
function buildMap() {
  const grid = [];
  for (let y = 0; y < 5; y++) { const row = []; for (let x = 0; x < 5; x++) row.push(0); grid.push(row); }
  return {
    protocol: 'MapDataV1', map_type: 'dungeon', width: 5, height: 5, tile_size: '48px',
    grid,
    tile_legend: { 0: { name: '石砖地面', blocked: false, css: 'bg-gray' }, 1: { name: '墙', blocked: true, css: 'bg-stone' } },
    entities: [{ row: 2, col: 2, id: 'player', name: '你', type: 'player', desc: '' }],
    description: '测试地牢'
  };
}

console.log('\n[1] MapDataV1.parse 保留 type 字段 (修复实体图标 bug)');
{
  const parsed = sandbox.MapDataV1.parse({ protocol:'MapDataV1', map_type:'dungeon', width:1, height:1, grid:[[0]],
    tile_legend:{0:{name:'x'}}, entities:[{row:0,col:0,id:'e1',name:'哥布林',type:'enemy'}] });
  ok('实体 type 被保留', parsed.entities[0].type === 'enemy');
}

console.log('\n[2] findPlayerPos 找到玩家');
{
  const map = buildMap();
  const p = sandbox.findPlayerPos(map);
  ok('返回 (2,2)', p && p.row === 2 && p.col === 2);
  ok('空地图返回 null', sandbox.findPlayerPos({ entities: [] }) === null);
}

console.log('\n[3] findPath BFS 寻路');
{
  const map = buildMap();
  const same = sandbox.findPath(map, {row:2,col:2}, {row:2,col:2});
  ok('起点==终点 返回 []', Array.isArray(same) && same.length === 0);
  const path = sandbox.findPath(map, {row:2,col:2}, {row:0,col:0});
  ok('可达返回非空', path && path.length > 0);
  ok('终点正确', path && path[path.length-1].row === 0 && path[path.length-1].col === 0);
  ok('首步与起点相邻', path && Math.abs(path[0].row-2)+Math.abs(path[0].col-2) === 1);
  const m3 = buildMap();
  m3.grid[0][1] = 1; m3.grid[1][0] = 1; // 孤立 (0,0)
  const blockedGoal = sandbox.findPath(m3, {row:2,col:2}, {row:0,col:0});
  ok('孤立目标返回 null', blockedGoal === null);
}

console.log('\n[4] movePlayerOnMap 移动 + 同步 current_location');
{
  const map = buildMap();
  const gs = { current_map: map, current_location: '旧房间', combat_stats: { in_combat:false, hp:10, max_hp:10 } };
  setGameState(gs);
  const r = sandbox.movePlayerOnMap(gs, 2, 3);
  ok('移动成功', r === true);
  const p = sandbox.findPlayerPos(map);
  ok('玩家已到 (2,3)', p.row === 2 && p.col === 3);
  ok('current_location 同步为瓦片名', gs.current_location === '石砖地面');
  const r2 = sandbox.movePlayerOnMap(gs, 0, 0);
  ok('远距离直接移动也成功', r2 === true && sandbox.findPlayerPos(map).row === 0);
  const r3 = sandbox.movePlayerOnMap(gs, 1, 1);
  ok('再次移动成功', r3 === true);
}

console.log('\n[5] addMapEnemiesForCombat 把敌人放到地图(标记_combat)');
{
  const map = buildMap();
  const gs = { current_map: map, current_location:'大厅', combat_stats:{ in_combat:true, enemies:[] } };
  setGameState(gs);
  const enemies = [
    { id:'enemy_orc', name:'兽人', hp:8, maxHp:8 },
    { id:'enemy_gob', name:'哥布林', hp:5, maxHp:5 }
  ];
  gs.combat_stats.enemies = enemies;
  sandbox.addMapEnemiesForCombat(gs, enemies);
  const added = map.entities.filter(e => e._combat === true);
  ok('新增 2 个 _combat 敌人实体', added.length === 2);
  ok('敌人实体带 type=enemy', added.every(e => e.type === 'enemy'));
  ok('敌人实体坐标在地图内', added.every(e => e.row>=0 && e.row<5 && e.col>=0 && e.col<5));
}

console.log('\n[6] syncMapCombatEntities 战后清场(保留叙事敌人)');
{
  const map = buildMap();
  map.entities.push({ row:0, col:4, id:'enemy_statue', name:'石像守卫', type:'enemy', desc:'' }); // 叙事敌人(无_combat)
  map.entities.push({ row:4, col:4, id:'enemy_gob', name:'哥布林', type:'enemy', _combat:true }); // 战斗敌人
  const gs = { current_map: map, combat_stats:{ in_combat:true, enemies:[ {id:'enemy_gob', name:'哥布林', hp:5, maxHp:5} ] } };
  setGameState(gs);
  sandbox.syncMapCombatEntities(gs);
  ok('战斗敌人保留', map.entities.some(e => e.id === 'enemy_gob'));
  ok('叙事敌人保留', map.entities.some(e => e.id === 'enemy_statue'));
  gs.combat_stats.in_combat = false;
  gs.combat_stats.enemies = [];
  sandbox.syncMapCombatEntities(gs);
  ok('战后 _combat 敌被清场', !map.entities.some(e => e.id === 'enemy_gob'));
  ok('叙事敌人仍在', map.entities.some(e => e.id === 'enemy_statue'));
}

console.log('\n[7] onTileClick: 非战斗点空地 → 触发移动动作');
{
  const map = buildMap();
  const gs = { current_map: map, current_location:'起点', combat_stats:{ in_combat:false, hp:10, max_hp:10, level:1, xp:0,
    strength:{value:10,mod:0}, dexterity:{value:10,mod:0}, constitution:{value:10,mod:0}, intelligence:{value:10,mod:0}, wisdom:{value:10,mod:0}, charisma:{value:10,mod:0} } };
  setGameState(gs);
  let submitted = null;
  const playerInputEl = { value:'', setAttribute(){}, removeAttribute(){}, getAttribute(){return null;}, addEventListener(){}, classList:{add(){},remove(){},contains(){return false;}}, style:{}, querySelectorAll(){return [];} };
  sandbox.submitInput = function(){ submitted = { value: playerInputEl.value }; };
  // 让 handleActionClick 能设值并读取（playerInput 返回稳定单例，值可保留）
  sandbox.document = { getElementById(id){ return id === 'playerInput' ? playerInputEl : fakeEl(); }, querySelector(){return null;}, querySelectorAll(){return [];}, createElement(){return {};} };
  sandbox.TileMap.onTileClick(2, 3, sandbox.MapDataV1.parse(map));
  ok('玩家被移动到 (2,3)', sandbox.findPlayerPos(map).row === 2 && sandbox.findPlayerPos(map).col === 3);
  ok('触发了移动动作提交', submitted !== null && /移动|灵巧/.test(submitted.value));
}

console.log('\n==============================');
console.log('结果: ' + pass + ' PASS, ' + fail + ' FAIL');
process.exit(fail === 0 ? 0 : 1);
