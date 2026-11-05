// Markdown <-> block tree conversion for import, export and multi-line paste.
import { escapeHtml, htmlToText } from './util.js';

// ---------- inline ----------

export function inlineMdToHtml(md) {
  let s = escapeHtml(md);
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => (/^(https?:|mailto:)/i.test(u) ? `<a href="${u}">${t}</a>` : t));
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/__([^_]+)__/g, '<b>$1</b>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>').replace(/(^|\W)_([^_\s][^_]*)_(?=\W|$)/g, '$1<i>$2</i>');
  s = s.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
  return s;
}

export function inlineHtmlToMd(html) {
  const d = document.createElement('div');
  d.innerHTML = html || '';
  const walk = (n) => {
    let out = '';
    for (const c of n.childNodes) {
      if (c.nodeType === Node.TEXT_NODE) { out += c.textContent; continue; }
      if (c.nodeType !== Node.ELEMENT_NODE) continue;
      const inner = walk(c);
      switch (c.tagName) {
        case 'B': case 'STRONG': out += inner.trim() ? `**${inner}**` : inner; break;
        case 'I': case 'EM': out += inner.trim() ? `*${inner}*` : inner; break;
        case 'S': case 'STRIKE': out += `~~${inner}~~`; break;
        case 'CODE': out += `\`${c.textContent}\``; break;
        case 'A': out += `[${inner}](${c.getAttribute('href') || ''})`; break;
        case 'BR': out += '  \n'; break;
        default: out += inner;
      }
    }
    return out;
  };
  return walk(d);
}

// ---------- blocks -> markdown ----------

/** children(id) must return the ordered child blocks of id. */
export function pageToMarkdown(page, children) {
  const lines = [];
  const title = page.props.title || 'Untitled';
  lines.push(`# ${page.props.icon ? page.props.icon + ' ' : ''}${title}`, '');
  const emit = (parentId, depth) => {
    let n = 0;
    for (const b of children(parentId)) {
      n = b.type === 'numbered' ? n + 1 : 0;
      const ind = '    '.repeat(depth);
      const t = inlineHtmlToMd(b.props.text || '');
      let nested = true;
      switch (b.type) {
        case 'heading1': lines.push(`${ind}# ${t}`); break;
        case 'heading2': lines.push(`${ind}## ${t}`); break;
        case 'heading3': lines.push(`${ind}### ${t}`); break;
        case 'bulleted': lines.push(`${ind}- ${t}`); break;
        case 'numbered': lines.push(`${ind}${n}. ${t}`); break;
        case 'todo': lines.push(`${ind}- [${b.props.checked ? 'x' : ' '}] ${t}`); break;
        case 'toggle': lines.push(`${ind}- ${t}`); break;
        case 'quote': lines.push(`${ind}> ${t.replace(/\n/g, `\n${ind}> `)}`); break;
        case 'callout': lines.push(`${ind}> ${b.props.icon || '💡'} ${t}`); break;
        case 'code': lines.push(`${ind}\`\`\`${b.props.language || ''}`, ...htmlToText(b.props.text).split('\n').map((l) => ind + l), `${ind}\`\`\``); nested = false; break;
        case 'divider': lines.push(`${ind}---`); break;
        case 'image': lines.push(`${ind}![${b.props.caption || ''}](${b.props.src || ''})`); break;
        case 'page': case 'database': lines.push(`${ind}[${b.props.icon ? b.props.icon + ' ' : ''}${b.props.title || 'Untitled'}](page:${b.id})`); nested = false; break;
        case 'toc': nested = false; break;
        default: lines.push(`${ind}${t}`);
      }
      if (!['bulleted', 'numbered', 'todo', 'toggle'].includes(b.type) || depth === 0) {
        // keep list items tight, separate other blocks with a blank line
        if (!['bulleted', 'numbered', 'todo', 'toggle'].includes(b.type)) lines.push('');
      }
      if (nested) emit(b.id, depth + 1);
    }
  };
  emit(page.id, 0);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// ---------- markdown -> blocks ----------

/** Returns { title, blocks: [{type, props, children}] }. */
export function markdownToBlocks(md, { takeTitle = false } = {}) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const root = { children: [] };
  const stack = [{ indent: -1, node: root }];
  let title = null;
  let para = null;

  const indentOf = (l) => { const m = l.match(/^[ \t]*/)[0]; return m.replace(/\t/g, '    ').length; };
  const push = (indent, node) => {
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    stack[stack.length - 1].node.children.push(node);
    stack.push({ indent, node });
    return node;
  };
  const block = (type, text, extra = {}) => ({ type, props: { text: inlineMdToHtml(text), ...extra }, children: [] });

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    const indent = indentOf(raw);
    if (!line) { para = null; continue; }

    const fence = line.match(/^```(\S*)/);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) body.push(lines[i].slice(Math.min(indent, indentOf(lines[i])))), i++;
      push(indent, { type: 'code', props: { text: escapeHtml(body.join('\n')), language: fence[1] || 'plain' }, children: [] });
      para = null;
      continue;
    }
    let m;
    if (takeTitle && title === null && (m = line.match(/^# (.*)$/)) && root.children.length === 0) { title = m[1]; continue; }
    if ((m = line.match(/^(#{1,3}) (.*)$/))) { push(indent, block(`heading${m[1].length}`, m[2])); para = null; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) { push(indent, { type: 'divider', props: {}, children: [] }); para = null; continue; }
    if ((m = line.match(/^[-*+] \[( |x|X)\] (.*)$/))) { push(indent, block('todo', m[2], { checked: m[1] !== ' ' })); para = null; continue; }
    if ((m = line.match(/^[-*+] (.*)$/))) { push(indent, block('bulleted', m[1])); para = null; continue; }
    if ((m = line.match(/^\d+[.)] (.*)$/))) { push(indent, block('numbered', m[1])); para = null; continue; }
    if ((m = line.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/))) { push(indent, { type: 'image', props: { src: m[2], caption: m[1] }, children: [] }); para = null; continue; }
    if ((m = line.match(/^> ?(.*)$/))) {
      if (para && para.type === 'quote') { para.props.text += '<br>' + inlineMdToHtml(m[1]); continue; }
      para = push(indent, block('quote', m[1]));
      continue;
    }
    if (para && para.type === 'paragraph') { para.props.text += (lines[i - 1].endsWith('  ') ? '<br>' : ' ') + inlineMdToHtml(line); continue; }
    para = push(indent, block('paragraph', line));
  }
  return { title, blocks: root.children };
}
