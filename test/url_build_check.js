/**
 * I · API URL 拼接健壮性（URL build robustness）
 * 加载真实产品代码（vm 沙箱加载 js/app-core.js），覆盖各种用户输入边界：
 *   - baseUrl 带/不带 /v1、带/不带 /chat/completions、带/不带尾斜杠、带/不带协议
 *   - 双重拼接 /chat/completions/chat/completions
 *   - CORS 代理前缀转发（含代理尾斜杠、代理协议补全、base 已含路径）
 *   - 空 / 空白 / 前后空格
 * 不耗 API、不依赖浏览器。
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..');
const code = fs.readFileSync(path.join(APP_ROOT, 'js/app-core.js'), 'utf8');

const sandbox = {
    console,
    Math, JSON, Date, RegExp, String, Number, Array, Object, Boolean,
    setTimeout, clearTimeout,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const buildApiUrl = sandbox.buildApiUrl;
const normalizeApiBaseUrl = sandbox.normalizeApiBaseUrl;

let pass = 0, fail = 0;
function ok(name, cond) {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ ' + name); }
}
function eq(name, actual, expected) {
    ok(name + '  →  ' + JSON.stringify(actual), actual === expected);
}

console.log('== I · buildApiUrl 健壮性 ==');

// 1. 基础（无 /v1）
eq('deepseek 裸域名', buildApiUrl('https://api.deepseek.com'), 'https://api.deepseek.com/chat/completions');
// 2. 尾斜杠
eq('deepseek 尾斜杠', buildApiUrl('https://api.deepseek.com/'), 'https://api.deepseek.com/chat/completions');
// 3. 已含 /chat/completions（防止双重拼接）
eq('已含 /chat/completions（去重）', buildApiUrl('https://api.deepseek.com/chat/completions'), 'https://api.deepseek.com/chat/completions');
// 4. 已含 /chat/completions/（尾斜杠）
eq('已含 /chat/completions/（去重）', buildApiUrl('https://api.deepseek.com/chat/completions/'), 'https://api.deepseek.com/chat/completions');
// 5. 双重拼接（历史 bug：/chat/completions/chat/completions）
eq('双重拼接（历史 bug 修复）', buildApiUrl('https://api.deepseek.com/chat/completions/chat/completions'), 'https://api.deepseek.com/chat/completions');
// 6. OpenAI /v1
eq('openai /v1', buildApiUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions');
// 7. OpenAI /v1/
eq('openai /v1/（去尾斜杠）', buildApiUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1/chat/completions');
// 8. OpenAI /v1/chat/completions（去重）
eq('openai /v1 已含端点（去重）', buildApiUrl('https://api.openai.com/v1/chat/completions'), 'https://api.openai.com/v1/chat/completions');
// 9. 协议补全（域名）
eq('协议补全（裸域名）', buildApiUrl('api.deepseek.com'), 'https://api.deepseek.com/chat/completions');
// 10. localhost（http）
eq('localhost 用 http', buildApiUrl('localhost:11434'), 'http://localhost:11434/chat/completions');
// 11. 127.0.0.1（http）
eq('127.0.0.1 用 http', buildApiUrl('127.0.0.1:8080'), 'http://127.0.0.1:8080/chat/completions');
// 12. 已有 http:// 协议保留
eq('保留 http 协议', buildApiUrl('http://localhost:11434'), 'http://localhost:11434/chat/completions');

// 13. CORS 代理前缀转发
eq('CORS 代理转发', buildApiUrl('https://api.deepseek.com', 'https://proxy.workers.dev'), 'https://proxy.workers.dev/https://api.deepseek.com/chat/completions');
// 14. 代理尾斜杠
eq('CORS 代理尾斜杠（去尾）', buildApiUrl('https://api.deepseek.com', 'https://proxy.workers.dev/'), 'https://proxy.workers.dev/https://api.deepseek.com/chat/completions');
// 15. 代理 + base 已含路径（去重后再拼）
eq('CORS 代理 + base 已含端点', buildApiUrl('https://api.deepseek.com/chat/completions', 'https://proxy.workers.dev'), 'https://proxy.workers.dev/https://api.deepseek.com/chat/completions');
// 16. 代理协议补全
eq('CORS 代理协议补全', buildApiUrl('api.deepseek.com', 'proxy.workers.dev'), 'https://proxy.workers.dev/https://api.deepseek.com/chat/completions');
// 17. 代理空白 → 视为无代理
eq('代理空白视为无代理', buildApiUrl('https://api.deepseek.com', '   '), 'https://api.deepseek.com/chat/completions');

// 18. 空 / 空白 base
eq('空 baseUrl → 空串', buildApiUrl(''), '');
eq('空白 baseUrl → 空串', buildApiUrl('   '), '');
// 19. 前后空格 trim
eq('前后空格 trim', buildApiUrl('  https://api.deepseek.com/  '), 'https://api.deepseek.com/chat/completions');

console.log('== I · normalizeApiBaseUrl 单独 ==');
// 20. 剥离 /chat/completions
eq('normalize 剥离端点', normalizeApiBaseUrl('https://api.deepseek.com/chat/completions'), 'https://api.deepseek.com');
// 21. 大小写不敏感
eq('normalize 大小写不敏感', normalizeApiBaseUrl('https://x.com/CHAT/COMPLETIONS'), 'https://x.com');
// 22. 保留 /v1 前缀
eq('normalize 保留 /v1', normalizeApiBaseUrl('https://api.openai.com/v1/chat/completions'), 'https://api.openai.com/v1');
// 23. 空安全
eq('normalize 空 → 空串', normalizeApiBaseUrl(''), '');
eq('normalize null → 空串', normalizeApiBaseUrl(null), '');

console.log('\n通过: ' + pass + ' / ' + (pass + fail) + (fail ? '  ✗ FAIL ' + fail : '  (0 FAIL)'));
process.exit(fail ? 1 : 0);
