import { describe, expect, it } from 'vitest';
import { htmlToPlainText } from '../html-text.js';

describe('htmlToPlainText', () => {
  it('drops non-text elements with their content and keeps block boundaries', () => {
    expect(htmlToPlainText('<style media="all">p{color:red}</style><p>One</p><p>Two<br>three</p><!-- note --><script>if (a<b) x()</script>')).toBe('One Two three');
    expect(htmlToPlainText('<table><tr><td>a</td><td>b</td></tr></table><svg/>c')).toBe('a b c');
  });
  it('treats an unclosed style or script as hiding the rest, and leaves similar custom elements alone', () => {
    expect(htmlToPlainText('<p>Kept</p><style>.x{color:red}')).toBe('Kept');
    expect(htmlToPlainText('<svg-icon>Label</svg-icon> &lt;b&gt; &amp; &#8217;')).toBe('Label <b> & ’');
  });
});
