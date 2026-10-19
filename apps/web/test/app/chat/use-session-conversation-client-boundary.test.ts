/** Web 会话 Hook 客户端依赖边界回归，防止 Core Node 主入口进入浏览器依赖图。 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(testDirectory, "../../..");
const repoRoot = path.resolve(webRoot, "../..");
const hookPath = path.resolve(webRoot, "app/chat/hooks/useSessionConversation.ts");
const hookSource = readFileSync(hookPath, "utf8");
const submissionSource = readFileSync(path.resolve(webRoot, "app/chat/hooks/useConversationSubmission.ts"), "utf8");
const recoverySource = readFileSync(path.resolve(webRoot, "app/chat/hooks/useTurnRecoveryActions.ts"), "utf8");
const controllerSource = readFileSync(path.resolve(webRoot, "app/chat/session-task-controller.ts"), "utf8");

/** 判断导入声明是否仅为 TypeScript 类型依赖，因而不会进入浏览器运行时模块图。 */
function isTypeOnlyImport(clause: ts.ImportClause | undefined): boolean {
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  return !clause.name
    && clause.namedBindings !== undefined
    && ts.isNamedImports(clause.namedBindings)
    && clause.namedBindings.elements.length > 0
    && clause.namedBindings.elements.every(function isTypeOnly(specifier) { return specifier.isTypeOnly; });
}

/** 解析 Web 源码本地模块及当前 Presentation ESM 入口，外部浏览器依赖保持为叶节点。 */
function resolveRuntimeModule(specifier: string, importer: string): string | undefined {
  if (specifier === "@autopilot-agent/presentation") {
    const packageRoot = path.resolve(repoRoot, "packages/presentation");
    const manifest = JSON.parse(readFileSync(path.resolve(packageRoot, "package.json"), "utf8")) as {
      exports: { ".": { import: string } };
    };
    return path.resolve(packageRoot, manifest.exports["."].import);
  }
  if (specifier.startsWith("@/")) return resolveExistingModule(path.resolve(webRoot, specifier.slice(2)));
  if (specifier.startsWith(".")) return resolveExistingModule(path.resolve(path.dirname(importer), specifier));
  return undefined;
}

/** 将源码导入路径映射到 TypeScript、JavaScript 或目录入口文件。 */
function resolveExistingModule(basePath: string): string | undefined {
  const extension = path.extname(basePath);
  const extensionlessPath = extension ? basePath.slice(0, -extension.length) : basePath;
  const candidates = [
    basePath,
    `${extensionlessPath}.ts`,
    `${extensionlessPath}.tsx`,
    `${extensionlessPath}.js`,
    `${extensionlessPath}.mjs`,
    path.resolve(basePath, "index.ts"),
    path.resolve(basePath, "index.tsx"),
    path.resolve(basePath, "index.js"),
    path.resolve(basePath, "index.mjs"),
  ];
  return candidates.find(function existingFile(candidate) { return ts.sys.fileExists(candidate); });
}

/** 收集 Hook 可达模块中的运行时 Core 主入口导入，忽略显式类型依赖。 */
function findRuntimeCoreImports(entryPath: string): string[] {
  const visited = new Set<string>();
  const pending = [entryPath];
  const violations: string[] = [];
  while (pending.length > 0) {
    const currentPath = pending.pop()!;
    if (visited.has(currentPath)) continue;
    visited.add(currentPath);
    const sourceText = readFileSync(currentPath, "utf8");
    const sourceFile = ts.createSourceFile(currentPath, sourceText, ts.ScriptTarget.Latest, true);
    const visitImport = function visitImport(specifier: string) {
      if (specifier === "@autopilot-agent/core") {
        violations.push(currentPath);
        return;
      }
      const resolved = resolveRuntimeModule(specifier, currentPath);
      if (resolved && !visited.has(resolved)) pending.push(resolved);
    };
    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        if (!isTypeOnlyImport(statement.importClause)) visitImport(statement.moduleSpecifier.text);
      }
      if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        const exportClause = statement.exportClause;
        const typeOnly = statement.isTypeOnly || (exportClause && ts.isNamedExports(exportClause)
          && exportClause.elements.length > 0
          && exportClause.elements.every(function isTypeOnlyExport(specifier) { return specifier.isTypeOnly; }));
        if (!typeOnly) visitImport(statement.moduleSpecifier.text);
      }
    }
    function visitDynamicImport(node: ts.Node): void {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
        visitImport(node.arguments[0].text);
      }
      ts.forEachChild(node, visitDynamicImport);
    }
    visitDynamicImport(sourceFile);
  }
  return violations;
}

describe("useSessionConversation client dependency boundary", function clientDependencyBoundarySuite() {
  it("does not reach the Core package runtime entry through client imports", function excludesCoreRuntimeEntry() {
    expect(findRuntimeCoreImports(hookPath)).toEqual([]);
  });

  it("consumes the server-whitelisted termination DTO and keeps Core recoverability authoritative", function consumesSanitizedTermination() {
    expect(hookSource).toContain('data.termination as SessionAgentState["termination"]');
    expect(hookSource).toContain("termination?.recoverable === true");
    expect(hookSource).not.toContain("sanitizeAgentTerminationView");
  });

  it("keeps realtime content when a same-session history load fails transiently", function keepsRealtimeContentOnTransientFailure() {
    expect(hookSource).toContain("sessionMetaIdRef.current === sid");
    expect(hookSource).toContain("manualRetry: true");
  });

  it("classifies history failures by request stage without leaking internals", function classifiesHistoryFailureStages() {
    expect(hookSource).toContain('new HistoryStageError("fetch")');
    expect(hookSource).toContain('new HistoryStageError("json")');
    expect(hookSource).toContain('error instanceof HistoryStageError ? error.stage : "mapping"');
  });

  it("auto-retries the first history restore instead of asking the user to retry", function autoRetriesFirstHistoryRestore() {
    expect(hookSource).toContain("scheduleHistoryAutoRetry(sid)");
    expect(hookSource).toContain("MAX_HISTORY_AUTO_RETRY");
    expect(hookSource).toContain("manualRetry: false");
  });

  it("clears the history error on success, empty-session switches, and new turn start", function clearsHistoryErrorOnRecovery() {
    expect(hookSource).toContain("setHistoryError(null)");
    expect(hookSource).toContain('data.type === "turn_started"');
  });

  it("skips the full history reload after a trusted terminal stream outcome", function skipsHistoryReloadAfterTerminal() {
    expect(controllerSource).toContain('"terminal_seen"');
    expect(controllerSource).toContain('"ended_without_terminal"');
    expect(submissionSource).toContain('streamOutcome === "ended_without_terminal"');
    expect(recoverySource).toContain('streamOutcome === "ended_without_terminal"');
  });

  it("mounts one stable session instance when the url targets a session before the list loads", function mountsStableSessionInstance() {
    const hostSource = readFileSync(path.resolve(webRoot, "app/chat/chat-session-host.tsx"), "utf8");
    expect(hostSource).toContain("retainedRenderEntries");
    expect(hostSource).toContain("selectedSessionNeedsDraft");
    expect(hostSource).not.toContain("transitionFallbackSlot");
  });
});
