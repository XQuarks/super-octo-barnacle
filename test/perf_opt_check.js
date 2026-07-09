// 性能优化 G 项确定性测试：
// G1: embedding 惰性重算（内容指纹 + 启动不再遍历所有 world 预跑）
// G2: 世界脉搏合并进主响应（consumeWorldPulse + buildTurnUserMessage 注入）
// 用 vm 沙箱加载真实源码，不耗 API。

const fs = require('fs');
const vm = require('vm');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond) {
    if (cond) { pass++; console.log('  ✅ ' + name); }
    else { fail++; console.log('  ❌ ' + name); }
}

// ---- 文档 stub ----
const elCache = {};
function fakeEl() {
    return {
        value: '', checked: false, textContent: '', innerHTML: '', style: {},
        classList: { add(){}, remove(){}, contains(){ return false; } },
        addEventListener(){}, removeEventListener(){}, appendChild(){}, setAttribute(){},
        getAttribute(){ return null; }, querySelector(){ return null; }, querySelectorAll(){ return []; }
    };
}
const docStub = {
    addEventListener(){}, removeEventListener(){},
    getElementById(id){
        if (!elCache[id]) {
            const el = fakeEl();
            if (id === 'mockMode') el.checked = true; // 走模拟模式
            if (id === 'baseUrl') el.value = 'https://api.deepseek.com';
            if (id === 'apiKey') el.value = 'test-key';
            if (id === 'modelName') el.value = 'deepseek-test';
            elCache[id] = el;
        }
        return elCache[id];
    },
    querySelector(){ return null; }, querySelectorAll(){ return []; }, createElement(){ return fakeEl(); }
};

// ---- 创建沙箱 ----
const sandbox = {
    console,
    document: docStub,
    window: null,
    setTimeout, clearTimeout, setInterval, clearInterval,
    __fakeEmbed: null,
    __embedCalls: [],
    fetch: async () => { throw new Error('test should not call fetch'); }
};
sandbox.window = sandbox;
sandbox.crypto = require('crypto');
sandbox.localStorage = (function(){ const m = {}; return {
    getItem(k){ return k in m ? m[k] : null; },
    setItem(k,v){ m[k] = String(v); },
    removeItem(k){ delete m[k]; }
}; })();
sandbox.transformers = undefined; // 让真实 ONNX 路径不被触发

vm.createContext(sandbox);

// currentWorld 在源码里是 let（词法绑定），无法用 sandbox.currentWorld = ... 直接覆盖，
// 必须通过 runInContext 在沙箱内赋值才能被函数闭包读到。
function ctx(code) { return vm.runInContext(code, sandbox); }

const files = ['js/app-core.js','js/app-ai.js','js/app-game.js','js/app-ui.js','js/preset-worlds.js'];
const src = files.map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');

// 末尾追加：覆盖 ensureEmbeddingModel 为空操作，并把 embeddingModel 指向 fake，
// 同时记录 embedding 调用文本用于验证惰性重算。
const testSetup = `
ensureEmbeddingModel = async function(){};
__fakeEmbed = async function(text, opts) {
    __embedCalls.push(text);
    return { data: new Float32Array([text.length, 1.0, 2.0]) };
};
embeddingModel = __fakeEmbed;
`;
vm.runInContext(src + '\n' + testSetup, sandbox, { filename: 'perf_opt_combined.js' });

(async function run() {
    console.log('==== G1: embedding 惰性重算 ====');

    // 指纹稳定性
    const fp1 = sandbox.snippetFingerprint({ category:'地点', title:'酒馆', content:'小镇酒馆', keywords:['酒馆'] });
    const fp1b = sandbox.snippetFingerprint({ category:'地点', title:'酒馆', content:'小镇酒馆', keywords:['酒馆'] });
    const fp2 = sandbox.snippetFingerprint({ category:'地点', title:'酒馆', content:'小镇酒馆（扩建）', keywords:['酒馆'] });
    ok('相同内容指纹一致', fp1 === fp1b);
    ok('内容变化指纹变化', fp1 !== fp2);

    // 惰性跳过 + 重算
    const w = { lore_kb: { ip:'p', snippets: [
        { id:'s1', category:'地点', title:'酒馆', content:'小镇酒馆', keywords:['酒馆'] }
    ] } };
    sandbox.__embedCalls.length = 0;
    await sandbox.computeEmbeddingsForWorld(w);
    ok('首次：片段被重算（embedding 写入）', !!w.lore_kb.snippets[0].embedding && w.lore_kb.snippets[0].embedding.length > 0);
    ok('首次：写入指纹 emb_fp', !!w.lore_kb.snippets[0].emb_fp);
    ok('首次：embedding 调用 1 次', sandbox.__embedCalls.length === 1);

    await sandbox.computeEmbeddingsForWorld(w);
    ok('再次调用：内容未变 → 跳过重算（仍 1 次）', sandbox.__embedCalls.length === 1);

    w.lore_kb.snippets[0].content = '小镇酒馆（扩建）';
    await sandbox.computeEmbeddingsForWorld(w);
    ok('内容变化：触发重算（累计 2 次）', sandbox.__embedCalls.length === 2);
    ok('重算后 embedding 已刷新', w.lore_kb.snippets[0].emb_fp !== fp1);

    // 空 lore 安全
    let threw = false;
    try { await sandbox.computeEmbeddingsForWorld({}); } catch(e){ threw = true; }
    ok('空 world 不抛错', !threw);

    console.log('\n==== G2: 世界脉搏合并进主响应 ====');

    // consumeWorldPulse 单元
    sandbox.worlds = [];
    ctx("currentWorld = { id:'pw', name:'性能测试世界', preset:false, lore_kb:{ip:'p',snippets:[]}, pinned_facts:[], current_world_events: [], type:'ip' };");
    sandbox.gameState = sandbox.deepClone(sandbox.defaultInitialState());

    const before = ctx("currentWorld.current_world_events.length");
    const r1 = sandbox.consumeWorldPulse({ world_pulse: { type:'rumor', text:'镇上开始传主角的好话' } });
    ok('带 world_pulse → 返回 true', r1 === true);
    ok('带 world_pulse → 写入一条世界动态', ctx("currentWorld.current_world_events.length") === before + 1);
    ok('写入的 type 正确', ctx("currentWorld.current_world_events[0].type") === 'rumor');

    const r2 = sandbox.consumeWorldPulse({});
    ok('无 world_pulse → 返回 false', r2 === false);
    ok('无 world_pulse → 不新增动态', ctx("currentWorld.current_world_events.length") === before + 1);

    const r3 = sandbox.consumeWorldPulse({ world_pulse: {} });
    ok('world_pulse 无 text → 返回 false', r3 === false);

    // 长度上限（>12 截断）
    ctx("currentWorld.current_world_events = []; for (let i=0;i<15;i++) consumeWorldPulse({ world_pulse:{ type:'env', text:'e'+i } });");
    ok('世界动态超过 12 条被截断', ctx("currentWorld.current_world_events.length") === 12);

    // buildTurnUserMessage 注入：_pulseCounter<2 不提示，>=2 提示
    ctx("currentWorld._pulseCounter = 1;");
    const p1 = sandbox.buildTurnUserMessage('主角在酒馆坐下', []);
    ok('常驻说明含 world_pulse 字段', p1.indexOf('world_pulse') >= 0);
    ok('_pulseCounter<2 时不强制要求返回脉搏', p1.indexOf('请尽量返回 world_pulse') < 0);

    ctx("currentWorld._pulseCounter = 2;");
    const p2 = sandbox.buildTurnUserMessage('主角在酒馆坐下', []);
    ok('_pulseCounter>=2 时强制提示返回 world_pulse', p2.indexOf('请尽量返回 world_pulse') >= 0);

    console.log('\n==== 启动预跑已移除（源码断言）====');
    const uiSrc = fs.readFileSync(path.join(__dirname, '..', 'js/app-ui.js'), 'utf8');
    ok('app-ui.js 不再遍历所有 world 预跑 embedding', !uiSrc.includes('computeEmbeddingsForWorld(w)'));
    ok('app-ui.js 在 startGame 改为按需重算当前 world', uiSrc.includes('computeEmbeddingsForWorld(currentWorld)'));

    const gameSrc = fs.readFileSync(path.join(__dirname, '..', 'js/app-game.js'), 'utf8');
    ok('app-game.js 优先消费主响应 world_pulse', gameSrc.includes('consumeWorldPulse(resp)'));

    console.log('\n[汇总] PASS=' + pass + ' FAIL=' + fail);
    process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('测试运行异常:', e); process.exit(1); });
