/**
 * Pure outbound-rendering helpers shared by channel adapters.
 *
 * The functions here never perform I/O; they only reshape Markdown into the
 * plain-text or Telegram-HTML forms each transport can display faithfully.
 */

const FENCE_LINE_RE = /^\s*(?:```|~~~)/;
const HORIZONTAL_RULE_RE = /^(?:[-*_]\s*){3,}$/;
const HEADING_RE = /^#{1,6}\s+(.+?)\s*#*\s*$/;
const FILE_LINK_RE = /\[([^\]]*)\]\((file:\/\/[^)\s]*)\)/g;
const LINE_FRAGMENT_RE = /#L(\d+)(?:-L?(\d+))?/;
const MARKDOWN_LINK_RE = /(?<!!)\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const INLINE_CODE_RE = /(`+)([^`\n]*?)\1/g;

function splitCells(trimmedLine: string): string[] {
  return trimmedLine
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function isTableLine(trimmedLine: string): boolean {
  return (
    trimmedLine.startsWith("|") &&
    trimmedLine.endsWith("|") &&
    trimmedLine.length > 2
  );
}

function isSeparatorCell(cell: string): boolean {
  return /^:?-{2,}:?$/.test(cell);
}

function fileUrlBasename(url: string): string {
  const withoutFragment = url.split("#")[0] ?? url;
  const pathPart = withoutFragment.replace(/^file:\/\/\/?/i, "");
  let decoded = pathPart;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    // Keep the undecoded path when it contains malformed escapes.
  }
  const segments = decoded.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? decoded;
}

function inlineCodeFor(label: string, lineSpec: string): string {
  const trimmed = label.trim();
  const tickMatch = /^(`+)([\s\S]*?)\1$/.exec(trimmed);
  if (tickMatch) {
    const ticks = tickMatch[1]!;
    const inner = lineSpec ? `${tickMatch[2]}:${lineSpec}` : (tickMatch[2] ?? "");
    return `${ticks}${inner}${ticks}`;
  }
  const inner = lineSpec ? `${trimmed}:${lineSpec}` : trimmed;
  return `\`${inner}\``;
}

function replaceFileLinks(line: string): string {
  return line.replace(FILE_LINK_RE, (_match, rawLabel: string, url: string) => {
    const fragment = LINE_FRAGMENT_RE.exec(url);
    const lineSpec = fragment
      ? fragment[2]
        ? `${fragment[1]}-${fragment[2]}`
        : fragment[1]!
      : "";
    const label = rawLabel.trim() || fileUrlBasename(url);
    return inlineCodeFor(label, lineSpec);
  });
}

/**
 * Replace IDE `[label](file:///...#L10-L20)` links with concise inline code.
 * Content inside fenced code blocks is left byte-for-byte untouched.
 */
export function stripIdeFileLinks(text: string): string {
  if (!text) {
    return "";
  }
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let inFence = false;
  const out = lines.map((line) => {
    if (FENCE_LINE_RE.test(line.trim())) {
      inFence = !inFence;
      return line;
    }
    return inFence ? line : replaceFileLinks(line);
  });
  return out.join("\n");
}

function protectInlineCode(input: string): { text: string; spans: string[] } {
  const spans: string[] = [];
  const text = input.replace(INLINE_CODE_RE, (_match, _ticks, inner: string) => {
    spans.push(inner);
    return `\u0000${spans.length - 1}\u0000`;
  });
  return { text, spans };
}

function unwrapEmphasis(input: string): string {
  let text = input;
  text = text.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "$1");
  // Intraword underscores (foo_bar_baz) are excluded by the word-boundary guards.
  text = text.replace(/(?<![\w])__(?=\S)([^_\n]+?)__(?![\w])/g, "$1");
  text = text.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1");
  text = text.replace(/(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1");
  text = text.replace(/(?<![\w])_(?=\S)([^_\n]*?\S)_(?![\w])/g, "$1");
  return text;
}

function formatInlineText(input: string): string {
  const { text: protectedText, spans } = protectInlineCode(input);
  let text = protectedText.replace(
    MARKDOWN_LINK_RE,
    (_match, label: string, url: string) =>
      label.trim() === url.trim() ? url : `${label} (${url})`,
  );
  text = unwrapEmphasis(text);
  text = text.replace(/\u0000(\d+)\u0000/g, (_match, idx: string) => spans[Number(idx)] ?? "");
  return text;
}

function renderPlainTableRow(headers: string[], cells: string[]): string[] {
  const pairs = cells.map((cell, idx) => {
    const header = headers[idx];
    return header ? `${formatInlineText(header)}: ${formatInlineText(cell)}` : formatInlineText(cell);
  });
  const compact = `• ${pairs.join(" | ")}`;
  if (headers.length <= 2 && compact.length <= 60) {
    return [compact];
  }

  const lines = [`▸ ${formatInlineText(cells[0] ?? "")}`];
  for (let idx = 1; idx < cells.length; idx += 1) {
    const header = headers[idx];
    const value = formatInlineText(cells[idx] ?? "");
    lines.push(header ? `  • ${formatInlineText(header)}: ${value}` : `  • ${value}`);
  }
  return lines;
}

/**
 * Convert Markdown into crisp readable plain text for transports without rich
 * rendering, and as a fallback when rich Markdown rendering is rejected.
 */
export function stripMarkdownToReadableText(text: string): string {
  if (!text) {
    return "";
  }
  const lines = stripIdeFileLinks(text).replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inFence = false;
  let tableHeaders: string[] | null = null;

  const pushBlank = (): void => {
    const last = out[out.length - 1];
    if (last !== undefined && last.trim() !== "") {
      out.push("");
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (FENCE_LINE_RE.test(trimmed)) {
      tableHeaders = null;
      if (inFence) {
        inFence = false;
        pushBlank();
      } else {
        pushBlank();
        inFence = true;
      }
      continue;
    }

    if (inFence) {
      out.push(line);
      continue;
    }

    if (!trimmed) {
      tableHeaders = null;
      out.push("");
      continue;
    }

    if (HORIZONTAL_RULE_RE.test(trimmed)) {
      tableHeaders = null;
      out.push("———");
      continue;
    }

    if (isTableLine(trimmed)) {
      const cells = splitCells(trimmed);
      const nextLine = (lines[i + 1] ?? "").trim();

      if (cells.every(isSeparatorCell)) {
        continue;
      }

      if (
        !tableHeaders &&
        isTableLine(nextLine) &&
        splitCells(nextLine).every(isSeparatorCell)
      ) {
        tableHeaders = cells;
        continue;
      }

      if (tableHeaders && tableHeaders.length === cells.length) {
        out.push(...renderPlainTableRow(tableHeaders, cells));
        continue;
      }

      out.push(`• ${cells.map(formatInlineText).join(" | ")}`);
      continue;
    }

    tableHeaders = null;

    const heading = HEADING_RE.exec(trimmed);
    if (heading?.[1]) {
      out.push(`【${formatInlineText(heading[1])}】`);
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const quote = trimmed.replace(/^>\s?/, "");
      out.push(`│ ${formatInlineText(quote)}`);
      continue;
    }

    const bullet = line.match(/^(\s*)[-*+]\s+(\S.*)$/);
    if (bullet) {
      out.push(`${bullet[1] ?? ""}• ${formatInlineText(bullet[2]!)}`);
      continue;
    }

    out.push(formatInlineText(line));
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// --------------------------------------------------------------- Telegram HTML

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

function sanitizeLanguage(lang: string): string {
  return lang.replace(/[^a-zA-Z0-9_+-]/g, "");
}

function renderEmphasis(escapedText: string): string {
  let text = escapedText;
  text = text.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<b>$1</b>");
  text = text.replace(
    /(?<![\w])__(?=\S)([^_\n]+?)__(?![\w])/g,
    "<b>$1</b>",
  );
  text = text.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<s>$1</s>");
  text = text.replace(/(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "<i>$1</i>");
  text = text.replace(/(?<![\w])_(?=\S)([^_\n]*?\S)_(?![\w])/g, "<i>$1</i>");
  return text;
}

const SAFE_LINK_SCHEME_RE = /^(?:https?:\/\/|mailto:|tg:\/\/)/i;

function renderTelegramInline(input: string): string {
  const { text: protectedText, spans } = protectInlineCode(input);
  const restoreCode = (value: string): string =>
    value.replace(/\u0000(\d+)\u0000/g, (_match, idx: string) => {
      const raw = escapeHtml(spans[Number(idx)] ?? "");
      return `<code>${raw}</code>`;
    });

  const links: string[] = [];
  let text = protectedText.replace(
    MARKDOWN_LINK_RE,
    (_match, label: string, url: string) => {
      if (!SAFE_LINK_SCHEME_RE.test(url)) {
        return `[${label}](${url})`;
      }
      const renderedLabel = restoreCode(renderEmphasis(escapeHtml(label)));
      links.push(`<a href="${escapeAttribute(url)}">${renderedLabel}</a>`);
      return `\u0001${links.length - 1}\u0001`;
    },
  );

  text = escapeHtml(text);
  text = renderEmphasis(text);
  text = restoreCode(text);
  text = text.replace(/\u0001(\d+)\u0001/g, (_match, idx: string) => links[Number(idx)] ?? "");
  return text;
}

function renderTelegramTableRow(headers: string[], cells: string[]): string[] {
  if (headers.length <= 2) {
    const pairs = cells.map((cell, idx) => {
      const header = headers[idx];
      return header
        ? `<b>${renderTelegramInline(header)}</b>: ${renderTelegramInline(cell)}`
        : renderTelegramInline(cell);
    });
    const plainLength = pairs.join(" | ").length + 2;
    if (plainLength <= 60) {
      return [`• ${pairs.join(" | ")}`];
    }
  }

  const lines = [`▸ <b>${renderTelegramInline(cells[0] ?? "")}</b>`];
  for (let idx = 1; idx < cells.length; idx += 1) {
    const header = headers[idx];
    const value = renderTelegramInline(cells[idx] ?? "");
    lines.push(header ? `  <b>${renderTelegramInline(header)}</b>: ${value}` : `  ${value}`);
  }
  return lines;
}

/**
 * Convert CommonMark/GFM into Telegram Bot API HTML (`parse_mode: "HTML"`).
 * Plain text is escaped before any markup is emitted so user content cannot
 * inject tags.
 */
export function markdownToTelegramHtml(text: string): string {
  if (!text) {
    return "";
  }
  const lines = stripIdeFileLinks(text).replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inFence = false;
  let fenceLang = "";
  let fenceBody: string[] = [];
  let tableHeaders: string[] | null = null;
  let quoteLines: string[] | null = null;

  const flushQuote = (): void => {
    if (quoteLines) {
      out.push(`<blockquote>${quoteLines.join("\n")}</blockquote>`);
      quoteLines = null;
    }
  };

  const emitFence = (): void => {
    const body = escapeHtml(fenceBody.join("\n"));
    const lang = sanitizeLanguage(fenceLang);
    out.push(
      lang
        ? `<pre><code class="language-${escapeAttribute(lang)}">${body}</code></pre>`
        : `<pre>${body}</pre>`,
    );
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    const fence = /^(?:```|~~~)\s*([^\s]*)\s*$/.exec(trimmed);
    if (fence) {
      tableHeaders = null;
      flushQuote();
      if (inFence) {
        emitFence();
        inFence = false;
        fenceLang = "";
        fenceBody = [];
      } else {
        inFence = true;
        fenceLang = fence[1] ?? "";
        fenceBody = [];
      }
      continue;
    }

    if (inFence) {
      fenceBody.push(line);
      continue;
    }

    if (!trimmed) {
      tableHeaders = null;
      flushQuote();
      out.push("");
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      tableHeaders = null;
      const quote = line.replace(/^\s*>\s?/, "");
      if (!quoteLines) {
        quoteLines = [];
      }
      quoteLines.push(quote ? renderTelegramInline(quote) : "");
      continue;
    }

    flushQuote();

    if (HORIZONTAL_RULE_RE.test(trimmed)) {
      tableHeaders = null;
      out.push("———");
      continue;
    }

    if (isTableLine(trimmed)) {
      const cells = splitCells(trimmed);
      const nextLine = (lines[i + 1] ?? "").trim();

      if (cells.every(isSeparatorCell)) {
        continue;
      }

      if (
        !tableHeaders &&
        isTableLine(nextLine) &&
        splitCells(nextLine).every(isSeparatorCell)
      ) {
        tableHeaders = cells;
        continue;
      }

      if (tableHeaders && tableHeaders.length === cells.length) {
        out.push(...renderTelegramTableRow(tableHeaders, cells));
        continue;
      }

      out.push(`• ${cells.map(renderTelegramInline).join(" | ")}`);
      continue;
    }

    tableHeaders = null;

    const heading = HEADING_RE.exec(trimmed);
    if (heading?.[1]) {
      out.push(`<b>${renderTelegramInline(heading[1])}</b>`);
      continue;
    }

    const bullet = line.match(/^(\s*)[-*+]\s+(\S.*)$/);
    if (bullet) {
      out.push(`${bullet[1] ?? ""}• ${renderTelegramInline(bullet[2]!)}`);
      continue;
    }

    out.push(renderTelegramInline(line));
  }

  if (inFence) {
    emitFence();
  }
  flushQuote();

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}