/**
 * NPC 地图化 确定性测试（不耗 API）
 * 验证：locateTextOnMap 文本→坐标定位 + syncNpcEntitiesOnMap 把 npc_states 同步成地图 npc 实体
 * 运行：node test/npc_map_check.js
 */
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond) {
    if (cond) { pass++; console.log('  PASS ' + name); }
    else { fail++; console.log('  FAIL ' + name); }
}

// ---- 最小 DOM / 全局 stub ----
function fakeEl() {
    return {
        value: '', checked: false, innerHTML: '', style: {}, textContent: '',
        classList: { add() {}, remove() {} },
        addEventListener() {}, removeEventListener() {},
        appendChild() {}, querySelector() { return null; }, querySelectorAll() { return []; }
    };
}
const docStub = {
    addEventListener() {}, removeEventListener() {},
    getElementById() { return fakeEl(); },
    querySelector() { return null; }, querySelectorAll() { return []; }, createElement() { return fakeEl(); }
};

let tileUpdateCalls = 0;
const sandbox = {
    console,
    document: docStub,
    setTimeout, clearTimeout,
    saveState() {}, updateGameDayInfo() {},
    currentWorld: { fog_of_war: true },
    gameState: null,
    // ★ TileMap stub：仅记录 update 是否被调用（真实渲染依赖 DOM，测试不验证）
    TileMap: { update() { tileUpdateCalls++; }, render() {} }
};
sandbox.window = sandbox; // 让 window.X 与词法全局互通
vm.createContext(sandbox);

['js/map-data.js', 'js/app-game.js'].forEach(function (f) {
    const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
    vm.runInContext(code, sandbox, { filename: f });
});

// ---- 构造一张有效地图 ----
function buildMap() {
    const grid = [];
    for (let y = 0; y < 5; y++) {
        const row = [];
        for (let x = 0; x < 5; x++) row.push('0');
        grid.push(row);
    }
    // 把 (2,2) 设为酒馆瓦片
    grid[2][2] = '1';
    return {
        protocol: 'MapDataV1', map_type: 'town', width: 5, height: 5, tile_size: '48px',
        grid,
        tile_legend: {
            '0': { name: '道路', css: 'bg-road' },
            '1': { name: '酒馆', css: 'bg-building' }
        },
        entities: [{ row: 0, col: 0, id: 'player', type: 'player', name: '你' }],
        poi: [
            { name: '城门口', row: 0, col: 4 },
            { name: '酒馆', row: 2, col: 2 }
        ],
        explored: (function () { const g = []; for (let y = 0; y < 5; y++) { const r = []; for (let x = 0; x < 5; x++) r.push(true); g.push(r); } return g; })(),
        fog_of_war: false
    };
}

console.log('\n==== locateTextOnMap 文本→坐标定位 ====');
const map = buildMap();
const p1 = sandbox.locateTextOnMap(map, '城门口');
ok('poi 精确匹配 → 城门口(0,4)', p1 && p1.row === 0 && p1.col === 4);
const p2 = sandbox.locateTextOnMap(map, '酒馆');
ok('poi 精确匹配 → 酒馆(2,2)', p2 && p2.row === 2 && p2.col === 2);
const p3 = sandbox.locateTextOnMap(map, '主角前往酒馆喝酒');
ok('子串包含 poi 名 → 命中酒馆(2,2)', p3 && p3.row === 2 && p3.col === 2);
const p4 = sandbox.locateTextOnMap(map, '道路');
ok('图例名兜底唯一匹配 → 首个道路坐标(0,0)', p4 && p4.row === 0 && p4.col === 0);
const p5 = sandbox.locateTextOnMap(map, '不存在的地点');
ok('无匹配 → 返回 null', p5 === null);
const p6 = sandbox.locateTextOnMap(map, '');
ok('空文本 → 返回 null', p6 === null);

console.log('\n==== syncNpcEntitiesOnMap 同步地图实体 ====');
const gs = {
    current_map: buildMap(),
    npc_states: {
        '张三': { location: '酒馆' },
        '李四': { location: '城门口' },
        '王五': { location: '异世界深处' }   // 不在地图上
    }
};
tileUpdateCalls = 0;
sandbox.syncNpcEntitiesOnMap(gs);
const findNpc = function (name) { return gs.current_map.entities.filter(function (e) { return e.id === 'npc_' + name; })[0]; };
ok('张三 挂为 npc 实体于酒馆(2,2)', findNpc('张三') && findNpc('张三').row === 2 && findNpc('张三').col === 2 && findNpc('张三').type === 'npc');
ok('李四 挂为 npc 实体于城门口(0,4)', findNpc('李四') && findNpc('李四').row === 0 && findNpc('李四').col === 4);
ok('王五 地点不在地图 → 不挂标记', !findNpc('王五'));
ok('触发地图重渲染', tileUpdateCalls === 1);

// 移动：张三从酒馆→城门口
gs.npc_states['张三'].location = '城门口';
tileUpdateCalls = 0;
sandbox.syncNpcEntitiesOnMap(gs);
ok('张三 移动后落到城门口(0,4)', findNpc('张三') && findNpc('张三').row === 0 && findNpc('张三').col === 4);
ok('移动触发重渲染', tileUpdateCalls === 1);

// 清理：移除张三的地点，陈旧 npc 实体应被清掉
delete gs.npc_states['张三'].location;
tileUpdateCalls = 0;
sandbox.syncNpcEntitiesOnMap(gs);
ok('张三 失去地点 → npc 实体被清理', !findNpc('张三'));
ok('清理触发重渲染', tileUpdateCalls === 1);

// 无有效 npc 状态时不应产生 npc 实体且不报锚
const gs2 = { current_map: buildMap(), npc_states: {} };
sandbox.syncNpcEntitiesOnMap(gs2);
ok('空 npc_states → 无 npc 实体', !gs2.current_map.entities.some(function (e) { return e.id && e.id.indexOf('npc_') === 0; }));

// 与玩家坐标不冲突：npc 落在非玩家格
ok('npc 实体不与 player 重叠', findNpc('李四') && !(findNpc('李四').row === 0 && findNpc('李四').col === 0));

console.log('\n========== 汇总 ==========');
console.log('PASS=' + pass + ' FAIL=' + fail);
process.exit(fail > 0 ? 1 : 0);
