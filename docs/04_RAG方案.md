# RAG 方案

RAG（Retrieval-Augmented Generation）确保 AI 叙事严格遵循世界观设定。

---

## 1. 架构

```
玩家输入
  │
  ├─→ 中文分词 (Intl.Segmenter)
  │     └─→ 关键词检索 → 得分
  │
  ├─→ 向量语义检索 (Promise.all 并行)
  │     └─→ 余弦相似度 → 得分
  │
  ├─→ 行为记录检索 (中文分词)
  │     └─→ 关键事实 → 得分
  │
  └─→ 融合排序 → Top 8 → 注入 User Message
```

---

## 2. 双检索并行

`keywordRetrieve()` 和 `embeddingRetrieve()` 使用 `Promise.all` 同时执行，节省 100-300ms 等待时间。

### 2.1 关键词检索

- 使用 `Intl.Segmenter("zh-CN", { granularity: "word" })` 中文分词
- "我要去大观园找林黛玉" → ["大观园","林黛玉","找","去"]
- 纯英文/数字直接作为关键词保留
- 匹配 title/keywords/content，加权评分

### 2.2 向量语义检索

- 模型：`@xenova/transformers` + `Xenova/all-MiniLM-L6-v2`（384 维）
- 浏览器端推理，无服务器依赖
- 入口时后台预热模型，首次检索无冷启动惩罚
- 计算玩家输入与每条知识片段的余弦相似度

### 2.3 行为记录检索

- 从 `currentWorld.behavior_records` 中搜索匹配的关键事实
- 使用与关键词检索相同的 `Intl.Segmenter` 分词

---

## 3. 融合排序

| 来源 | 权重 |
|------|------|
| 关键词检索命中 | 1× |
| 向量检索命中 | 2×（语义匹配权重更高） |
| 关键词+向量同时命中 | 叠加 |
| 行为记录 | 1.5× |

最终取 Top 8 注入 user message。

---

## 4. 全量注入策略

当知识库总长度 < 12000 字符时，**全量注入 system prompt**（作为固定前缀，命中 DeepSeek 磁盘缓存）。超过阈值时仅注入检索结果的 Top 片段。

---

## 5. 性能优化

- System prompt 缓存：同世界内 system prompt 只构建一次
- 增量检索：知识库不变化时不重复加载
- Embedding 预热：`init()` 中后台加载模型
- ID 去重：关键词和向量结果以 ID 去重，避免重复片段
