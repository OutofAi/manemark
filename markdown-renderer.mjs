import { Marked } from './vendor/marked.mjs';
export function escapeText(value) {
  return String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
export function safeLink(value, base) {
  try {
    // Do not allow HTML entity encoding to hide a dangerous protocol.
    if (/&(?:#|[a-z])/i.test(value.split(':')[0])) return null;
    const url = new URL(value, base || undefined);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}
export function renderMarkdown(text, base) {
  const parser = new Marked({ gfm: true, breaks: false, renderer: {
    html({ text }) { return escapeText(text); },
    link({ href, tokens }) {
      const label = this.parser.parseInline(tokens);
      const url = safeLink(href, base);
      return url ? `<a href="${escapeText(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
    },
    // External images are links, never automatic network requests or trackers.
    image({ href, text }) {
      const url = safeLink(href, base);
      const label = escapeText(text || 'Image');
      return url ? `<a class="image-link" href="${escapeText(url)}" target="_blank" rel="noopener noreferrer">Image: ${label}</a>` : label;
    }
  } });
  return parser.parse(String(text || ''));
}
