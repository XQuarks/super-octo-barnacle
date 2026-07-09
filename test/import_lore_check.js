/**
 * 一键导入 IP 设定 · 确定性校验（vm 沙箱加载真实源码，不耗 API）
 * 覆盖：
 *   1) 预设世界标记 preset=true（导入前需派生，保护 canon）
 *   2) mergeLoreSnippets 按 title 去重
 *   3) extractLoreFromText 模拟模式返回结构化片段
 *   4) ensureEditableWorld 预设派生 / 自定义不变
 *   5) confirmImportLore 全链路（预设自动派生 + merge + 清理 pending）
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
  _radio: { loreMode: 'append', loreCopyright: 'safe' },
  addEventListener(){}, removeEventListener(){},
  getElementById(id){
    if (!elCache[id]) {
      const el = fakeEl();
      if (id === 'mockMode') el.checked = true; // 测试走模拟模式
      if (id === 'baseUrl') el.value = 'https://api.deepseek.com';
      if (id === 'apiKey') el.value = 'test-key';
      if (id === 'modelName') el.value = 'deepseek-test';
      elCache[id] = el;
    }
    return elCache[id];
  },
  querySelector(sel){
    const m = String(sel).match(/input\[name="([^"]+)"\](?:\[value="([^"]+)"\])?/);
    if (!m) return null;
    const name = m[1], val = m[2];
    if (val) return { checked: docStub._radio[name] === val, value: val };
    return { value: docStub._radio[name], checked: true };
  },
  querySelectorAll(){ return []; }, createElement(){ return fakeEl(); }
};
const sandbox = {
  console, Math, Date, JSON,
  document: docStub,
  localStorage: { getItem(){ return null; }, setItem(){}, removeItem(){} },
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

  // 1) 预设世界标记
  const pw = buildPresetWorlds();
  ok('buildPresetWorlds 生成 8 个世界', pw.length === 8);
  ok('每个预设世界 preset === true', pw.every(function (w) { return w.preset === true; }));
  ok('预设 system_prompt 含 canon 硬约束', pw.every(function (w) { return /不可违背|硬约束|canon|core/.test(w.system_prompt); }));

  // 2) mergeLoreSnippets 去重
  const base = [{ id: 'a', category: '背景', title: '已有', content: 'x', keywords: ['x'] }];
  const incoming = [
    { category: '人物', title: '新人物', content: 'y', keywords: ['y'] },
    { category: '背景', title: '已有', content: 'z', keywords: ['z'] }, // 重复 title → 跳过
    { category: '事件', title: '新事件', content: 'w', keywords: ['w'] }
  ];
  const merged = mergeLoreSnippets(base, incoming);
  ok('merge 去重后共 3 条', merged.length === 3);
  ok('merge 保留原有片段', merged[0].title === '已有');
  ok('merge 新增两条', merged.some(function (s) { return s.title === '新人物'; }) && merged.some(function (s) { return s.title === '新事件'; }));
  ok('merge 跳过重复 title', !merged.some(function (s) { return s.content === 'z'; }));
  ok('merge 新片段自动生成 id', merged[1].id && merged[1].id.indexOf('imp_') === 0);
  ok('merge 空输入安全', mergeLoreSnippets(null, null).length === 0);

  // 3) extractLoreFromText 模拟模式
  const snips = await extractLoreFromText('这是一段测试原著文本，讲述了一个宏大的世界与其中对立的势力。', '测试世界');
  ok('mock 抽取值为数组且非空', Array.isArray(snips) && snips.length > 0);
  ok('mock 片段字段齐全', snips.every(function (s) { return s.category && s.title && s.content && Array.isArray(s.keywords); }));

  // 4) ensureEditableWorld：预设派生
  worlds = [];
  currentWorld = { id: 'demo_x', name: '原预设', preset: true, system_prompt: 'canon', lore_kb: { ip: 'x', snippets: [] } };
  const derived = ensureEditableWorld();
  ok('预设 world 触发派生', derived === true);
  ok('当前 world 切换为副本(preset=false)', currentWorld.preset === false);
  ok('副本名含「副本」', currentWorld.name.indexOf('副本') >= 0);
  ok('副本 id 与原 id 不同', currentWorld.id !== 'demo_x');
  ok('原 canon 被复制', currentWorld.system_prompt === 'canon');
  ok('worlds 新增副本', worlds.length === 1 && worlds[0].preset === false);

  // 5) ensureEditableWorld：自定义 world 不变
  worlds = [];
  currentWorld = { id: 'custom_y', name: '自定义', preset: false, lore_kb: { ip: 'y', snippets: [] } };
  const derived2 = ensureEditableWorld();
  ok('自定义 world 不派生', derived2 === false);
  ok('自定义 world 未被复制', worlds.length === 0 && currentWorld.id === 'custom_y');

  // 6) confirmImportLore 全链路（预设 → 自动派生 + merge）
  worlds = [];
  currentWorld = { id: 'demo_z', name: '预设Z', preset: true, system_prompt: 'canonZ', lore_kb: { ip: 'z', snippets: [{ id: 'old', category: '背景', title: '原有', content: 'o', keywords: ['o'] }] } };
  window.__pendingImportSnips = [{ category: '人物', title: '导入人物', content: 'c', keywords: ['k'] }];
  await confirmImportLore();
  ok('导入后知识库含导入片段', currentWorld.lore_kb.snippets.some(function (s) { return s.title === '导入人物'; }));
  ok('导入后保留原有片段', currentWorld.lore_kb.snippets.some(function (s) { return s.title === '原有'; }));
  ok('导入后预设已派生为副本', currentWorld.preset === false && currentWorld.id !== 'demo_z');
  ok('worlds 含派生副本', worlds.length === 1);
  ok('pending 已清理', window.__pendingImportSnips === null);

  // 7) splitLoreChunks 分块逻辑
  const shortText = '短文本不足一万字，无需分块。';
  ok('短文本返回单块', splitLoreChunks(shortText).length === 1);
  const longText = Array.from({ length: 30 }).map(function (_, i) {
    return '第' + i + '段：这是一段用于测试分块的长文本，包含一些设定内容与换行。\\n\\n';
  }).join('');
  const ch = splitLoreChunks(longText, 200);
  ok('长文本被分成多块', ch.length > 1);
  ok('分块数受 LORE_MAX_CHUNKS 限制(<=12)', ch.length <= LORE_MAX_CHUNKS);
  ok('每块长度不超过单块上限+余量', ch.every(function (c) { return c.length <= LORE_CHUNK_SIZE + 200; }));
  ok('块非空且无整段丢失', ch.join('').replace(/\s/g, '').length > longText.replace(/\s/g, '').length * 0.9);

  // 8) 长文 mock 抽取（强制小 chunkSize 触发分块）不崩溃 + 去重合并
  const manyChunks = await extractLoreFromText(longText, '长文测试', { chunkSize: 200, maxChunks: 12 });
  ok('长文 mock 抽取返回数组', Array.isArray(manyChunks));
  ok('长文 mock 抽取非空且不抛错', manyChunks.length >= 1);
  ok('长文分块抽取结果字段规整', manyChunks.every(function (s) { return s.id && s.category && s.title; }));

  // 9) 合并纯函数：覆盖同类 / 完全覆盖 / 规整
  const rb = replaceLoreByCategory(
    [{ category: '背景', title: '旧背景', content: 'o', keywords: ['o'] }, { category: '人物', title: '旧人物', content: 'o2', keywords: ['o'] }],
    [{ category: '人物', title: '新人物', content: 'n', keywords: ['n'] }]
  );
  ok('replaceLoreByCategory 移除同类旧片段', !rb.some(function (s) { return s.title === '旧人物'; }));
  ok('replaceLoreByCategory 保留其他类别', rb.some(function (s) { return s.title === '旧背景'; }));
  ok('replaceLoreByCategory 加入新片段', rb.some(function (s) { return s.title === '新人物'; }));
  const ow = overwriteLoreSnippets([{ category: '背景', title: '被清掉', content: 'z' }]);
  ok('overwriteLoreSnippets 忽略 base', ow.length === 1 && ow[0].title === '被清掉' && ow[0].id && ow[0].id.indexOf('imp_') === 0);
  const nm = normalizeLoreSnippets([{ title: 'N', category: '人物', content: 'c' }]);
  ok('normalizeLoreSnippets 自动补 id', nm.length === 1 && nm[0].id.indexOf('imp_') === 0);
  ok('normalizeLoreSnippets 过滤无标题项', normalizeLoreSnippets([{ category: 'x' }, null]).length === 0);

  // 10) confirmImportLore · 覆盖同类分支（经 radio 切换）
  worlds = [];
  currentWorld = { id: 'c_cat', name: '自定义C', preset: false, lore_kb: { ip: 'c', snippets: [
    { category: '背景', title: '旧背景', content: 'o1', keywords: ['o'] },
    { category: '人物', title: '旧人物', content: 'o2', keywords: ['o'] }
  ] } };
  document._radio.loreMode = 'category'; document._radio.loreCopyright = 'safe';
  window.__pendingImportSnips = [
    { category: '人物', title: '新人物', content: 'n', keywords: ['n'] },
    { category: '事件', title: '新事件', content: 'e', keywords: ['e'] }
  ];
  await confirmImportLore();
  ok('覆盖同类：旧背景保留', currentWorld.lore_kb.snippets.some(function (s) { return s.title === '旧背景'; }));
  ok('覆盖同类：旧人物被移除', !currentWorld.lore_kb.snippets.some(function (s) { return s.title === '旧人物'; }));
  ok('覆盖同类：新人物加入', currentWorld.lore_kb.snippets.some(function (s) { return s.title === '新人物'; }));
  ok('覆盖同类：新事件加入', currentWorld.lore_kb.snippets.some(function (s) { return s.title === '新事件'; }));
  ok('覆盖同类：版权标记为 safe/local_only=false', currentWorld.lore_copyright === 'safe' && currentWorld.local_only === false);

  // 11) confirmImportLore · 完全覆盖分支
  worlds = [];
  currentWorld = { id: 'c_ov', name: '自定义O', preset: false, lore_kb: { ip: 'o', snippets: [
    { category: '背景', title: 'A', content: 'a' }, { category: '人物', title: 'B', content: 'b' }
  ] } };
  document._radio.loreMode = 'overwrite'; document._radio.loreCopyright = 'safe';
  window.__pendingImportSnips = [{ category: '地点', title: '新地点', content: 'x', keywords: ['x'] }];
  await confirmImportLore();
  ok('完全覆盖后仅 1 条', currentWorld.lore_kb.snippets.length === 1);
  ok('完全覆盖后仅含新片段', currentWorld.lore_kb.snippets[0].title === '新地点');

  // 12) confirmImportLore · 受版权标记分支
  worlds = [];
  currentWorld = { id: 'c_cr', name: '自定义R', preset: false, lore_kb: { ip: 'r', snippets: [] } };
  document._radio.loreMode = 'append'; document._radio.loreCopyright = 'copyrighted';
  window.__pendingImportSnips = [{ category: '人物', title: '版权人物', content: 'c', keywords: ['k'] }];
  await confirmImportLore();
  ok('受版权 lore_copyright=copyrighted', currentWorld.lore_copyright === 'copyrighted');
  ok('受版权 local_only=true', currentWorld.local_only === true);
  ok('受版权片段仍成功导入', currentWorld.lore_kb.snippets.some(function (s) { return s.title === '版权人物'; }));

  console.log('\\n==== 一键导入 IP 设定测试 ====');
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
}, 300);
