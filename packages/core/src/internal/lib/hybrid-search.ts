/**
 * 混合检索：在同一张表内用 BM25 和 Dense 检索的名次做 RRF 融合。
 * 只融合名次，不直接比较不同检索器或不同向量空间的原始分数。
 */
import type { VectorOutput } from "../types";

/** 混合检索输入。 */
export interface HybridSearchInput {
  denseResults: VectorOutput[];
  hydeDenseResults?: VectorOutput[];
  lexicalResults: VectorOutput[];
  limit: number;
}

/** 按 RRF 合并 BM25、原始 Dense 与可选 HyDE Dense 排名。 */
export function hybridSearch(input: HybridSearchInput): VectorOutput[] {
  const rankings = [
    input.lexicalResults,
    input.denseResults,
    input.hydeDenseResults ?? [],
  ];
  const recordsById = new Map([...input.lexicalResults, ...input.denseResults, ...(input.hydeDenseResults ?? [])].map((record) => [record.id, record]));
  const scores = new Map<string, number>();
  const rrfK = 60;

  for (const ranking of rankings) {
    ranking.forEach((record, index) => {
      scores.set(record.id, (scores.get(record.id) ?? 0) + 1 / (rrfK + index + 1));
    });
  }

  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, input.limit)
    .map(([id, score]) => ({ ...(recordsById.get(id) ?? { id, text: "", metadata: {} }), score }));
}


// 该混合搜索实现的原理和解读
// noted by clayw on 20260720

/**
 * 
 * 
 * 
## 这段代码在做什么

这是一个**混合检索（Hybrid Search）**工具函数，核心目的是：**用多种检索方式同时搜索，然后把它们的排名结果合并成一个更靠谱的最终排名**。

简单说就是：**不要只信一种检索方式，把 BM25、向量检索、HyDE 向量检索三路的结果按"名次"加权合并，取最终 Top-K**。

---

## 三个核心术语解释

### 1. BM25（Best Matching 25）

**是什么**：一种基于**关键词匹配**的经典检索算法，起源于信息检索领域（搜索引擎的核心技术之一）。

**怎么工作**：
- 把查询和文档都拆成词（token）
- 统计每个词在文档中出现的频率（TF）
- 同时考虑这个词在多少文档中出现过（IDF，出现越少越珍贵）
- 公式里还有一个**文档长度惩罚**——同样包含关键词，短文档比长文档得分更高

**代码中的体现**：
```ts
function rankByBm25(query: string, records: VectorOutput[]): VectorOutput[]
```
- 先把查询和每条记录`tokenize()`分词
- 计算每个词的`idf`（逆文档频率）
- 计算每条记录的 BM25 分数
- 按分数排序返回

**作用**：
- **擅长精确匹配**：用户搜"张三工资"，文档里有"张三"和"工资"这两个词，BM25 能精准命中
- **不擅长语义理解**：用户搜"员工薪酬"，文档里只写"工资"但没有"薪酬"，BM25 可能匹配不上

---

### 2. Dense Retrieval（稠密检索，即向量检索）

**是什么**：用神经网络把文本转成**固定长度的向量（Embedding）**，然后在向量空间里用余弦相似度找最近邻。

**怎么工作**：
- 查询 → Embedding 模型 → 查询向量（如 1024 维）
- 文档 → Embedding 模型 → 文档向量
- 计算余弦相似度，相似度越高越相关

**代码中的体现**：
```ts
denseResults: VectorOutput[];   // 原始问题的向量召回结果
hydeDenseResults?: VectorOutput[]; // HyDE 假设文档的向量召回结果
```
这两个都是 Dense 检索的结果，区别在于**用什么东西生成的向量**：
- `denseResults`：用用户原始问题生成向量去搜
- `hydeDenseResults`：先用 LLM 生成一份"假设答案"，再用假设答案生成向量去搜

**作用**：
- **擅长语义理解**：用户搜"员工薪酬"，文档里写"工资待遇"，虽然关键词不同但语义相近，向量能匹配上
- **不擅长精确匹配**：用户搜"张三"，向量可能把"张总""张三丰"都拉进来，不精准

---

### 3. RRF（Reciprocal Rank Fusion，倒数排名融合）

**是什么**：一种**不比较原始分数、只比较排名**的多路结果融合算法。由 Cormack 等人在 SIGIR 2009 年提出。

**怎么工作**：

假设你有三路检索结果，每路返回一个排名列表：

| 排名 | BM25 结果 | Dense 结果 | HyDE 结果 |
|------|-----------|------------|-----------|
| 1 | 文档A | 文档B | 文档B |
| 2 | 文档C | 文档A | 文档D |
| 3 | 文档B | 文档D | 文档C |

RRF 的公式是：
```
RRF_score(doc) = Σ 1 / (k + rank_i(doc))
```
其中 `k=60`（经验常数，防止排名靠后的文档得分过低）

**计算过程**：

文档A：出现在 BM25 第1名 + Dense 第2名 → `1/(60+1) + 1/(60+2) = 0.0164 + 0.0161 = 0.0325`

文档B：出现在 BM25 第3名 + Dense 第1名 + HyDE 第1名 → `1/(60+3) + 1/(60+1) + 1/(60+1) = 0.0159 + 0.0164 + 0.0164 = 0.0487`

文档C：出现在 BM25 第2名 + HyDE 第3名 → `1/(60+2) + 1/(60+3) = 0.0161 + 0.0159 = 0.0320`

文档D：出现在 Dense 第3名 + HyDE 第2名 → `1/(60+3) + 1/(60+2) = 0.0159 + 0.0161 = 0.0320`

**最终排序**：文档B > 文档A > 文档C ≈ 文档D

**代码中的体现**：
```ts
const rrfK = 60;
for (const ranking of rankings) {
  ranking.forEach((record, index) => {
    scores.set(record.id, (scores.get(record.id) ?? 0) + 1 / (rrfK + index + 1));
  });
}
```

**为什么用 RRF 而不是直接平均分数**：
- BM25 的分数和 Dense 的余弦相似度**不在同一量纲**（一个可能是 0~10，一个是 -1~1）
- 直接加权平均会偏向某个检索器
- RRF 只看**排名位置**，不关心具体分数，天然解决了"跨检索器分数不可比"的问题

---

## 代码执行流程（图文对照）

```
用户问题："张三的工资是多少"
         │
         ▼
    ┌─────────────────────────────────────────────────┐
    │  第1路：BM25 关键词检索                         │
    │  → tokenize("张三的工资是多少")                │
    │  → 计算每条记录的 BM25 分数                     │
    │  → 返回按分数排序的排名列表                     │
    └─────────────────────────────────────────────────┘
         │
         ▼
    ┌─────────────────────────────────────────────────┐
    │  第2路：Dense 向量检索（原始问题）              │
    │  → embedText("张三的工资是多少") → 查询向量     │
    │  → 在向量库中找最近邻 → 返回按相似度排序的列表  │
    └─────────────────────────────────────────────────┘
         │
         ▼
    ┌─────────────────────────────────────────────────┐
    │  第3路：Dense 向量检索（HyDE 假设文档）         │
    │  → LLM生成："张三的工资记录在员工薪酬表中..."   │
    │  → embedText(假设文档) → 查询向量               │
    │  → 在向量库中找最近邻 → 返回按相似度排序的列表  │
    └─────────────────────────────────────────────────┘
         │
         ▼
    ┌─────────────────────────────────────────────────┐
    │  RRF 融合                                      │
    │  → 三路排名列表输入                             │
    │  → 每个文档计算 RRF_score = Σ 1/(60+rank)     │
    │  → 按 RRF_score 降序排序                       │
    │  → 取 Top-N 返回                               │
    └─────────────────────────────────────────────────┘
         │
         ▼
    最终结果：[文档B, 文档A, 文档C, ...]
```

---

## 代码中 `tokenize()` 的中文处理亮点

```ts
for (const block of normalized.match(/[\u4e00-\u9fff]+/g) ?? []) {
  for (let index = 0; index < block.length; index++) tokens.add(block[index]);     // 单字
  for (let index = 0; index < block.length - 1; index++) tokens.add(block.slice(index, index + 2)); // 双字
}
```

这段代码同时保留了：
- **单字**："张"、"三"、"工"、"资" → 确保不会因为分词错误而漏匹配
- **双字**："张三"、"三的"、"工资" → 保留中文常用词组的语义
- **英文词**：`[a-z0-9_]+` → 匹配 "RAG"、"LLM" 等技术术语

这种"单字+双字"的混合策略，在中文场景下比标准分词器更鲁棒，能同时照顾到**精确人名/术语**和**常见词组**。

---

## 一句话总结

**代码实现了：用 BM25 做关键词精确匹配，用向量检索做语义模糊匹配，再用 HyDE 做语义兜底，最后通过 RRF（只看排名不看分数）把三路结果合并成一个最终排序。**



 */
