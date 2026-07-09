/**
 * 玩家世界书（手动策展）· 确定性校验（vm 沙箱加载真实源码，不耗 API）
 * 覆盖：
 *   1) 纯函数 addLoreSnippet / updateLoreSnippet / removeLoreSnippet
 *   2) 纯函数 upsertPinnedFact / removePinnedFact（常量记忆）
 *   3) 预设世界打开世界书 → ensureEditableWorld 自动派生（保护 canon）
 *   4) 自定义世界：新增 / 编辑 / 删除 lore 片段（经 wbSaveEditor 全链路 + 落库）
 *   5) 自定义世界：新增 / 编辑 / 删除常量记忆（pinned fact）
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
    if (!elCache[id]) {
      const el = fakeEl();
      // 世界书编辑表单：预设可解析的输入值
      if (id === 'wbCat') el.value = '人物';
      if (id === 'wbTitle') el.value = '';
      if (id === 'wbContent') el.value = '';
      if (id === 'wbKw') el.value = '';
      if (id === 'wbFactText') el.value = '';
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

// 中性化外部副作用 + 打桩 embedding 重算（避免真实耗 API）
vm.runInContext('saveState = function(){}; updateGameDayInfo = function(){};', sandbox);
vm.runInContext('computeEmbeddingsForWorld = function(){ return Promise.resolve(); };', sandbox);

const testScript = `
(async () => {
  let pass = 0, fail = 0;
  function ok(name, cond) {
    if (cond) { pass++; console.log('  PASS \\u2713', name); }
    else { fail++; console.log('  FAIL \\u2717', name); }
  }

  // ===== A) 纯函数：lore 增删改 =====
  const baseLore = [{ id: 'a', category: '背景', title: '已有', content: 'x', keywords: ['x'] }];
  const added = addLoreSnippet(baseLore, { category: '人物', title: '新人物', content: 'y', keywords: 'y,z' });
  ok('addLoreSnippet 新增一条', added.length === 2);
  ok('addLoreSnippet 自动补 id', !!added[1].id && added[1].id.indexOf('imp_') === 0);
  ok('addLoreSnippet 规整 keywords 为数组', Array.isArray(added[1].keywords) && added[1].keywords.length === 2);
  const dup = addLoreSnippet(baseLore, { category: '事件', title: '已有', content: 'z' });
  ok('addLoreSnippet 同标题去重(不新增)', dup.length === 1);
  ok('addLoreSnippet 无标题项被忽略', addLoreSnippet([], { category: 'x' }).length === 0);

  const upd = updateLoreSnippet(baseLore, 'a', { title: '改名', category: '物品', content: 'c2' });
  ok('updateLoreSnippet 改标题', upd[0].title === '改名');
  ok('updateLoreSnippet 改类别', upd[0].category === '物品');
  ok('updateLoreSnippet 保留原 id', upd[0].id === 'a');
  ok('updateLoreSnippet 不存在的 id 安全', updateLoreSnippet(baseLore, 'nope', { title: 'x' }).length === 1);

  const rem = removeLoreSnippet(baseLore, 'a');
  ok('removeLoreSnippet 删除指定条', rem.length === 0);
  ok('removeLoreSnippet 不存在 id 安全', removeLoreSnippet([], 'x').length === 0);

  // ===== B) 纯函数：常量记忆 增删改 =====
  const baseFact = [{ id: 'f1', text: '旧事实', status: 'active', source: 'ai' }];
  const fAdded = upsertPinnedFact(baseFact, { text: '新事实', source: 'manual' });
  ok('upsertPinnedFact 新增一条', fAdded.length === 2);
  ok('upsertPinnedFact 新项 source=manual/status=active', fAdded[1].source === 'manual' && fAdded[1].status === 'active');
  const fDup = upsertPinnedFact(baseFact, { text: '旧事实' });
  ok('upsertPinnedFact 同文本 active 去重', fDup.length === 1);
  const fEdit = upsertPinnedFact(baseFact, { id: 'f1', text: '改后事实' });
  ok('upsertPinnedFact 按 id 编辑', fEdit[0].text === '改后事实' && fEdit.length === 1);
  const fRem = removePinnedFact(baseFact, 'f1');
  ok('removePinnedFact 删除指定项', fRem.length === 0);

  // ===== C) 预设世界打开世界书 → 自动派生（保护 canon）=====
  worlds = [];
  currentWorld = buildPresetWorlds()[0]; // preset === true
  const canonBefore = currentWorld.system_prompt;
  openWorldBookModal();
  ok('预设打开世界书自动派生副本', currentWorld.preset === false);
  ok('副本名含「副本」', currentWorld.name.indexOf('副本') >= 0);
  ok('原 canon 被复制到副本', currentWorld.system_prompt === canonBefore);
  ok('worlds 含派生副本', worlds.length === 1 && worlds[0].preset === false);

  // ===== D) 自定义世界：lore 新增 / 编辑 / 删除（全链路 + 落库）=====
  currentWorld = { id: 'wb1', name: '世界书测试', preset: false, lore_kb: { ip: '世界书测试', snippets: [] }, pinned_facts: [] };
  worlds = [currentWorld];
  // 新增
  window.__wbEdit = { type: 'lore' };
  document.getElementById('wbCat').value = '人物';
  document.getElementById('wbTitle').value = '手动片段';
  document.getElementById('wbContent').value = '这是一段手动添加的知识片段内容。';
  document.getElementById('wbKw').value = 'A,B';
  await wbSaveEditor();
  ok('新增 lore 片段', currentWorld.lore_kb.snippets.length === 1);
  ok('新增 lore 字段规整', currentWorld.lore_kb.snippets[0].category === '人物' && currentWorld.lore_kb.snippets[0].keywords.length === 2);
  ok('新增 lore 标记 manual_lore', currentWorld.manual_lore === true);
  ok('新增 lore 已落库', (function(){ const w = JSON.parse(localStorage.getItem('octo_worlds')); return w && w.some(function(x){ return x.id === 'wb1' && x.lore_kb.snippets.length === 1; }); })());
  // 编辑
  const lid = currentWorld.lore_kb.snippets[0].id;
  window.__wbEdit = { type: 'lore', id: lid };
  document.getElementById('wbCat').value = '地点';
  document.getElementById('wbTitle').value = '改后标题';
  document.getElementById('wbContent').value = '改后内容';
  document.getElementById('wbKw').value = 'X';
  await wbSaveEditor();
  ok('编辑 lore 标题更新', currentWorld.lore_kb.snippets[0].title === '改后标题');
  ok('编辑 lore 类别更新', currentWorld.lore_kb.snippets[0].category === '地点');
  ok('编辑 lore 条数不变', currentWorld.lore_kb.snippets.length === 1);
  ok('编辑 lore 保留 id', currentWorld.lore_kb.snippets[0].id === lid);
  // 删除
  wbDeleteLore(lid);
  ok('删除 lore 后为空', currentWorld.lore_kb.snippets.length === 0);
  // 空标题保护
  window.__wbEdit = { type: 'lore' };
  document.getElementById('wbTitle').value = '   ';
  document.getElementById('wbContent').value = 'x';
  await wbSaveEditor();
  ok('空标题不创建片段', currentWorld.lore_kb.snippets.length === 0);

  // ===== E) 自定义世界：常量记忆 新增 / 编辑 / 删除 =====
  window.__wbEdit = { type: 'fact' };
  document.getElementById('wbFactText').value = '主角的剑永不锈蚀';
  await wbSaveEditor();
  ok('新增 fact', currentWorld.pinned_facts.length === 1 && currentWorld.pinned_facts[0].text === '主角的剑永不锈蚀');
  ok('新增 fact 标记 manual_fact', currentWorld.manual_fact === true);
  const fid = currentWorld.pinned_facts[0].id;
  window.__wbEdit = { type: 'fact', id: fid };
  document.getElementById('wbFactText').value = '主角不朽';
  await wbSaveEditor();
  ok('编辑 fact 文本更新', currentWorld.pinned_facts[0].text === '主角不朽' && currentWorld.pinned_facts.length === 1);
  wbDeleteFact(fid);
  ok('删除 fact 后为空', currentWorld.pinned_facts.length === 0);
  // 空事实保护
  window.__wbEdit = { type: 'fact' };
  document.getElementById('wbFactText').value = '';
  await wbSaveEditor();
  ok('空事实不创建', currentWorld.pinned_facts.length === 0);

  console.log('\\n==== 玩家世界书测试 ====');
  console.log('PASS: ' + pass + '  FAIL: ' + fail);
  globalThis.__pass = pass; globalThis.__fail = fail;
})();
`;

vm.runInContext(testScript, sandbox, { filename: 'test.js' });

setTimeout(function () {
  const pass = sandbox.__pass || 0;
  const fail = sandbox.__fail || 0;
  console.log('\n[汇总] PASS=' + pass + ' FAIL=' + fail);
  process.exit(fail > 0 ? 1 : 0);
}, 500);
