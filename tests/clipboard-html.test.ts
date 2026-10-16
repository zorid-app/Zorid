import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { htmlToMarkdown, isOwnClipboardHTML, isSingleImageHTML } from '../src/editor/clipboard-html.ts';

const dom = new JSDOM('<!doctype html><body></body>');
const options = { document: dom.window.document };
const convert = (html: string) => htmlToMarkdown(html, options);

test('browser clipboard fragment preserves headings, prose formatting, breaks and Unicode', () => {
  assert.equal(convert(`<!--StartFragment--><h2>Résumé 😀</h2>
    <p>Hello <strong>bold</strong> and <em>soft</em>.<br>Next <del>old</del> <mark>new</mark>.</p><!--EndFragment-->`),
    '## Résumé 😀\n\nHello **bold** and _soft_.  \nNext ~~old~~ ==new==.');
  assert.equal(convert('<p>one&nbsp; two\n\tthree</p><p>four</p>'), 'one  two three\n\nfour');
  assert.equal(convert('<div>one <b> two </b> <i>three</i></div>'), 'one **two** _three_');
});

test('nested ordered lists retain starts, task state and block content', () => {
  assert.equal(convert('<ol start="3"><li>First<ul><li><input type="checkbox" checked>Done</li><li><input type="checkbox">Todo</li></ul></li><li>Second</li></ol>'),
    '3. First\n    \n    - [x] Done\n    - [ ] Todo\n4. Second');
  assert.equal(convert('<ul><li><p>First paragraph</p><p>Second paragraph</p></li></ul>'), '- First paragraph\n    \n    Second paragraph');
  assert.equal(convert('<blockquote><p>Quoted</p><p>Again</p></blockquote><hr>'), '> Quoted\n> \n> Again\n\n---');
});

test('fenced and inline code preserve bytes, blank lines and safe delimiter lengths', () => {
  assert.equal(convert('<pre><code class="language-ts">const x = `a`;\n\n\n  &lt;tag&gt;\n```\n</code></pre>'),
    '````ts\nconst x = `a`;\n\n\n  <tag>\n```\n````');
  assert.equal(convert('<p><code>`edge`</code> and <code> a  b </code></p>'), '`` `edge` `` and `  a  b  `');
  assert.equal(convert('<div class="highlight-source-python"><pre>print("é")</pre></div>'), '```python\nprint("é")\n```');
});

test('links and images preserve labels, titles and escaped URL punctuation', () => {
  assert.equal(convert('<a href="https://example.test/a (b)" title="A &quot;title&quot;">a <b>link</b></a> <img src="../My photo.png" alt="[photo] é" title="Caption">'),
    '[a **link**](https://example.test/a%20\\(b\\) "A \\"title\\"") ![\\[photo\\] é](../My%20photo.png "Caption")');
  assert.equal(convert('<a href="#heading">Jump</a> <img alt="missing">'), '[Jump](#heading)');
});

test('tables preserve alignment, multiline cells, pipe text and colspan placeholders', () => {
  assert.equal(convert('<table><thead><tr><th align="left">Name</th><th align="right">Value</th></tr></thead><tbody><tr><td>a|b</td><td>one<br>two</td></tr></tbody></table>'),
    '|Name|Value|\n|:--|--:|\n|a\\|b|one  <br>two|');
  assert.equal(convert('<table><tr><td colspan="2">Wide</td><td>Last</td></tr></table>'), '||||\n|---|---|---|\n|Wide||Last|');
  assert.equal(convert('<table><caption>Data</caption><tr><th>A</th></tr><tr><td>B</td></tr></table>'), 'Data\n\n|A|\n|---|\n|B|');
});

test('literal Markdown punctuation remains literal and malformed HTML is repaired by the parser', () => {
  assert.equal(convert('<p>*literal* [label] &lt;tag&gt; \\ end</p><p># heading?</p>'), '\\*literal\\* \\[label\\] \\<tag\\> \\\\ end\n\n\\# heading?');
  assert.equal(convert('<p>1. literal list</p><p>==literal highlight==</p>'), '1\\. literal list\n\n\\=\\=literal highlight\\=\\=');
  assert.equal(convert('<p>one<b>two</p><p>three'), 'one**two**\n\n**three**');
  assert.equal(convert('<custom-element>visible <span>text</span></custom-element>'), 'visible text');
});

test('inert parsing excludes executable content and rejects active or unsupported URL schemes', () => {
  assert.equal(convert('<script>throw 1</script><style>body{display:none}</style><title>title</title><iframe src="https://example.test">frame</iframe><svg onload="alert(1)">svg</svg><p onclick="alert(1)">Visible</p>'), 'Visible');
  assert.equal(convert('<a href="javascript:alert(1)">bad</a><a href="java&#10;script:alert(1)">control</a><img src="data:image/svg+xml,x"><a href="vbscript:x">vbs</a>'), 'badcontrolvbs');
  assert.equal(convert('<template>hidden</template><p hidden>hidden</p>'), null);
  assert.equal(dom.window.document.body.innerHTML, '');
});

test('clipboard helper routing recognizes exact own marker and an image-only fragment', () => {
  assert.equal(isOwnClipboardHTML('<!-- obsidian --><p>x</p>'), true);
  assert.equal(isOwnClipboardHTML('<!--obsidian--><p>x</p>'), false);
  assert.equal(isSingleImageHTML(' <!--StartFragment--><img src="x">\n', options), true);
  assert.equal(isSingleImageHTML('<p><img src="x"></p>', options), false);
  assert.equal(isSingleImageHTML('<img src="x"><span>label</span>', options), false);
  assert.equal(convert('<!--comment--> \n'), null);
  assert.equal(htmlToMarkdown('<p>no DOM</p>'), null);
});
