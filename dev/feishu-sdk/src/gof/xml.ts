import { need } from './util.ts';

export interface XmlNode {
  /** Local name: the namespace prefix is dropped (x14:dataValidation → dataValidation). */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** All character data directly inside the element, in order. */
  text: string;
}

const ENTITY = /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g;
const MAX_DEPTH = 100;

function decode(value: string): string {
  return value.replace(ENTITY, (whole, body: string) => {
    switch (body) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: {
        const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        return Number.isSafeInteger(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
          ? String.fromCodePoint(code) : whole;
      }
    }
  });
}

function local(name: string): string {
  const i = name.indexOf(':');
  return i < 0 ? name : name.slice(i + 1);
}

const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * A small non-validating XML reader for the parts of an .xlsx. No DOCTYPE handling, so no entity expansion beyond the five
 * predefined ones and character references.
 */
export function parseXml(source: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let pos = 0;
  const end = source.length;
  while (pos < end) {
    const lt = source.indexOf('<', pos);
    const top = stack[stack.length - 1]!;
    if (lt < 0) { top.text += decode(source.slice(pos)); break; }
    if (lt > pos) top.text += decode(source.slice(pos, lt));
    if (source.startsWith('<!--', lt)) {
      const close = source.indexOf('-->', lt + 4);
      need(close >= 0, 'XML 注释未结束');
      pos = close + 3;
    } else if (source.startsWith('<![CDATA[', lt)) {
      const close = source.indexOf(']]>', lt + 9);
      need(close >= 0, 'XML CDATA 未结束');
      top.text += source.slice(lt + 9, close);
      pos = close + 3;
    } else if (source.startsWith('<?', lt)) {
      const close = source.indexOf('?>', lt + 2);
      need(close >= 0, 'XML 声明未结束');
      pos = close + 2;
    } else if (source.startsWith('<!', lt)) {
      const close = source.indexOf('>', lt + 2);
      need(close >= 0, 'XML 声明未结束');
      pos = close + 1;
    } else if (source[lt + 1] === '/') {
      const close = source.indexOf('>', lt + 2);
      need(close >= 0 && stack.length > 1, 'XML 标签不匹配');
      need(local(source.slice(lt + 2, close).trim()) === top.name, 'XML 标签不匹配');
      stack.pop();
      pos = close + 1;
    } else {
      let close = lt + 1;
      let quote = '';
      for (; close < end; close++) {
        const ch = source[close]!;
        if (quote) { if (ch === quote) quote = ''; } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '>') break;
      }
      need(close < end, 'XML 标签未结束');
      const selfClosing = source[close - 1] === '/';
      const inner = source.slice(lt + 1, selfClosing ? close - 1 : close);
      const space = inner.search(/\s/);
      const rawName = space < 0 ? inner : inner.slice(0, space);
      need(rawName.length > 0, 'XML 标签缺少名称');
      const attrs: Record<string, string> = {};
      if (space >= 0) {
        const attributeText = inner.slice(space);
        ATTRIBUTE.lastIndex = 0;
        for (let m = ATTRIBUTE.exec(attributeText); m; m = ATTRIBUTE.exec(attributeText)) {
          if (m[1] === 'xmlns' || m[1]!.startsWith('xmlns:')) continue;
          attrs[local(m[1]!)] = decode(m[2] ?? m[3] ?? '');
        }
      }
      const node: XmlNode = { name: local(rawName), attrs, children: [], text: '' };
      top.children.push(node);
      if (!selfClosing) {
        need(stack.length <= MAX_DEPTH, 'XML 嵌套过深');
        stack.push(node);
      }
      pos = close + 1;
    }
  }
  need(stack.length === 1, 'XML 标签未闭合');
  const doc = root.children[0];
  need(doc && root.children.length === 1, 'XML 缺少根元素');
  return doc;
}

export function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find(c => c.name === name);
}

export function childrenOf(node: XmlNode | undefined, name: string): XmlNode[] {
  return node?.children.filter(c => c.name === name) ?? [];
}

/** The node as plain data, for comparing two nodes by content. */
export function toData(node: XmlNode | undefined): unknown {
  if (!node) return null;
  return { name: node.name, attrs: node.attrs, text: node.children.length ? '' : node.text, children: node.children.map(toData) };
}
