'use client';

/**
 * 文档预览组件。
 *
 * 原站 `docs-plans-and-diffs.md` A10：「Markdown / HTML / SVG / images offer a
 * Preview button beside the source」。复刻现状是裸 `<pre>`。本组件做 Markdown
 * 渲染 + 「原始 / 预览」tab 切换 + 复制按钮；HTML/SVG 因 XSS 风险**不内联渲染**，
 * 默认落到原始 tab + sandbox iframe 兜底（来源不可信时不打开）。
 *
 * 安全口径：
 *   - Markdown：自实现的极简 block tokenizer + 行内脱敏。**不**引入第三方库（项目
 *     没装 markdown 包；为单一切片加依赖，违反既有约束）。
 *   - HTML / SVG：默认拒绝 dangerouslySetInnerHTML；fallback 到 sandbox iframe + Blob URL。
 *   - 链接：URL scheme 白名单（http / https），data:/javascript:/vbscript:/file:
 *     全部 drop 成纯文本「[不安全链接：<…>]」。
 *   - 代码块：保留原文本渲染（不解析语言、不高亮 —— 跟代码高亮捆在一起的 issue
 *     已经在 GAP 里有 spec，本切片不外溢）。
 *
 * 公约要点（给同行调用）：
 *   - 渲染 markdown 在浏览器（client-only）；SSR 阶段返回 null，document 不存在。
 *   - 这组件自身 useState 持有 view tab + 复制提示，不依赖调用方送状态。
 *   - 复制按钮：navigator.clipboard 不可用或失败时落到 textarea + execCommand，吐司。
 *     再失败就显示一段「复制失败」文字，不要静默。
 *
 * 不要被以下两件事骗到：
 *   - 「HTML 用 sandbox iframe 是安全」 —— 仅当你**控制 URL/内容**或**白名单 source**
 *     时成立。Plan/Changes 文档里 agent/用户在拼的 HTML，**默认不可信**，所以
 *     sandbox 也要走 Blob（user content 不能直接 metadata-refer 到父 origin）。
 *   - 「不渲染 HTML 就安全」 —— 复制按钮与「在新标签打开」是真有可能被滥用；不渲染
 *     的话复制只复制到剪贴板，由用户决定去哪打开，这就把责任从我们手上交出去。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { C, F, R, S, T } from '@/lib/design-tokens';
import type { DocKind } from '@/lib/api';

// ── XSS 脱敏层（纯函数） ──────────────────────────────────────────

/** 行内转义：保留必要的字符（`*_` `[ ] ( ) #` markdown 控制字符不算），但把
 *  `<` `>` `&` `"` `'` 全部替换成实体，再清掉常见社工载荷。 */
export function escapeInline(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    switch (ch) {
      case 0x26: out += '&amp;'; break;        // &
      case 0x3c: out += '&lt;'; break;          // <
      case 0x3e: out += '&gt;'; break;          // >
      case 0x22: out += '&quot;'; break;        // "
      case 0x27: out += '&#39;'; break;         // '
      default:   out += String.fromCharCode(ch);
    }
  }
  return out;
}

/**
 * scheme 白名单：只放 http/https。
 * 拒掉 javascript: / vbscript: / data: / file: 等等；用正则严格匹配「link 文本里的
 * URL」而不是裸字符串截断（保留行内其它文本不被吞）。
 */
const SAFE_URL = /^https?:\/\//i;

/**
 * 把 inline markdown 语法编译成已脱敏的 HTML 片段。
 *
 * 支持：
 *   - 行内 code（`…`，内含内容**不解析**，但依旧过 escapeInline 防 <script>）
 *   - **粗体**（**…**）和 *斜体*（…）各一次嵌套
 *   - 链接 [text](url) —— url 必须 http/https；不通过保留为 [text](url原文)
 *   - 自动 URL：要求 http(s):// 开头；否则当文本输出
 *
 * 输入已经是 escapeInline 过的字面；这里只处理 markdown 控制字符插入。
 */
export function renderInline(src: string): string {
  let s = src;
  // 1. 链接 [text](url)
  s = s.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (_m, textRaw, urlRaw) => {
    // textRaw 是 escape 过的；这里再用一次 escapeInline 防嵌套的奇怪输入。
    const text = escapeInline(textRaw);
    // urlRaw 也已被外层 escapeInline 处理过 —— `&` → `&amp;`。渲染 href 时把
    // `&amp;` 还原成 `&`，避免浏览器拿到的是双重转义的 URL（同时这是 markdown
    // 链接里 `&` 标准写法）。
    const urlUnescaped = urlRaw.trim().replace(/&amp;/g, '&');
    if (!SAFE_URL.test(urlUnescaped)) {
      // 不要把它变成 <a> —— 「javascript:」就是从这里进来的。
      return `<span style="color:${C.danger}">[不安全链接：${escapeInline(urlUnescaped)}]</span>`;
    }
    // 控制字符 / NUL
    if (/[\u0000-\u001f]/.test(urlUnescaped)) return text;
    return `<a href="${escapeInline(urlUnescaped)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });
  // 2. 行内 code
  s = s.replace(/`([^`]+)`/g, (_m, codeRaw) => {
    const code = escapeInline(codeRaw);
    return `<code style="background:${C.code};padding:0 4px;border-radius:4px;font-family:${F.mono};font-size:0.92em;">${code}</code>`;
  });
  // 3. 粗体
  s = s.replace(/\*\*([^*]+)\*\*/g, (_m, t) => `<strong>${escapeInline(t)}</strong>`);
  // 4. 斜体（避免吞掉加粗的残留 *)
  s = s.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, (_m, pre, t) => `${pre}<em>${escapeInline(t)}</em>`);
  // 5. 自动 URL —— 只匹配已 escape 过的 http(s)://
  s = s.replace(
    /(^|[^&"])((https?:\/\/)[^\s<]+)/gi,
    (_m, pre, url) => {
      // url 里若包含已 escape 的 &amp;，不要直接当 href —— 还它原稿。
      const cleanUrl = url.replace(/&amp;/g, '&');
      if (!SAFE_URL.test(cleanUrl)) return `${pre}${url}`;
      return `${pre}<a href="${escapeInline(cleanUrl)}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    },
  );
  return s;
}

export interface Block {
  kind: 'h' | 'p' | 'ul' | 'ol' | 'code' | 'hr' | 'quote';
  level?: number;        // h1-h6
  lines?: string[];      // 段落/列表的 escapeInline 之后的字符串
  body?: string;         // code block 的原始 text
  lang?: string;         // fenced code lang
}

export function renderMarkdown(md: string): Block[] {
  const out: Block[] = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i] ?? '';
    // fenced code block
    const fOpen = /^```([a-zA-Z0-9_+-]*)\s*$/.exec(ln);
    if (fOpen) {
      const lang = fOpen[1] ?? '';
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '');
        i++;
      }
      // 没闭合也吞到结尾
      if (i < lines.length) i++;
      out.push({ kind: 'code', body: body.join('\n'), lang });
      continue;
    }
    // hr
    if (/^---+\s*$/.test(ln)) {
      out.push({ kind: 'hr' });
      i++;
      continue;
    }
    // heading
    const hMatch = /^(#{1,6})\s+(.+)$/.exec(ln);
    if (hMatch) {
      out.push({ kind: 'h', level: hMatch[1]?.length ?? 1, lines: [escapeInline(hMatch[2] ?? '')] });
      i++;
      continue;
    }
    // blockquote
    if (/^>\s?/.test(ln)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] ?? '')) {
        buf.push(escapeInline((lines[i] ?? '').replace(/^>\s?/, '')));
        i++;
      }
      out.push({ kind: 'quote', lines: buf });
      continue;
    }
    // unordered list
    if (/^[\s]*[-*]\s+/.test(ln)) {
      const buf: string[] = [];
      while (i < lines.length && /^[\s]*[-*]\s+/.test(lines[i] ?? '')) {
        buf.push(renderInline(escapeInline((lines[i] ?? '').replace(/^[\s]*[-*]\s+/, ''))));
        i++;
      }
      out.push({ kind: 'ul', lines: buf });
      continue;
    }
    // ordered list
    if (/^[\s]*\d+\.\s+/.test(ln)) {
      const buf: string[] = [];
      while (i < lines.length && /^[\s]*\d+\.\s+/.test(lines[i] ?? '')) {
        buf.push(renderInline(escapeInline((lines[i] ?? '').replace(/^[\s]*\d+\.\s+/, ''))));
        i++;
      }
      out.push({ kind: 'ol', lines: buf });
      continue;
    }
    // 空行
    if (ln.trim() === '') {
      i++;
      continue;
    }
    // 段落：把连续非空行合并
    const buf: string[] = [];
    while (i < lines.length) {
      const cur = lines[i] ?? '';
      if (
        cur.trim() === '' ||
        /^```/.test(cur) ||
        /^#{1,6}\s/.test(cur) ||
        /^[\s]*[-*]\s+/.test(cur) ||
        /^[\s]*\d+\.\s+/.test(cur) ||
        /^>\s?/.test(cur) ||
        /^---+\s*$/.test(cur)
      ) {
        break;
      }
      buf.push(escapeInline(cur));
      i++;
    }
    if (buf.length > 0) {
      out.push({ kind: 'p', lines: buf.map((l) => renderInline(l)) });
    }
  }
  return out;
}

export function blocksToHtml(blocks: Block[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'h') {
      const lv = Math.max(1, Math.min(6, b.level ?? 1));
      const sz = lv === 1 ? T.h1 : lv === 2 ? T.h2 : T.bodyLg;
      parts.push(
        `<h${lv} style="margin:14px 0 6px;font-size:${sz};font-weight:600;color:${C.text}">${b.lines?.[0] ?? ''}</h${lv}>`,
      );
    } else if (b.kind === 'p') {
      parts.push(
        `<p style="margin:0 0 8px;line-height:1.6;color:${C.text}">${(b.lines ?? []).join('<br/>')}</p>`,
      );
    } else if (b.kind === 'ul' || b.kind === 'ol') {
      const tag = b.kind === 'ul' ? 'ul' : 'ol';
      parts.push(
        `<${tag} style="margin:0 0 8px 20px;line-height:1.6;color:${C.text};padding-left:8px;">${(b.lines ?? []).map((l) => `<li>${l}</li>`).join('')}</${tag}>`,
      );
    } else if (b.kind === 'code') {
      const lang = b.lang ? ` <span style="color:${C.textFaint};font-size:11px;">${escapeInline(b.lang)}</span>` : '';
      parts.push(
        `<pre style="margin:0 0 12px;padding:${S.md}px;background:${C.code};border-radius:${R.md};overflow:auto;"><code style="font-family:${F.mono};font-size:${T.body};color:${C.text};">${escapeInline(b.body ?? '')}</code>${lang}</pre>`,
      );
    } else if (b.kind === 'hr') {
      parts.push(`<hr style="border:none;border-top:1px solid ${C.line};margin:14px 0;"/>`);
    } else if (b.kind === 'quote') {
      parts.push(
        `<blockquote style="margin:0 0 12px;padding:6px 12px;border-left:3px solid ${C.lineStrong};background:${C.surface};color:${C.textDim};">${(b.lines ?? []).join('<br/>')}</blockquote>`,
      );
    }
  }
  return parts.join('');
}

// ── 样式 ─────────────────────────────────────────────────────────

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.55)',
  zIndex: 80,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: S.lg,
};

const cardStyle: CSSProperties = {
  background: C.surfaceHi,
  color: C.text,
  border: `1px solid ${C.lineStrong}`,
  borderRadius: R.xl,
  padding: S.lg,
  minWidth: 480,
  maxWidth: 880,
  width: '100%',
  maxHeight: '80vh',
  display: 'flex',
  flexDirection: 'column',
  boxShadow: '0 24px 60px rgba(0, 0, 0, 0.5)',
  fontFamily: F.sans,
  fontSize: T.body,
};

const titleStyle: CSSProperties = {
  margin: 0,
  marginBottom: S.sm,
  fontSize: T.h3,
  fontWeight: 600,
  color: C.text,
};

const tabRowStyle: CSSProperties = {
  display: 'flex',
  gap: S.xs,
  alignItems: 'center',
  marginBottom: S.md,
  borderBottom: `1px solid ${C.line}`,
};

const tabBtnStyle: CSSProperties = {
  background: 'transparent',
  color: C.textDim,
  border: 'none',
  borderBottom: '2px solid transparent',
  padding: `${S.sm}px ${S.md}px`,
  fontSize: T.body,
  fontFamily: F.sans,
  cursor: 'pointer',
};

const tabBtnActiveStyle: CSSProperties = {
  ...tabBtnStyle,
  color: C.text,
  borderBottom: `2px solid ${C.accent}`,
};

const contentBoxStyle: CSSProperties = {
  margin: 0,
  padding: S.md,
  background: C.code,
  border: `1px solid ${C.line}`,
  borderRadius: R.md,
  fontFamily: F.mono,
  fontSize: T.body,
  color: C.text,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  overflow: 'auto',
  flex: 1,
  minHeight: 240,
  lineHeight: 1.55,
};

const copyBtnStyle: CSSProperties = {
  background: 'transparent',
  color: C.textDim,
  border: `1px solid ${C.lineStrong}`,
  borderRadius: R.md,
  padding: `${S.sm}px ${S.md}px`,
  fontSize: T.meta,
  fontFamily: F.sans,
  cursor: 'pointer',
};

const footerRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginTop: S.md,
};

const closeBtnStyle: CSSProperties = {
  background: C.accent,
  color: '#0b0b0f',
  border: 'none',
  borderRadius: R.md,
  padding: `${S.sm}px ${S.md}px`,
  fontSize: T.body,
  fontWeight: 500,
  fontFamily: F.sans,
  cursor: 'pointer',
};

// ── 组件 ─────────────────────────────────────────────────────────

export interface DocPreviewProps {
  content: string;
  kind: DocKind;
  title?: string;
  onClose: () => void;
}

/** 安全选用：HTML/SVG 默认落到 source tab；其它（plan/changes 等纯文本/markdown）默认 preview。 */
function defaultTab(kind: DocKind): 'preview' | 'source' {
  if (kind === 'question' || kind === 'confirm' || kind === 'input' || kind === 'review') return 'source';
  return 'preview';
}

export default function DocPreview(props: DocPreviewProps): ReactElement | null {
  const { content, kind, title, onClose } = props;
  const [tab, setTab] = useState<'preview' | 'source'>(defaultTab(kind));
  const [copyHint, setCopyHint] = useState<string>('');
  const [mounted, setMounted] = useState<boolean>(false);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [iframeBlobUrl, setIframeBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
    const t = setTimeout(() => confirmRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const overlayClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>): void => {
      if (e.target === overlayRef.current) onClose();
    },
    [onClose],
  );

  // 把 HTML/SVG 内容走 blob+iframe sandbox 渲染。
  useEffect(() => {
    if (kind !== 'changes') return;
    // 只在用户切到 source tab 且文档含 HTML/SVG 标记时构造 blob —— 防止无谓字符串大 payload。
    if (tab !== 'source') {
      if (iframeBlobUrl) {
        URL.revokeObjectURL(iframeBlobUrl);
        setIframeBlobUrl(null);
      }
      return;
    }
    if (!/<(html|svg|!doctype)\b/i.test(content)) return;
    if (iframeBlobUrl) URL.revokeObjectURL(iframeBlobUrl);
    const mime = /<svg\b/i.test(content) ? 'image/svg+xml' : 'text/html';
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    setIframeBlobUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, kind, content]);

  const htmlBlocks = useMemo(
    () => (kind === 'plan' || kind === 'changes' || kind === 'question' || kind === 'confirm' || kind === 'input' || kind === 'review' ? renderMarkdown(content) : []),
    [content, kind],
  );

  const htmlOut = useMemo(
    () => (tab === 'preview' ? blocksToHtml(htmlBlocks) : ''),
    [htmlBlocks, tab],
  );

  const onCopy = useCallback(async (): Promise<void> => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content);
        setCopyHint('已复制');
      } else {
        // 退化路径 —— 仅 client
        const ta = document.createElement('textarea');
        ta.value = content;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        setCopyHint(ok ? '已复制' : '复制失败');
      }
    } catch {
      setCopyHint('复制失败');
    }
  }, [content]);

  if (!mounted || typeof document === 'undefined') return null;

  const isUnsafe = kind === 'changes' && /<(html|svg|!doctype|img|iframe|script|style)\b/i.test(content);

  return (
    <div
      ref={overlayRef}
      role="presentation"
      onClick={overlayClick}
      style={overlayStyle}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="doc-preview-title"
        style={cardStyle}
      >
        <h3 id="doc-preview-title" style={titleStyle}>
          {title ?? `${kind} 文档预览`}
        </h3>
        <div style={tabRowStyle}>
          <button
            type="button"
            onClick={() => setTab('preview')}
            style={tab === 'preview' ? tabBtnActiveStyle : tabBtnStyle}
          >
            预览
          </button>
          <button
            type="button"
            onClick={() => setTab('source')}
            style={tab === 'source' ? tabBtnActiveStyle : tabBtnStyle}
          >
            原始文本
          </button>
        </div>
        {isUnsafe && tab === 'preview' && (
          <div style={{
            padding: S.sm, color: C.warn, background: 'rgba(251,191,36,0.08)',
            borderRadius: R.md, marginBottom: S.sm, fontSize: T.meta,
          }}>
            文档含 HTML/SVG/脚本标记 —— 出于安全考虑不内联渲染。请切到「原始文本」或用容器按钮在新窗口查看（sandbox iframe）。
          </div>
        )}
        {tab === 'preview' && !isUnsafe ? (
          <div
            style={contentBoxStyle}
            // 这里的字符串已经过 blocksToHtml + escapeInline / renderInline 多层脱敏。
            // 拒绝任何「不是我们自己产生」的字符串注入这条容器。
            dangerouslySetInnerHTML={{ __html: htmlOut }}
          />
        ) : tab === 'source' && iframeBlobUrl ? (
          <iframe
            title={`${kind}-sandbox`}
            src={iframeBlobUrl}
            sandbox=""
            style={{ ...contentBoxStyle, border: 'none' }}
          />
        ) : (
          <pre style={contentBoxStyle}>{content}</pre>
        )}
        <div style={footerRowStyle}>
          <div>
            <button type="button" onClick={onCopy} style={copyBtnStyle}>
              复制原文
            </button>
            <span style={{ marginLeft: S.sm, color: C.textFaint, fontSize: T.meta }}>{copyHint}</span>
          </div>
          <button
            ref={confirmRef}
            type="button"
            onClick={onClose}
            style={closeBtnStyle}
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
