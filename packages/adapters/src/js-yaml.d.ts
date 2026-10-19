/** js-yaml 的最小类型声明：Adapter 仅需将 Skill frontmatter 解析为未知值后自行校验。 */
declare module "js-yaml" {
  export function load(source: string): unknown;
}
