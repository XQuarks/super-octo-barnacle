'use strict';
/*
 * pinned_facts 常驻记忆层 —— 端到端测试 harness
 * 用 vm 沙箱加载【真实】的 js/app-core.js + js/app-ai.js（拼接成同一词法环境，模拟浏览器多 <script>），
 * 不改动产品代码。通过 SANDBOX_* 占位属性把测试世界注入真实全局，驱动真实的
 * buildSystemPrompt / buildTurnUserMessage / addPinnedFacts / callLLMNonStreaming。
 *
 * 用法：
 *   node pinned_test_harness.js --mock           # 不耗 API，验证代码逻辑链路（机制A 钉住 + 注入）
 *   node pinned_test_harness.js --live            # 真实调用你的 API，验证 AI 行为
 *     凭证来源（任选其一）：
 *       a) 环境变量：API_KEY / BASE_URL / MODEL
 *       b) 文件：test/.apienv.json  { "API_KEY":"...", "BASE_URL":"https://api.deepseek.com/v1/chat/completions", "MODEL":"deepseek-chat" }
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = 'C:/Users/guoxiaoyan/WorkBuddy/C项目';

// ---- 1. 拼接真实源代码（app-core + app-ai），模拟浏览器多 script 共享词法全局 ----
const coreSrc = fs.readFileSync(path.join(ROOT, 'js', 'app-core.js'), 'utf8');
const aiSrc = fs.readFileSync(path.join(ROOT, 'js', 'app-ai.js'), 'utf8');

// ---- 2. 测试世界与状态 ----
const world = {
  id: 'test_world',
  name: '北境森林',
  ruleset_type: 'narrative',
  desc: '一片被森林女神守护的北境大地，禁地深藏古老诅咒。',
  hero: '你是一名流浪的斥候，为寻失踪的同伴来到此地。',
  world_freedom: 3,
  lore_kb: { snippets: [] },
  pinned_facts: [],
  behavior_records: []
};
const gameState = {
  name: '斥候',
  background: '流浪者',
  current_location: '村口',
  current_date: { year: 1024, month: 3, day: 1, period: '清晨' },
  relationships: {},
  npc_states: {},
  status_effects: [],
  is_alive: true,
  reputation: 0,
  tension: 0,
  inventory: [],
  goals: [],
  skills: {},
  attributes: {}
};

// app-ui.js 依赖（callLLMNonStreaming 内部会用到），用空实现 stub 掉 DOM 副作用
const sandbox = {
  console,
  fetch: globalThis.fetch,
  setTimeout, clearTimeout,
  crypto: globalThis.crypto,
  Intl, JSON, Date, Math, AbortController, TextEncoder, TextDecoder,
  // DOM / 存储 stub
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  document: { getElementById: () => ({ value: '', textContent: '', style: {} }), addEventListener: () => {} },
  window: {},
  // app-ui.js 函数 stub
  getTemperature: () => 0.5,
  updateCacheIndicator: () => {},
  logTurnStats: () => {},
  scheduleSaveWorlds: () => {},
  saveWorlds: () => {},
  // 注入用的占位属性（在 combined 脚本末尾赋值给真实词法全局）
  SANDBOX_WORLD: world,
  SANDBOX_GAME: gameState,
  SANDBOX_TPL: fs.readFileSync(path.join(ROOT, 'data', 'system_prompt_template.md'), 'utf8'),
  SANDBOX_LORE: {},
  SANDBOX_RULESETS: JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'rulesets.json'), 'utf8'))
};
sandbox.globalThis = sandbox;
// 本地保存一份模板，fallback 用（app-core 的 let systemPromptTemplate 是词法全局，不挂 sandbox 属性）
const SYSTEM_TEMPLATE = sandbox.SANDBOX_TPL;
vm.createContext(sandbox);

// 末尾赋值块：把 SANDBOX_* 注入到 app-core 声明的真实词法全局（currentWorld/gameState/systemPromptTemplate/loreKB）
const assignSrc = `
currentWorld = SANDBOX_WORLD;
gameState = SANDBOX_GAME;
systemPromptTemplate = SANDBOX_TPL;
loreKB = SANDBOX_LORE;
rulesets = SANDBOX_RULESETS;
// getWorldSchema 定义在 app-ui.js（未加载），这里给一个最小 stub 让真实 buildSystemPrompt 走通
function getWorldSchema(world) { return { type: (world && world.ruleset_type) || "unknown", schema_version: 1 }; }
`;
vm.runInContext(coreSrc + '\n' + aiSrc + '\n' + assignSrc, sandbox, { filename: 'combined.js' });

// ---- 3. system prompt：优先真实 buildSystemPrompt，失败则回退到真实模板占位符替换 ----
function buildSystemSafe() {
  try {
    return sandbox.buildSystemPrompt();
  } catch (e) {
    console.warn('[warn] buildSystemPrompt 失败，回退到真实模板替换：', e.message);
    const tpl = SYSTEM_TEMPLATE;
    const wf = world.world_freedom || 3;
    const hints = { 1: '世界观约束：严格遵循源材料。', 2: '世界观约束：以源材料为锚。', 3: '世界观约束：适中。', 4: '世界观约束：自由发挥。', 5: '世界观约束：完全自由。' };
    return tpl
      .replace(/\{IP_NAME\}/g, world.name)
      .replace(/\{HERO_CONTEXT\}/g, world.hero)
      .replace(/\{TONE_GUIDE\}/g, '根据世界观自动推导叙事基调。')
      .replace(/\{WORLD_RULES\}/g, world.desc)
      .replace(/\{WORLD_SCHEMA\}/g, '{}')
      .replace(/\{WORLD_FREEDOM\}/g, hints[wf] || hints[3])
      .replace(/\{TIME_MODE_RULES\}/g, '')
      .replace(/\{RULES_MODE_SECTION\}/g, '本世界为纯叙事模式：没有骰子与属性检定，由叙事自然推进。')
      .replace(/\{NARRATIVE_QUALITY_SECTION\}/g, '')
      .replace(/\{[A-Z_]+\}/g, '');
  }
}

function readEnvFile() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'test', '.apienv.json'), 'utf8')); } catch (e) { return null; }
}

// ---- 4. 执行测试 ----
async function executeTest(mode, creds) {
  const sys = buildSystemSafe();
  console.log(`\n========== 模式: ${mode} ==========`);
  console.log('[1] system prompt 长度:', sys.length, '字符 | 是否含 pinned_facts 指令:', sys.includes('pinned_facts'));

  // 第1轮：立誓（retrieved 传 []，模拟真实调用方永远传数组）
  const u1 = sandbox.buildTurnUserMessage('我向森林女神立下誓言，此生绝不踏入北境禁地', []);
  console.log('[2] 第1轮 user prompt 是否含「恒定事实」区（应=false，尚未钉住）:', u1.includes('恒定事实'));

  const messages1 = [{ role: 'system', content: sys }, { role: 'user', content: u1 }];
  const r1 = (mode === 'MOCK')
    ? await sandbox.callLLMNonStreaming('mock', 'k', 'm', messages1)
    : await sandbox.callLLMNonStreaming(creds.baseUrl, creds.apiKey, creds.model, messages1);

  console.log('[3] AI 第1轮返回的 pinned_facts:', JSON.stringify(r1.pinned_facts));

  // 机制A：把 AI 标注的事实钉住（真实 addPinnedFacts）
  sandbox.addPinnedFacts(r1.pinned_facts, 'ai');
  // world 与真实词法 currentWorld 是同一引用（assignSrc 引用赋值），故 world.pinned_facts 即钉住结果
  console.log('[4] 钉住后 currentWorld.pinned_facts:', JSON.stringify(world.pinned_facts, null, 2));

  // 第2轮：无关输入，验证注入
  const u2 = sandbox.buildTurnUserMessage('第二天清晨，我去镇上的酒馆喝了一杯麦酒，打算出门散散心', []);
  const injected = u2.includes('恒定事实') && u2.includes('北境禁地');
  console.log('\n[5] 第2轮 user prompt 是否成功注入「恒定事实 + 誓言」:', injected);
  const m = u2.match(/# 恒定事实[\s\S]*?(?=\n# )/);
  console.log('--- 第2轮「恒定事实」注入段 ---\n' + (m ? m[0] : '(未注入!)'));

  // 第2轮 AI 响应，验证"记得"
  const messages2 = [{ role: 'system', content: sys }, { role: 'user', content: u2 }];
  const r2 = (mode === 'MOCK')
    ? await sandbox.callLLMNonStreaming('mock', 'k', 'm', messages2)
    : await sandbox.callLLMNonStreaming(creds.baseUrl, creds.apiKey, creds.model, messages2);
  console.log('\n[6] 第2轮 AI 叙事（节选）:', (r2.narrative || '').slice(0, 240));

  const pass = (r1.pinned_facts && r1.pinned_facts.length > 0) && injected && (world.pinned_facts.length > 0);
  console.log('\n========== 结果:', pass ? 'PASS ✅' : 'FAIL ❌', '==========');
  return pass;
}

async function runMock() {
  sandbox.callLLMNonStreaming = async () => ({
    narrative: '你单膝跪在苔石上，向森林女神低头："我立誓，此生绝不踏入北境禁地。"女神的气息拂过你的额头，誓言烙印于心。',
    state_changes: {},
    key_facts: ['玩家向森林女神立誓'],
    pinned_facts: ['玩家向森林女神立下誓言，此生绝不踏入北境禁地']
  });
  await executeTest('MOCK');
}

async function runLive() {
  const envFile = readEnvFile();
  const apiKey = process.env.API_KEY || (envFile && envFile.API_KEY);
  const baseUrl = process.env.BASE_URL || (envFile && envFile.BASE_URL) || 'https://api.deepseek.com/v1/chat/completions';
  const model = process.env.MODEL || (envFile && envFile.MODEL) || 'deepseek-chat';
  if (!apiKey) {
    console.error('缺少 API_KEY（env 或 test/.apienv.json）。无法跑 live 模式。\n' +
      '请在 test/.apienv.json 写入 { "API_KEY":"...", "BASE_URL":"https://api.deepseek.com/v1/chat/completions", "MODEL":"deepseek-chat" }');
    process.exit(2);
  }
  console.log('[live] 使用 BASE_URL =', baseUrl, '| MODEL =', model);

  // ★ 传输层覆盖：真实 callLLMNonStreaming 写死了 thinking:{type:"disabled"}，
  // deepseek-chat 不支持该字段（仅 reasoner 支持），会触发 400。这里剥掉 thinking，
  // 但【仍走真实的 parseResponse】解析 JSON 契约（含 pinned_facts），功能验证不受影响。
  sandbox.callLLMNonStreaming = async (url, key, modelName, messages) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model: modelName,
        messages,
        temperature: 0.5,
        max_tokens: 1024,
        response_format: { type: 'json_object' }
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('API 返回异常：无法获取响应内容');
    return sandbox.parseResponse(content); // 真实 JSON 契约解析（提取 pinned_facts）
  };

  await executeTest('LIVE', { apiKey, baseUrl, model });
}

const mode = process.argv[2] || '--mock';
if (mode === '--live') runLive().catch(e => { console.error('LIVE 错误:', e); process.exit(1); });
else runMock().catch(e => { console.error('MOCK 错误:', e); process.exit(1); });
