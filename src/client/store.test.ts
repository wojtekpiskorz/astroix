import { describe, expect, it } from 'vitest';
import { describeElement } from './store';

function mount(html: string): void {
  document.body.innerHTML = html;
}

describe('describeElement', () => {
  it('describes tag, first class and nth-of-type', () => {
    mount('<section><h1 class="hero-title">a</h1><h1 class="hero-title">b</h1></section>');
    const first = document.querySelector('h1');
    const second = document.querySelectorAll('h1')[1];
    expect(describeElement(first as Element)).toBe('h1.hero-title:nth-of-type(1)');
    expect(describeElement(second as Element)).toBe('h1.hero-title:nth-of-type(2)');
  });

  it('omits the class slot when the element has none', () => {
    mount('<div><p>x</p></div>');
    expect(describeElement(document.querySelector('p') as Element)).toBe('p:nth-of-type(1)');
  });
});
