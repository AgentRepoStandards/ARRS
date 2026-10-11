import ts from "typescript";

export interface MaintenanceComment {
  rule: "deferred-work" | "suppression";
  line: number;
  column: number;
  text: string;
  offset: number;
}

/** Use parser-owned literal ranges, then scan trivia; regex/template/JSX text is opaque. */
export function maintenanceComments(
  path: string,
  text: string,
): { comments: MaintenanceComment[]; warnings: string[] } {
  if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(path))
    return { comments: [], warnings: [`Unsupported maintenance syntax: ${path}`] };
  const kind = /\.tsx$/.test(path)
    ? ts.ScriptKind.TSX
    : /\.jsx$/.test(path)
      ? ts.ScriptKind.JSX
      : /\.(?:mjs|cjs|js)$/.test(path)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const parser = source as ts.SourceFile & {
    commentDirectives?: Array<{ range: { pos: number; end: number }; type: number }>;
    checkJsDirective?: { enabled: boolean; pos: number; end: number };
  };
  const ranges: Array<[number, number]> = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isRegularExpressionLiteral(node) ||
      ts.isTemplateLiteralToken(node) ||
      ts.isJsxText(node)
    )
      ranges.push([node.getStart(source), node.end]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const masked = text.split("");
  for (const [start, end] of ranges)
    for (let index = start; index < end; index++)
      if (masked[index] !== "\n" && masked[index] !== "\r") masked[index] = " ";
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    kind === ts.ScriptKind.TSX || kind === ts.ScriptKind.JSX
      ? ts.LanguageVariant.JSX
      : ts.LanguageVariant.Standard,
    masked.join(""),
  );
  const comments: MaintenanceComment[] = [];
  for (
    let token = scanner.scan();
    token !== ts.SyntaxKind.EndOfFileToken;
    token = scanner.scan()
  ) {
    if (
      token !== ts.SyntaxKind.SingleLineCommentTrivia &&
      token !== ts.SyntaxKind.MultiLineCommentTrivia
    )
      continue;
    const offset = scanner.getTokenPos();
    const comment = text.slice(offset, scanner.getTextPos());
    const body = comment.replace(/^\/[/\*]+/, "").replace(/\*\/$/, "");
    const add = (rule: MaintenanceComment["rule"], location = offset): void => {
      const position = source.getLineAndCharacterOfPosition(location);
      comments.push({
        rule,
        line: position.line + 1,
        column: position.character + 1,
        text: comment,
        offset: location,
      });
    };
    if (/\b(?:TODO|FIXME)\b/.test(body)) add("deferred-work");
    if (
      (parser.commentDirectives ?? []).some(
        (directive) =>
          directive.type === 1 &&
          directive.range.pos >= offset &&
          directive.range.pos < scanner.getTextPos(),
      ) ||
      (parser.checkJsDirective?.enabled === false &&
        parser.checkJsDirective.pos >= offset &&
        parser.checkJsDirective.pos < scanner.getTextPos()) ||
      /^\s*eslint-disable(?:-next-line|-line)?(?:\s|$)/.test(body)
    )
      add(
        "suppression",
        (parser.commentDirectives ?? []).find(
          (directive) =>
            directive.type === 1 &&
            directive.range.pos >= offset &&
            directive.range.pos < scanner.getTextPos(),
        )?.range.pos ??
          (parser.checkJsDirective?.enabled === false &&
          parser.checkJsDirective.pos >= offset &&
          parser.checkJsDirective.pos < scanner.getTextPos()
            ? parser.checkJsDirective.pos
            : offset),
      );
  }
  const diagnostics = (
    source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
  return {
    comments,
    warnings: diagnostics.slice(0, 20).map((diagnostic) => {
      const position = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      return `Unsupported or malformed maintenance syntax: ${path}:${position.line + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
    }),
  };
}

/** Excerpts are never a credential export; raw evidence is represented by digests. */
export function maintenanceExcerpt(text: string): string {
  if (
    /\b(?:password|passwd|token|secret|api[_-]?key|authorization)\s*[:=]|-----BEGIN|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:gh[pousr]_|sk-)[A-Za-z0-9_-]{8,}/i.test(
      text,
    )
  )
    return "[credential-bearing excerpt redacted]";
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim()
    .slice(0, 240);
}
