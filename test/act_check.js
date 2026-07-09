// 确定性验证 ⑨ 章节/幕结构：加载真实 app-core + app-game，测试 computeCurrentAct / updateActProgress
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const coreSrc = fs.readFileSync(path.join(ROOT, 'js', 'app-core.js'), 'utf8');
const gameSrc = fs.readFileSync(path.join(ROOT, 'js', 'app-game.js'), 'utf8');

const pinned = []; // 收集 addBehaviorRecords 写入的内容
const sandbox = {
  console,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  SANDBOX_GAME: null,
  addBehaviorRecords: (arr) => { if (Array.isArray(arr)) pinned.push(...arr); },
  // app-game.js 加载时可能引用但未在本测试中触发的浏览器全局，给空 stub
  setTimeout, clearTimeout, fetch: () => Promise.reject('no fetch'),
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// 拼接成同一词法环境，模拟浏览器多 <script> 共享全局（app-core 用 let 声明全局）
const combined = coreSrc + '\n' + gameSrc + '\n' +
  'gameState = SANDBOX_GAME;\n' +
  'globalThis.__computeCurrentAct = computeCurrentAct;\n' +
  'globalThis.__updateActProgress = updateActProgress;\n';
vm.runInContext(combined, sandbox, { filename: 'combined.js' });

const computeCurrentAct = sandbox.__computeCurrentAct;
const updateActProgress = sandbox.__updateActProgress;

function makeGame(over) {
  return Object.assign({
    current_date: { day: 1, period: 'morning' },
    goals: [],
    completed_events: [],
    acts_log: [],
  }, over);
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name); }
}

console.log('=== ⑨ 章节/幕结构 引擎逻辑验证 ===');

// 场景1：全新世界 → 第一幕
sandbox.SANDBOX_GAME = makeGame({});
vm.runInContext('gameState = SANDBOX_GAME;', sandbox);
let a = computeCurrentAct();
check('全新世界判定为第一幕', a.act === 1 && a.title.indexOf('第一幕') === 0);

// 场景2：完成 1 个主线目标 → 第三幕
sandbox.SANDBOX_GAME = makeGame({ goals: [{ goal_id: 'g1', tier: 'main', status: 'completed' }] });
vm.runInContext('gameState = SANDBOX_GAME;', sandbox);
a = computeCurrentAct();
check('完成1主线 → 第三幕', a.act === 3);

// 场景3：完成 2 主线 → 第四幕
sandbox.SANDBOX_GAME = makeGame({ goals: [
  { goal_id: 'g1', tier: 'main', status: 'completed' },
  { goal_id: 'g2', tier: 'main', status: 'completed' } ] });
vm.runInContext('gameState = SANDBOX_GAME;', sandbox);
a = computeCurrentAct();
check('完成2主线 → 第四幕', a.act === 4);

// 场景4：完成 3 主线 → 终幕
sandbox.SANDBOX_GAME = makeGame({ goals: [
  { goal_id: 'g1', tier: 'main', status: 'completed' },
  { goal_id: 'g2', tier: 'main', status: 'completed' },
  { goal_id: 'g3', tier: 'main', status: 'completed' } ] });
vm.runInContext('gameState = SANDBOX_GAME;', sandbox);
a = computeCurrentAct();
check('完成3主线 → 终幕(5)', a.act === 5);

// 场景5：无主线但历经 6+ 事件 → 第二幕
sandbox.SANDBOX_GAME = makeGame({ completed_events: ['a','b','c','d','e','f','g'] });
vm.runInContext('gameState = SANDBOX_GAME;', sandbox);
a = computeCurrentAct();
check('6+事件无主线 → 第二幕', a.act === 2);

// 场景6：updateActProgress 跨幕记录 + 钉记忆
sandbox.SANDBOX_GAME = makeGame({ goals: [{ goal_id: 'g1', tier: 'main', status: 'completed' }] });
vm.runInContext('gameState = SANDBOX_GAME;', sandbox);
pinned.length = 0;
updateActProgress();
check('updateActProgress 写入 current_act', sandbox.SANDBOX_GAME.current_act && sandbox.SANDBOX_GAME.current_act.act === 3);
check('跨幕写入 acts_log', sandbox.SANDBOX_GAME.acts_log.length === 1 && sandbox.SANDBOX_GAME.acts_log[0].act === 3);
check('跨幕钉一条记忆', pinned.some(t => t.indexOf('第三幕') >= 0));

// 场景7：同一幕再次调用不重复记录
updateActProgress();
check('同幕不重复记录 acts_log', sandbox.SANDBOX_GAME.acts_log.length === 1);

// 场景8：再完成一主线，跨到第四幕，新增一条 + 钉新记忆
sandbox.SANDBOX_GAME.goals.push({ goal_id: 'g2', tier: 'main', status: 'completed' });
vm.runInContext('gameState = SANDBOX_GAME;', sandbox);
pinned.length = 0;
updateActProgress();
check('再跨幕 acts_log 增至2', sandbox.SANDBOX_GAME.acts_log.length === 2);
check('再跨幕钉新幕记忆', pinned.some(t => t.indexOf('第四幕') >= 0));

// 场景9：旧存档无 acts_log/current_act 不报错
sandbox.SANDBOX_GAME = { current_date: { day: 2, period: 'night' }, goals: [], completed_events: [] };
vm.runInContext('gameState = SANDBOX_GAME;', sandbox);
let threw = false;
try { updateActProgress(); } catch (e) { threw = true; }
check('旧存档缺字段不抛错', !threw && sandbox.SANDBOX_GAME.acts_log && sandbox.SANDBOX_GAME.acts_log.length === 1);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
