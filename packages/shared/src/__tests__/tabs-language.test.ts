import { expect, it } from 'vitest';
import { buildCoreBlockRegistry, renderBlock } from '../index.js';

const registry = buildCoreBlockRegistry();
const tabs = (data: Record<string, unknown>, language?: string) => renderBlock({ id: 't', type: 'core/tabs', data: { labels: [{ label: 'A' }], ...data }, slots: [[{ id: 'p', type: 'core/prose', data: { html: '<p>x</p>' } }]] } as never,
  { registry, ...(language ? { context: { page: { language } } } : {}) } as never);

it('renders the open/close and menu labels in the page language unless authored', () => {
  const de = tabs({}, 'de-AT');
  expect(de).toContain('>Optionen anzeigen</button>');
  expect(de).toContain('aria-label="Optionen"');
  expect(de).not.toContain('Explore options');
  expect(tabs({ toggle_label: 'Explore options', menu_label: 'Options' }, 'de')).toContain('>Optionen anzeigen</button>');
  expect(tabs({}, 'sv')).toContain('>Visa alternativ</button>');
  expect(tabs({})).toContain('>Explore options</button>');
  expect(tabs({ toggle_label: 'Leistungen wählen' }, 'de')).toContain('>Leistungen wählen</button>');
});
