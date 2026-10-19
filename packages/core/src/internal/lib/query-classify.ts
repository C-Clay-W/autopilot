/**
 * 查询意图分类：用确定性的关键词规则为多表检索提供来源优先级。
 * 不调用 LLM，避免在检索前增加延迟和成本。
 */

/** 查询意图类型。 */
export type QueryIntent = "structured" | "document" | "mixed";

/** 查询意图分类结果。 */
export interface QueryClassification {
  intent: QueryIntent;
  preferredSources: string[];
  requiresVision: boolean;
}

/** 结构化古建资料常见字段，命中时优先检索 Excel 等结构化表。 */
const STRUCTURED_QUERY_PATTERN = /(员工|姓名|工资|部门|数据|统计|金额|编号|表格|建筑名称|建筑单体|建筑群|古建分布|建筑分布|坐标|经纬度|高程|面积|尺寸|测绘数据|测量数据|点云数据|模型数据|属性|清单|名录)/;

/** 古建文献、规制与说明性资料关键词，命中时优先检索 PDF 和文本表。 */
const DOCUMENT_QUERY_PATTERN = /(图|示意|照片|页面|规范|文档|说明|章节|报告|注意|要点|须知|规则|流程|参考文献|参考资料|引用|附录|标准|古建筑|古建|明清|明代|清代|官式|营造|修缮|形制|规制|构件|斗拱|屋顶|文物|保护|测绘|测量|第\s*\d+\s*页)/;

/** 用户明确要求查看图像、图纸或空间表达时，才启用视觉模型。 */
const VISION_QUERY_PATTERN = /(看(?:一下)?(?:图|图片|图纸|示意图|页面)|查看(?:图|图片|图纸|示意图|页面)|图片|图中|图里|图像|照片|颜色|布局|示意图|图纸|点云|三维|3d|模型|正射|侧射|遥感影像|地图|分布图|总平图|平面图|立面图|剖面图|测绘图|空间位置|方位)/i;

/** 根据问题中的显式关键词判断检索来源和是否需要视觉理解。 */
export function classifyQuery(query: string): QueryClassification {
  const normalizedQuery = query.toLowerCase();
  const requiresVision = VISION_QUERY_PATTERN.test(normalizedQuery);
  const isStructured = STRUCTURED_QUERY_PATTERN.test(normalizedQuery);
  const isDocument = DOCUMENT_QUERY_PATTERN.test(normalizedQuery);

  // 古建筑名称会同时命中文档词，但“坐标、面积、清单”等明确字段仍应优先查结构化表。
  if (isStructured && !requiresVision) {
    return { intent: "structured", preferredSources: ["excel"], requiresVision };
  }
  // 地图、点云、正射/侧射和图纸等视觉表达优先保留 PDF/文档候选供 Qwen-VL 精排。
  if (isDocument || requiresVision) {
    return { intent: "document", preferredSources: ["pdf", "text", "docx", "md", "txt"], requiresVision };
  }
  if (isStructured) return { intent: "structured", preferredSources: ["excel"], requiresVision };
  return { intent: "mixed", preferredSources: [], requiresVision };
}
