/**
 * 反向回写 + 战争迷雾 确定性校验
 * 加载真实产品代码（vm 拼接 app-core+map-data+dice+combat-stats+combat-engine+action-menu+tile-map+app-game）
 * 不耗 API、不依赖真实浏览器 DOM（document/localStorage 打桩）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = 'C:/Users/guoxiaoyan/WorkBuddy/C项目';
const files = [
  'js/app-core.js', 'js/map-data.js', 'js/dice.js', 'js/combat-stats.js',
  'js/combat-engine.js', 'js/action-menu.js', 'js/renderer/tile-map.js', 'js/app-game.js'
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

// 中性化有副作用的保存/UI 函数（不影响被测逻辑）
vm.runInContext('saveState = function(){}; updateGameDayInfo = function(){};', sandbox);
// getTimeConfig / isNarrativeMode 来自 app-ui.js（本 harness 未加载），applyStateChanges 内部会调用，需打桩
vm.runInContext('getTimeConfig = function(){ return { mode:"periods", periods:["早晨","上午","下午","傍晚","夜晚"] }; };', sandbox);
vm.runInContext('isNarrativeMode = function(){ return false; };', sandbox);
sandbox.currentWorld = { fog_of_war: true };

// 把辅助函数显式挂到 sandbox 属性（vm 顶层函数声明未必全部暴露为属性）
vm.runInContext('Object.assign(this, { findPlayerPos, findPath, movePlayerOnMap, placePlayerOnMap, addMapEnemiesForCombat, syncMapCombatEntities, syncMapPlayerFromNarrative, initFog, revealAround, applyStateChanges });', sandbox);

function setGameState(gs) {
  sandbox.SANDBOX_GAMESTATE = gs;
  sandbox.gameState = gs;
  vm.runInContext('gameState = SANDBOX_GAMESTATE;', sandbox);
}
function setWorld(w){
  sandbox.SANDBOX_WORLD = w;
  vm.runInContext('currentWorld = SANDBOX_WORLD;', sandbox); // 以脚本内赋值确保 in-vm 全局生效
}

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  PASS ✓', name); }
  else { fail++; console.log('  FAIL ✗', name); }
}

function buildMap(extra) {
  const grid = [];
  for (let y = 0; y < 5; y++) { const row = []; for (let x = 0; x < 5; x++) row.push(0); grid.push(row); }
  const map = {
    protocol: 'MapDataV1', map_type: 'dungeon', width: 5, height: 5, tile_size: '48px',
    grid,
    tile_legend: { 0: { name: '石砖地面', blocked: false, css: 'bg-gray' }, 1: { name: '墙', blocked: true, css: 'bg-stone' }, 2: { name: '藏书阁', blocked: false, css: 'bg-building' } },
    entities: [{ row: 2, col: 2, id: 'player', name: '你', type: 'player', desc: '' }],
    description: '测试地牢'
  };
  // 放一个"藏书阁"瓦片在 (0,0)
  map.grid[0][0] = 2;
  if (extra) Object.assign(map, extra);
  return map;
}

console.log('\n[1] parse 保留 explored / fog_of_war / poi');
{
  const parsed = sandbox.MapDataV1.parse({
    protocol:'MapDataV1', map_type:'dungeon', width:2, height:2, grid:[[0,0],[0,0]],
    tile_legend:{0:{name:'x'}}, entities:[], explored:[[true,false],[false,false]],
    fog_of_war:false, poi:[{name:'大厅',row:0,col:0}]
  });
  ok('explored 被保留', parsed.explored && parsed.explored[0][0] === true && parsed.explored[0][1] === false);
  ok('fog_of_war 被保留(false)', parsed.fogOfWar === false);
  ok('poi 被保留', parsed.poi.length === 1 && parsed.poi[0].name === '大厅');
}

console.log('\n[2] initFog 创建探索网格 + 揭示玩家周围');
{
  const map = buildMap();
  setWorld({ fog_of_war: true });
  const gs = { current_map: map, current_location: '起点', combat_stats:{ in_combat:false } };
  setGameState(gs);
  sandbox.initFog(map);
  ok('explored 尺寸 5x5', map.explored.length === 5 && map.explored[0].length === 5);
  ok('玩家初始格(2,2)已探索', map.explored[2][2] === true);
  ok('玩家周围 3x3 已探索', map.explored[1][1] && map.explored[3][3] && map.explored[1][3] && map.explored[3][1]);
  ok('远处(0,0)尚未探索', map.explored[0][0] === false);
  ok('fog_of_war 随世界设置开启', map.fog_of_war === true);
}

console.log('\n[3] initFog 尊重世界关闭迷雾');
{
  const map = buildMap();
  setWorld({ fog_of_war: false });
  const gs = { current_map: map, current_location: '起点', combat_stats:{ in_combat:false } };
  setGameState(gs);
  sandbox.initFog(map);
  ok('fog_of_war 被关闭', map.fog_of_war === false);
}

console.log('\n[4] revealAround 揭示半径');
{
  const map = buildMap();
  map.explored = sandbox.MapDataV1.createExploredGrid(5,5);
  sandbox.revealAround(map, 0, 0, 1);
  ok('(0,0)已探索', map.explored[0][0] === true);
  ok('(1,1)已探索(对角)', map.explored[1][1] === true);
  ok('(2,2)仍未知', map.explored[2][2] === false);
}

console.log('\n[5] placePlayerOnMap 仅移动不覆盖 current_location + 揭示新位置');
{
  const map = buildMap();
  setWorld({ fog_of_war: true });
  const gs = { current_map: map, current_location: '图书馆', combat_stats:{ in_combat:false } };
  setGameState(gs);
  sandbox.initFog(map);
  const r = sandbox.placePlayerOnMap(gs, 2, 3);
  ok('移动成功', r === true);
  const p = sandbox.findPlayerPos(map);
  ok('玩家已到(2,3)', p.row === 2 && p.col === 3);
  ok('current_location 未被覆盖(仍为图书馆)', gs.current_location === '图书馆');
  ok('新位置(2,3)已探索', map.explored[2][3] === true);
}

console.log('\n[6] 反向回写：player_pos 显式坐标');
{
  const map = buildMap();
  setWorld({ fog_of_war: true });
  const gs = { current_map: map, current_location: '旧地点', combat_stats:{ in_combat:false } };
  setGameState(gs);
  sandbox.syncMapPlayerFromNarrative(gs, { player_pos: { row: 4, col: 4 } }, '旧地点');
  const p = sandbox.findPlayerPos(map);
  ok('玩家被移动到(4,4)', p.row === 4 && p.col === 4);
}

console.log('\n[7] 反向回写：poi 名称匹配');
{
  const map = buildMap({ poi: [{ name: '图书馆', row: 0, col: 4 }] });
  setWorld({ fog_of_war: true });
  const gs = { current_map: map, current_location: '旧地点', combat_stats:{ in_combat:false } };
  setGameState(gs);
  sandbox.syncMapPlayerFromNarrative(gs, { current_location: '图书馆二楼' }, '旧地点');
  const p = sandbox.findPlayerPos(map);
  ok('玩家被定位到 poi(0,4)', p.row === 0 && p.col === 4);
}

console.log('\n[8] 反向回写：图例名匹配(唯一)');
{
  const map = buildMap();
  setWorld({ fog_of_war: true });
  const gs = { current_map: map, current_location: '旧地点', combat_stats:{ in_combat:false } };
  setGameState(gs);
  // current_location 含"藏书阁"，地图只有(0,0)是藏书阁 → 唯一匹配
  sandbox.syncMapPlayerFromNarrative(gs, { current_location: '走进藏书阁' }, '旧地点');
  const p = sandbox.findPlayerPos(map);
  ok('玩家被定位到藏书阁(0,0)', p.row === 0 && p.col === 0);
}

console.log('\n[9] 反向回写：地点未变化则不移动 + 战斗中不移动');
{
  const map = buildMap();
  setWorld({ fog_of_war: true });
  const gs = { current_map: map, current_location: '图书馆', combat_stats:{ in_combat:false } };
  setGameState(gs);
  sandbox.syncMapPlayerFromNarrative(gs, { current_location: '图书馆' }, '图书馆');
  let p = sandbox.findPlayerPos(map);
  ok('未变化→玩家仍在(2,2)', p.row === 2 && p.col === 2);

  const gs2 = { current_map: map, current_location: '旧', combat_stats:{ in_combat:true, enemies:[{id:'enemy_x',hp:5,maxHp:5}] } };
  setGameState(gs2);
  sandbox.syncMapPlayerFromNarrative(gs2, { current_location: '新地点', player_pos:{row:0,col:0} }, '旧');
  p = sandbox.findPlayerPos(map);
  ok('战斗中→玩家不移动', p.row === 2 && p.col === 2);
}

console.log('\n[10] applyStateChanges 集成：map_data→初始化迷雾；player_pos→回写');
{
  mapContainerEl.innerHTML = '';
  const mapData = {
    protocol:'MapDataV1', map_type:'dungeon', width:5, height:5, tile_size:'48px',
    grid: [[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]],
    tile_legend:{0:{name:'石砖地面',blocked:false,css:'bg-gray'}},
    entities:[{row:1,col:1,id:'player',name:'你',type:'player',desc:''}]
  };
  setWorld({ fog_of_war: true });
  const gs2 = { current_map: null, current_location: '旧', current_date: { day: 1, period: '上午' },
    combat_stats:{ in_combat:false, hp:10, max_hp:10 } };
  setGameState(gs2);
  sandbox.applyStateChanges({ map_data: mapData });
  ok('current_map 被设置', gs2.current_map === mapData);
  ok('迷雾已初始化', gs2.current_map.explored && gs2.current_map.explored[1][1] === true);
  ok('迷雾开启', gs2.current_map.fog_of_war === true);

  // 接着用 player_pos 回写
  sandbox.applyStateChanges({ player_pos: { row: 3, col: 3 }, current_location: '新坐标点' });
  const p = sandbox.findPlayerPos(gs2.current_map);
  ok('applyStateChanges 经 player_pos 回写玩家到(3,3)', p.row === 3 && p.col === 3);
  ok('新位置已揭示', gs2.current_map.explored[3][3] === true);
}

console.log('\n[11] computeFogVisible：玩家周围可见，远处不可见，战斗敌人周围可见');
{
  const map = buildMap();
  setWorld({ fog_of_war: true });
  const gs = { current_map: map, current_location:'x', combat_stats:{ in_combat:false } };
  setGameState(gs);
  sandbox.initFog(map);
  const vis = sandbox.TileMap.computeFogVisible(map);
  ok('玩家(2,2)可见', vis[2][2] === true);
  ok('相邻(1,1)可见', vis[1][1] === true);
  ok('远处(4,4)不可见', vis[4][4] === false);

  // 战斗中：在(4,4)放一个存活 _combat 敌人
  map.entities.push({ row:4, col:4, id:'enemy_far', name:'远处的敌人', type:'enemy', _combat:true });
  gs.combat_stats = { in_combat:true, enemies:[{id:'enemy_far', hp:5, maxHp:5}] };
  const vis2 = sandbox.TileMap.computeFogVisible(map);
  ok('战斗中：存活敌人(4,4)周围可见', vis2[4][4] === true && vis2[3][3] === true);
  // 阵亡敌人不应揭示
  gs.combat_stats.enemies[0].hp = 0;
  const vis3 = sandbox.TileMap.computeFogVisible(map);
  ok('战斗中：已阵亡敌人不再揭示远处', vis3[4][4] === false);
}

console.log('\n[12] TileMap.render 战争迷雾三态渲染');
{
  mapContainerEl.innerHTML = '';
  const map = buildMap();
  setWorld({ fog_of_war: true });
  const gs = { current_map: map, current_location:'x', combat_stats:{ in_combat:false } };
  setGameState(gs);
  sandbox.initFog(map); // 揭示(2,2)周围
  sandbox.revealAround(map, 0, 0, 1); // 额外揭示远处(0,0)区域：已探索但当前不可见 → 应暗淡
  sandbox.TileMap.render(map);
  const html = mapContainerEl.innerHTML;
  ok('渲染产出包含迷雾格 tile-fog', html.indexOf('tile-fog') >= 0);
  ok('渲染产出包含普通 tile-cell', html.indexOf('tile-cell') >= 0);
  ok('已探索暗淡格带 opacity:0.38', html.indexOf('opacity:0.38') >= 0);

  // 关闭迷雾：全部可见，无 tile-fog
  map.fog_of_war = false;
  mapContainerEl.innerHTML = '';
  sandbox.TileMap.render(map);
  const html2 = mapContainerEl.innerHTML;
  ok('关闭迷雾后无 tile-fog', html2.indexOf('tile-fog') < 0);
}

console.log('\n==============================');
console.log('结果: ' + pass + ' PASS, ' + fail + ' FAIL');
process.exit(fail === 0 ? 0 : 1);
