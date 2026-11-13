import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, safeLink } from '../markdown-renderer.mjs';
test('renders headings, lists, tables, code and blockquotes', () => {
 const result = renderMarkdown('# Title\n\n- item\n\n> Quote\n\n```js\nconst a = 1;\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |');
 for (const tag of ['h1','ul','blockquote','pre','table']) assert.ok(result.includes('<'+tag),tag);
});
test('saved HTML is displayed as text and cannot execute', () => {
 const result = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<iframe src="https://evil.test"></iframe>');
 assert.ok(!/<(?:script|img|iframe)\b/i.test(result));
 assert.match(result,/&lt;script&gt;/);
});
test('unsafe URLs are rejected and external images never auto-load', () => {
 for (const value of ['javascript:alert(1)','data:text/html,hello','vbscript:msgbox(1)','jav&#97;script:alert(1)']) assert.equal(safeLink(value,'https://example.com'),null);
 const result = renderMarkdown('[bad](javascript:alert) ![tracker](https://example.com/image.png)');
 assert.ok(!result.includes('href="javascript:'));
 assert.ok(!result.includes('<img'));
 assert.match(result,/Image: tracker/);
 assert.equal(safeLink('/page','https://example.com/a'),'https://example.com/page');
});
