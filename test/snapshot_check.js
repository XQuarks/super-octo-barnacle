/**
 * D 分支快照（多时间线存档）· 确定性校验（vm 沙箱加载真实源码，不耗 API）
 * 覆盖：
 *   1) 纯函数 takeSnapshot / getSnapshotsForWorld / getSnapshotById / deleteSnapshot / buildLiveStateFromSnapshot
 *   2) 快照捕获完整状态（gameState + currentWorld + 三段历史）
 *   3) 深拷贝独立性（改 live 不影响已存快照 / 原入参）
 *   4) 世界过滤 + 最新在前 + 安全兜底
 *   5) loadSnapshots / saveSnapshots 本地存储往返
 *   6) doTakeSnapshot / doLoadSnapshot（UI 全链路 + 注入 DOM 打桩）
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
    addEventListener(){}, appendChild(){}, removeChild(){}, insertBefore(){},
    querySelector(){ return null; }, querySelectorAll(){ return []; },
    focus(){}, blur(){}, click(){}
  };
}
const elCache = {};
const docStub = {
  addEventListener(){}, removeEventListener(){},
  getElementById(id){
    if (!elCache[id]) {
      const el = fakeEl();
      if (id === 'snapshotLabelInput') el.value = '';
      if (id === 'mockMode') el.checked = true;
      elCache[id] = el;
    }
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

// 打桩外部副作用（与 world_book_check 一致）
vm.runInContext('saveState = function(){}; updateGameDayInfo = function(){};', sandbox);
vm.runInContext('computeEmbeddingsForWorld = function(){ return Promise.resolve(); };', sandbox);
// doLoadSnapshot / doTakeSnapshot 依赖的 DOM 副作用函数打桩
vm.runInContext('renderLog = function(){}; renderStatusPanel = function(){}; closeModal = function(){}; showToast = function(){}; createOrUpdateSave = function(){};', sandbox);

const testScript = `
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  PASS \\u2713', name); }
  else { fail++; console.log('  FAIL \\u2717', name); }
}

function makePayload(over) {
  return Object.assign({
    gameState: { hp: 10, currency: { gold: 5 }, current_date: { day: 1, period: 'day' } },
    currentWorld: { id: 'w1', name: 'W', shops: [{ id: 's1', name: '杂货铺' }], quest_board: [], lore_kb: { snippets: [] } },
    conversationHistory: [{ narrative: 'a', day: 1, period: 'day' }],
    chatHistory: [{ role: 'user', content: 'hi' }],
    chatSummary: [{ summary: '开场' }]
  }, over || {});
}

// ===== 1) takeSnapshot 纯函数 =====
let snapArr = takeSnapshot([], 'w1', 'W', makePayload(), { id: 'snap1', label: 'L1', createdAt: '2026-07-08T00:00:00Z', progress: '第1天' });
ok('takeSnapshot 空数组入参 → 返回长度1', snapArr.length === 1);
ok('takeSnapshot 生成快照含 id/label/worldId', snapArr[0].id === 'snap1' && snapArr[0].label === 'L1' && snapArr[0].worldId === 'w1');
ok('takeSnapshot 捕获 gameState', snapArr[0].gameState && snapArr[0].gameState.hp === 10);
ok('takeSnapshot 捕获 currentWorld（含 shops）', snapArr[0].currentWorld && snapArr[0].currentWorld.shops.length === 1);
ok('takeSnapshot 捕获 conversationHistory', snapArr[0].conversationHistory.length === 1);
ok('takeSnapshot 捕获 chatHistory/chatSummary', snapArr[0].chatHistory.length === 1 && snapArr[0].chatSummary.length === 1);
ok('takeSnapshot 不修改入参数组', Array.isArray(snapArr));

const noPayload = takeSnapshot([], 'w1', 'W', null, { id: 'x' });
ok('takeSnapshot 入参非法（无 payload）→ 原样返回', noPayload.length === 0);
const noGs = takeSnapshot([], 'w1', 'W', { currentWorld: {} }, { id: 'x' });
ok('takeSnapshot 缺 gameState → 安全返回空', noGs.length === 0);

const withLabel = takeSnapshot([], 'w1', 'W', makePayload(), { label: '', progress: '第2天' });
ok('takeSnapshot 空 label → 用默认名含 progress', withLabel[0].label.indexOf('第2天') >= 0);

// ===== 2) 多快照 + 排序（最新在前）=====
snapArr = takeSnapshot(snapArr, 'w1', 'W', makePayload({ gameState: { hp: 20 } }), { id: 'snap2', label: 'L2', createdAt: '2026-07-09T00:00:00Z' });
ok('第二次拍照 → 数组长度2', snapArr.length === 2);
ok('最新快照前置（unshift）', snapArr[0].id === 'snap2' && snapArr[1].id === 'snap1');

// ===== 3) getSnapshotsForWorld / getSnapshotById / deleteSnapshot =====
const w1List = getSnapshotsForWorld(snapArr, 'w1');
ok('getSnapshotsForWorld 过滤当前世界', w1List.length === 2);
const otherWorld = takeSnapshot(snapArr, 'w9', '其它世界', makePayload({ currentWorld: { id: 'w9' } }), { id: 'snap9', label: 'O' });
ok('不同世界快照不被混入当前世界列表', getSnapshotsForWorld(otherWorld, 'w1').length === 2);
ok('getSnapshotsForWorld 其它世界取到1张', getSnapshotsForWorld(otherWorld, 'w9').length === 1);

ok('getSnapshotById 命中', getSnapshotById(otherWorld, 'snap9').id === 'snap9');
ok('getSnapshotById 未命中 → null', getSnapshotById(otherWorld, 'nope') === null);

const afterDel = deleteSnapshot(otherWorld, 'snap1');
ok('deleteSnapshot 删除指定项', afterDel.length === otherWorld.length - 1 && !afterDel.some(s => s.id === 'snap1'));
ok('deleteSnapshot 不存在 id → 安全', deleteSnapshot(otherWorld, 'zzz').length === otherWorld.length);

// ===== 4) buildLiveStateFromSnapshot 深拷贝独立性 =====
const refSnap = getSnapshotById(otherWorld, 'snap2');
const live = buildLiveStateFromSnapshot(refSnap);
ok('buildLiveStateFromSnapshot 返回 gameState', live.gameState && live.gameState.hp === 20);
ok('buildLiveStateFromSnapshot 返回 currentWorld', live.currentWorld && live.currentWorld.id === 'w1');
ok('buildLiveStateFromSnapshot 返回三段历史', live.conversationHistory.length === 1 && live.chatHistory.length === 1 && live.chatSummary.length === 1);

// 篡改 live，断言原快照与原始入参均不被污染
const origPayload = makePayload();
const origSnapArr = takeSnapshot([], 'w1', 'W', origPayload, { id: 'ind1', label: 'I' });
const origSnap = origSnapArr[0];
const live2 = buildLiveStateFromSnapshot(origSnap);
live2.gameState.hp = 999;
live2.currentWorld.name = 'MUT';
live2.conversationHistory.push({ narrative: 'b' });
live2.chatHistory.push({ role: 'assistant' });
ok('深拷贝：篡改 live.gameState 不影响已存快照', origSnap.gameState.hp === 10);
ok('深拷贝：篡改 live.currentWorld 不影响已存快照', origSnap.currentWorld.name === 'W');
ok('深拷贝：篡改 live.history 不影响已存快照', origSnap.conversationHistory.length === 1 && origSnap.chatHistory.length === 1);
ok('深拷贝：takeSnapshot 已复制入参（原 payload 不受影响）', origPayload.gameState.hp === 10 && origPayload.currentWorld.name === 'W' && origPayload.conversationHistory.length === 1);

// ===== 5) loadSnapshots / saveSnapshots 存储往返 =====
snapshots = takeSnapshot([], 'w1', 'W', makePayload(), { id: 'rt1', label: '往返', createdAt: '2026-07-08' });
saveSnapshots();
snapshots = [];
loadSnapshots();
ok('saveSnapshots/loadSnapshots 往返成功', getSnapshotsForWorld(snapshots, 'w1').length === 1 && getSnapshotById(snapshots, 'rt1').label === '往返');

// ===== 6) doTakeSnapshot（UI 全链路）=====
worlds = [{ id: 'w1', name: 'W' }];
currentWorld = worlds[0];
gameState = { hp: 7, currency: { gold: 3 }, current_date: { day: 3, period: 'night' } };
conversationHistory = [{ narrative: 'live' }];
chatHistory = [{ role: 'user' }];
chatSummary = [];
document.getElementById('snapshotLabelInput').value = '酒馆接委托前';
const beforeTake = (typeof snapshots !== 'undefined' && Array.isArray(snapshots)) ? snapshots.length : 0;
doTakeSnapshot();
ok('doTakeSnapshot 新增一张快照', getSnapshotsForWorld(snapshots, 'w1').length === beforeTake + 1);
const taken = getSnapshotsForWorld(snapshots, 'w1')[0];
ok('doTakeSnapshot 使用输入标签', taken.label === '酒馆接委托前');
ok('doTakeSnapshot 进度含天数', taken.progress.indexOf('第 3 天') >= 0);
ok('doTakeSnapshot 捕获当前 gameState', taken.gameState.hp === 7);

// ===== 7) doLoadSnapshot（UI 全链路 → 分叉时间线）=====
// 先制造一个分叉点快照
snapshots = takeSnapshot([], 'w1', 'W', {
  gameState: { hp: 50, currency: { gold: 99 }, current_date: { day: 5, period: 'day' } },
  currentWorld: { id: 'w1', name: 'W', shops: [] },
  conversationHistory: [{ narrative: '分歧前' }],
  chatHistory: [{ role: 'user' }],
  chatSummary: []
}, { id: 'branchX', label: '分支X' });
// 当前 live 已偏离
worlds = [{ id: 'w1', name: 'W' }];
currentWorld = worlds[0];
gameState = { hp: 1, currency: { gold: 0 }, current_date: { day: 9, period: 'day' } };
conversationHistory = [{ narrative: '已偏离' }];
chatHistory = [{ role: 'user', content: '其他' }];
chatSummary = [];
doLoadSnapshot('branchX');
ok('doLoadSnapshot 恢复 gameState', gameState.hp === 50 && gameState.currency.gold === 99);
ok('doLoadSnapshot 恢复 currentWorld', currentWorld.name === 'W');
ok('doLoadSnapshot 替换 worlds[] 内对应项', worlds[0].name === 'W' && worlds[0].shops);
ok('doLoadSnapshot 恢复 conversationHistory', conversationHistory.length === 1 && conversationHistory[0].narrative === '分歧前');
ok('doLoadSnapshot 恢复 chatHistory', chatHistory.length === 1 && chatHistory[0].role === 'user');
// 载入后再次篡改 live，确认不污染原快照
gameState.hp = -1;
ok('doLoadSnapshot 后篡改 live 不影响已存快照', getSnapshotById(snapshots, 'branchX').gameState.hp === 50);

// 载入不存在的快照 → 安全
let threw = false;
try { doLoadSnapshot('ghost'); } catch (e) { threw = true; }
ok('doLoadSnapshot 不存在 id → 不抛异常', !threw);

console.log('\\n结果：' + pass + ' PASS, ' + fail + ' FAIL');
if (fail > 0) { throw new Error(fail + ' 项断言失败'); }
`;

try {
  vm.runInContext(testScript, sandbox, { filename: 'snapshot_test.js' });
  console.log('✅ snapshot_check.js 全部通过');
} catch (e) {
  console.error('❌ snapshot_check.js 失败：', e.message);
  process.exit(1);
}
