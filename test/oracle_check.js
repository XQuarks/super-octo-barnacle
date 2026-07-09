'use strict';
/* 预言机逻辑确定性校验：加载真实 app-core+app-ai，验证开关/混沌因子行为（不耗 API）。
   用法：node test/oracle_check.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = 'C:/Users/guoxiaoyan/WorkBuddy/C项目';

const coreSrc = fs.readFileSync(path.join(ROOT, 'js', 'app-core.js'), 'utf8');
const aiSrc = fs.readFileSync(path.join(ROOT, 'js', 'app-ai.js'), 'utf8');
const SYSTEM_TEMPLATE = fs.readFileSync(path.join(ROOT, 'data', 'system_prompt_template.md'), 'utf8');

function makeWorld(oracle) {
  return {
    id: 't', name: '测试界', ruleset_type: 'dnd',
    desc: '测试', hero: '你', world_freedom: 3,
    lore_kb: { snippets: [] }, pinned_facts: [], behavior_records: [],
    oracle
  };
}
const gameState = { name: 'x', current_location: '村口', current_date: { year: 1, month: 1, day: 1, period: '清晨' }, relationships: {}, npc_states: {}, status_effects: [], is_alive: true, reputation: 0, tension: 0, inventory: [], goals: [], skills: {}, attributes: {}, combat_stats: { in_combat: false } };

const sandbox = {
  console, fetch: globalThis.fetch, setTimeout, clearTimeout, crypto: globalThis.crypto,
  Intl, JSON, Date, Math, AbortController, TextEncoder, TextDecoder,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  document: { getElementById: () => ({ value: '', textContent: '', style: {} }), addEventListener: () => {} },
  window: {},
  getTemperature: () => 0.5, updateCacheIndicator: () => {}, logTurnStats: () => {}, scheduleSaveWorlds: () => {}, saveWorlds: () => {},
  SANDBOX_WORLD: makeWorld(undefined), SANDBOX_GAME: gameState, SANDBOX_TPL: SYSTEM_TEMPLATE,
  SANDBOX_LORE: {}, SANDBOX_RULESETS: JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'rulesets.json'), 'utf8'))
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
// 仅 stub app-ui.js 中的 getWorldSchema（其余函数均真实存在于 app-ai.js）
const assignSrc = `
currentWorld = SANDBOX_WORLD;
gameState = SANDBOX_GAME;
systemPromptTemplate = SANDBOX_TPL;
loreKB = SANDBOX_LORE;
rulesets = SANDBOX_RULESETS;
function getWorldSchema(w){ return { type:(w&&w.ruleset_type)||"unknown", schema_version:1 }; }
`;
vm.runInContext(coreSrc + '\n' + aiSrc + '\n' + assignSrc, sandbox, { filename: 'combined.js' });

function setWorld(w) {
  sandbox.SANDBOX_WORLD = w;
  vm.runInContext('currentWorld = SANDBOX_WORLD;', sandbox);
  // 真实产品按 world id 缓存 system prompt；测试中切世界需清缓存，避免场景间污染
  vm.runInContext('if (typeof invalidateSystemPromptCache === "function") invalidateSystemPromptCache();', sandbox);
}

let pass = true;
function check(name, cond) { console.log((cond ? '✅' : '❌') + ' ' + name); if (!cond) pass = false; }

// 场景1：关闭预言机
setWorld(makeWorld({ enabled: false, chaos_factor: 5 }));
let sys1 = sandbox.buildSystemPrompt();
let u1 = sandbox.buildTurnUserMessage('玩家走进酒馆', []);
check('关闭：system 含"纯爽文"', sys1.includes('纯爽文'));
check('关闭：system 不含"混沌因子 5/9"启用说明', !sys1.includes('混沌因子 5/9'));
check('关闭：user message 不含"# 预言机"段', !u1.includes('# 预言机'));

// 场景2：开启 cf=9 且随机命中(0)
const realRandom = Math.random;
Math.random = () => 0;
setWorld(makeWorld({ enabled: true, chaos_factor: 9 }));
let sys2 = sandbox.buildSystemPrompt();
let u2 = sandbox.buildTurnUserMessage('玩家走进酒馆', []);
check('开启：system 含"混沌因子 9/9"', sys2.includes('混沌因子 9/9'));
check('开启(cf=9,命中)：user 含"本回合触发随机事件"', u2.includes('本回合触发随机事件'));
Math.random = realRandom;

// 场景3：开启 cf=5 但随机不命中(0.99)
Math.random = () => 0.99;
setWorld(makeWorld({ enabled: true, chaos_factor: 5 }));
let u3 = sandbox.buildTurnUserMessage('玩家走进酒馆', []);
check('开启(cf=5,不命中)：user 含"不触发额外随机事件"', u3.includes('不触发额外随机事件'));
Math.random = realRandom;

// 场景4：旧世界无 oracle 字段 → 默认启用 cf=5（兼容）
setWorld(makeWorld(undefined));
let sys4 = sandbox.buildSystemPrompt();
let u4 = sandbox.buildTurnUserMessage('玩家走进酒馆', []);
check('兼容：无 oracle 字段时默认启用（system 含混沌因子）', sys4.includes('混沌因子 5/9'));
check('兼容：无 oracle 字段时默认注入预言机段', u4.includes('# 预言机'));

console.log('\n========== 预言机校验:', pass ? 'PASS ✅' : 'FAIL ❌', '==========');
process.exit(pass ? 0 : 1);
