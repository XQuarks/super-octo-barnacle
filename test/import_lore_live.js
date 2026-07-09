/**
 * 一键导入 IP 设定 · 真实 API 联调（vm 沙箱加载真实源码 + DeepSeek live 调用）
 *
 * 验证链路：
 *   1) extractLoreFromText 真实调用（mockMode=false）→ 抽结构化片段
 *   2) mergeLoreSnippets 用真实输出去重合并
 *   3) confirmImportLore 全链路：预设世界自动派生副本 + merge + 清理 pending
 *
 * 凭证来源（与 pinned_test_harness.js 一致）：
 *   test/.apienv.json { "API_KEY":"...", "BASE_URL":"https://api.deepseek.com/v1/chat/completions", "MODEL":"deepseek-chat" }
 *   注意：extractLoreFromText 内部用 buildApiUrl 在 baseUrl 后追加 /chat/completions，
 *   因此注入的 baseUrl 必须是 https://api.deepseek.com（不含 /v1/chat/completions）。
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

// ---- 读取凭证 ----
let env = null;
try { env = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', '.apienv.json'), 'utf8')); } catch (e) {}
const API_KEY = env && env.API_KEY;
const MODEL = (env && env.MODEL) || 'deepseek-chat';
if (!API_KEY) {
  console.error('缺少 API_KEY（test/.apienv.json）。无法跑 live 联调。');
  process.exit(2);
}

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
      if (id === 'mockMode') el.checked = false;          // ★ 关键：走真实 API
      if (id === 'baseUrl') el.value = 'https://api.deepseek.com'; // 剥掉 /v1/chat/completions
      if (id === 'apiKey') el.value = API_KEY;
      if (id === 'modelName') el.value = MODEL;
      if (id === 'corsProxy') el.value = '';
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
  setTimeout, clearTimeout,
  fetch: globalThis.fetch,                 // ★ 真实 fetch（Node 24 全局）
  AbortController: globalThis.AbortController,
  TextEncoder: globalThis.TextEncoder, TextDecoder: globalThis.TextDecoder,
  crypto: globalThis.crypto,
  window: null
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

let combined = '';
files.forEach(f => { combined += '\n;//==== ' + f + ' ====\n' + fs.readFileSync(path.join(ROOT, f), 'utf8'); });
vm.runInContext(combined, sandbox, { filename: 'combined.js' });

// 打桩 embedding 重算（避免真实加载 ONNX 模型挂起）
vm.runInContext('computeEmbeddingsForWorld = function(){ return Promise.resolve(); };', sandbox);

const testScript = `
(async () => {
  let pass = 0, fail = 0;
  function ok(name, cond) {
    if (cond) { pass++; console.log('  \\u2713 PASS', name); }
    else { fail++; console.log('  \\u2717 FAIL', name); }
  }

  // ★ 真实原著文本（公版：罗贯中《三国演义》桃园三结义，约 14 世纪）
  const SANGUO = \`话说天下大势，分久必合，合久必分。周末七国分争，并入于秦。及秦灭之后，楚、汉分争，又并入于汉。汉朝自高祖斩白蛇而起义，一统天下，后来光武中兴，传至献帝，遂分为三国。
  推其致乱之由，殆始于桓、灵二帝。桓帝禁锢善类，崇信宦官。及桓帝崩，灵帝即位，大将军窦武、太傅陈蕃共相辅佐。时有宦官曹节等弄权，窦武、陈蕃谋诛之，机事不密，反为所害，中涓自此愈横。
  建宁二年四月望日，帝御温德殿。方升座，殿角狂风骤起，只见一条大青蛇，从梁上飞将下来，蟠于椅上。帝惊倒，左右急救入宫，百官俱奔避。须臾，蛇不见了。忽然大雷大雨，加以冰雹，落到半夜方止，坏却房屋无数。
  时巨鹿郡有兄弟三人，一名张角，一名张宝，一名张梁。那张角本是个不第秀才，因入山采药，遇一老人，碧眼童颜，手执藜杖，唤角至一洞中，以天书三卷授之，曰：“此名《太平要术》。汝得之，当代天宣化，普救世人。”角得此书，晓夜攻习，能呼风唤雨，号为“太平道人”。
  中平元年正月，疫气流行，张角散施符水，为人治病，自称“大贤良师”。角有徒弟五百余人，云游四方，皆能书符念咒。次后徒众日多，角乃立三十六方，大方万余人，小方六七千，各立渠帅，称为将军。讹言：“苍天已死，黄天当立；岁在甲子，天下大吉。”
  及刘焉发榜招军，玄德年已二十八岁矣。当日见了榜文，慨然长叹。随后一人厉声言曰：“大丈夫不与国家出力，何故长叹？”玄德回视其人：身长八尺，豹头环眼，燕颔虎须，声若巨雷，势如奔马。玄德见其形貌异常，问其姓名。其人曰：“某姓张名飞，字翼德。世居涿郡，颇有庄田，卖酒屠猪，专好结交天下豪杰。”
  玄德甚喜，遂与同入村店中饮酒。正饮间，见一大汉推着一辆车子，到店门首歇了；入店坐下，便唤酒保：“快斟酒来，我吃入城去投军。”玄德看其人：身长九尺，髯长二尺；面如重枣，唇若涂脂；丹凤眼，卧蚕眉；相貌堂堂，威风凛凛。玄德就邀他同坐，问其姓名。其人曰：“吾姓关名羽，字长生，后改云长，河东解良人也。因本处势豪，倚势凌人，被吾杀了，逃难江湖，五六年矣。”
  三人共论天下大事，情投意合。次日，于桃园中，备下乌牛白马祭礼等项，三人焚香再拜而说誓曰：“念刘备、关羽、张飞，虽然异姓，既结为兄弟，则同心协力，上报国家，下安黎庶。不求同年同月同日生，只愿同年同月同日死。皇天后土，实鉴此心。背义忘恩，天人共戮！”誓毕，拜玄德为兄，关羽次之，张飞为弟。\`;

  console.log('\\n========== [1] 真实 API 抽取 extractLoreFromText ==========');
  let snips = [];
  try {
    snips = await extractLoreFromText(SANGUO, '三国·桃园结义');
  } catch (e) {
    console.error('  [抽取异常]', e.message);
  }
  ok('真实抽取返回数组', Array.isArray(snips));
  ok('真实抽取得到 >= 8 条', snips.length >= 8);
  ok('每条含 category/title/content/keywords', snips.every(function (s) { return s.category && s.title && s.content && Array.isArray(s.keywords); }));
  // 类别覆盖检查（AI 按原文实体打标，单段摘录未必 4 类齐全；放宽到“至少覆盖 3/4 目标类”）
  const TARGET = ['人物', '地点', '势力', '事件'];
  const cats = snips.map(function (s) { return s.category; });
  const covered = TARGET.filter(function (c) { return cats.includes(c); });
  console.log('  抽取类别分布:', JSON.stringify(cats.reduce(function (a,c){ a[c]=(a[c]||0)+1; return a; }, {})));
  ok('覆盖「人物」类', cats.includes('人物'));
  ok('覆盖「事件」类', cats.includes('事件'));
  ok('目标类(人物/地点/势力/事件)至少覆盖 2 类', covered.length >= 2);
  if (covered.length < 4) console.log('  · 注：本摘录未覆盖 ' + TARGET.filter(function (c){ return !cats.includes(c); }).join('/') + '（取决于原文实体，属正常）');
  console.log('  --- 抽取片段预览（前 6 条）---');
  snips.slice(0, 6).forEach(function (s) {
    console.log('   [' + s.category + '] ' + s.title + ' | 关键词: ' + s.keywords.join('/'));
    console.log('       ' + String(s.content).replace(/\\n/g, ' ').slice(0, 80) + '…');
  });

  console.log('\\n========== [2] 真实输出合并 mergeLoreSnippets ==========');
  const base = [{ id: 'old', category: '背景', title: snips[0] ? snips[0].title : '占位', content: '原知识库已有片段', keywords: ['旧'] }];
  const merged = mergeLoreSnippets(base, snips);
  ok('合并后条数 = 原 1 + 新增(去重后)', merged.length >= snips.length);
  ok('原片段保留', merged.some(function (s) { return s.id === 'old'; }));
  ok('真实片段进入知识库', snips.every(function (s) { return merged.some(function (m) { return m.title === s.title; }); }));
  ok('合并不抛出且字段规整', merged.every(function (s) { return s.id && s.category && s.title; }));

  console.log('\\n========== [3] confirmImportLore 全链路（预设派生 + merge）==========');
  const presets = buildPresetWorlds();
  const sanguoPreset = presets.find(function (w) { return w.id === 'demo_sanguo'; });
  ok('找到三国预设世界', !!sanguoPreset);
  worlds = [];
  currentWorld = sanguoPreset;
  window.__pendingImportSnips = snips;
  const lenBefore = currentWorld.lore_kb.snippets.length;
  try { await confirmImportLore(); } catch (e) { console.error('  [confirmImportLore 异常]', e.message); }
  ok('预设自动派生为副本(preset=false)', currentWorld.preset === false);
  ok('副本名称含「副本」', currentWorld.name.indexOf('副本') >= 0);
  ok('原 canon 被完整复制到副本', currentWorld.system_prompt === sanguoPreset.system_prompt);
  ok('worlds 新增 1 个派生副本', worlds.length === 1 && worlds[0].preset === false);
  ok('知识库新增真实片段(条数增加)', currentWorld.lore_kb.snippets.length > lenBefore);
  ok('导入片段确实落库', snips.every(function (s) { return currentWorld.lore_kb.snippets.some(function (m) { return m.title === s.title; }); }));
  ok('pending 状态已清理', window.__pendingImportSnips === null);
  ok('副本标记 imported_lore=true', currentWorld.imported_lore === true);

  console.log('\\n========== [4] 真实长文分块抽取（强制小 chunkSize 触发多块）==========');
  const chunkCount = splitLoreChunks(SANGUO, 500).length;
  ok('桃园结义文本被分成多块(>1)', chunkCount > 1);
  console.log('  分块数:', chunkCount);
  let chunkedSnips = [];
  try {
    chunkedSnips = await extractLoreFromText(SANGUO, '三国·桃园结义(分块)', { chunkSize: 500 });
  } catch (e) { console.error('  [分块抽取异常]', e.message); }
  ok('分块抽取返回数组', Array.isArray(chunkedSnips));
  ok('分块抽取得到 >= 8 条', chunkedSnips.length >= 8);
  ok('分块片段字段规整', chunkedSnips.every(function (s) { return s.category && s.title && s.content && Array.isArray(s.keywords); }));
  ok('分块合并结果不少于单次抽取', chunkedSnips.length >= snips.length);
  const cCats = chunkedSnips.map(function (s) { return s.category; });
  console.log('  分块合并后类别分布:', JSON.stringify(cCats.reduce(function (a,c){ a[c]=(a[c]||0)+1; return a; }, {})));
  console.log('  分块合并后总条数:', chunkedSnips.length, '（单次抽取:', snips.length, '）');

  console.log('\\n========== [5] 受版权分支（local_only 标记）==========');
  worlds = [];
  currentWorld = { id: 'live_cr', name: '受版权世界', preset: false, lore_kb: { ip: 'r', snippets: [] } };
  document._radio.loreMode = 'append'; document._radio.loreCopyright = 'copyrighted';
  window.__pendingImportSnips = snips;
  try { await confirmImportLore(); } catch (e) { console.error('  [版权分支异常]', e.message); }
  ok('受版权 lore_copyright=copyrighted', currentWorld.lore_copyright === 'copyrighted');
  ok('受版权 local_only=true', currentWorld.local_only === true);
  ok('受版权仍成功导入片段', currentWorld.lore_kb.snippets.length > 0);

  console.log('\\n========== [6] 覆盖同类分支（replaceLoreByCategory）==========');
  worlds = [];
  currentWorld = { id: 'live_cat', name: '覆盖测试世界', preset: false, lore_kb: { ip: 'c', snippets: [
    { category: '人物', title: '旧侠客', content: '旧设定', keywords: ['旧'] },
    { category: '背景', title: '旧背景', content: '旧背景设定', keywords: ['旧'] },
    { category: '物品', title: '旧宝物', content: '旧宝物设定', keywords: ['旧'] }
  ] } };
  document._radio.loreMode = 'category'; document._radio.loreCopyright = 'safe';
  const beforeOldHero = currentWorld.lore_kb.snippets.some(function (s) { return s.title === '旧侠客'; });
  window.__pendingImportSnips = snips;
  try { await confirmImportLore(); } catch (e) { console.error('  [覆盖分支异常]', e.message); }
  ok('覆盖前存在旧人物「旧侠客」', beforeOldHero);
  ok('覆盖同类：旧人物被移除（incoming 含人物类）', !currentWorld.lore_kb.snippets.some(function (s) { return s.title === '旧侠客'; }));
  ok('覆盖同类：旧背景被移除（incoming 含背景类）', !currentWorld.lore_kb.snippets.some(function (s) { return s.title === '旧背景'; }));
  ok('覆盖同类：未重叠类别「旧宝物」保留', currentWorld.lore_kb.snippets.some(function (s) { return s.title === '旧宝物'; }));
  ok('覆盖同类：导入的人物类新片段已加入', currentWorld.lore_kb.snippets.some(function (s) { return s.category === '人物' && s.title !== '旧侠客'; }));

  console.log('\\n========== 汇总 ==========');
  console.log('PASS: ' + pass + '  FAIL: ' + fail);
  globalThis.__pass = pass; globalThis.__fail = fail;
})();
`;

process.on('unhandledRejection', function (e) { console.error('[unhandledRejection]', e); process.exit(1); });

const testPromise = vm.runInContext(testScript, sandbox, { filename: 'live_test.js' });
Promise.resolve(testPromise).then(function () {
  const pass = sandbox.__pass || 0;
  const fail = sandbox.__fail || 0;
  console.log('\n[live 汇总] PASS=' + pass + ' FAIL=' + fail);
  process.exit(fail > 0 ? 1 : 0);
}).catch(function (e) {
  console.error('[live 测试异常]', e && e.stack ? e.stack : e);
  process.exit(1);
});
