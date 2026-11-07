/**
 * Demo images drawn locally (no network, no stock photos): architectural
 * scenes, interiors, portraits and wordmarks for the demo site. Deterministic,
 * so screenshots are comparable between runs.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const PALETTES = [
  { sky: ['#f6d9b8', '#9fb7c9'], ground: '#5d6b5a', walls: ['#e9e2d6', '#c9b79c', '#8a7a66'], glass: '#3b5266', accent: '#d9822b' },
  { sky: ['#dfe9f1', '#7f9bb3'], ground: '#4c5a4b', walls: ['#f4f1ea', '#b7b2a6', '#6f6a60'], glass: '#2e4357', accent: '#c45b3c' },
  { sky: ['#f3e4d0', '#d39d73'], ground: '#6b5b46', walls: ['#efe6d8', '#a9886a', '#5c4636'], glass: '#33424f', accent: '#2f6f6a' },
  { sky: ['#e8eef0', '#a8bfc4'], ground: '#556052', walls: ['#ffffff', '#d4cfc6', '#3f3f3f'], glass: '#25313b', accent: '#b88a2e' },
];

function building(width: number, height: number, seed: number): string {
  const p = PALETTES[seed % PALETTES.length]!;
  const horizon = height * (0.62 + (seed % 3) * 0.04);
  const shapes: string[] = [];
  // A low house with a pitched roof, a taller volume and a glazed gable.
  const baseX = width * (0.12 + (seed % 4) * 0.03), w1 = width * 0.38, h1 = height * 0.26;
  shapes.push(`<rect x="${baseX}" y="${horizon - h1}" width="${w1}" height="${h1}" fill="${p.walls[0]}"/>`);
  shapes.push(`<polygon points="${baseX - 10},${horizon - h1} ${baseX + w1 / 2},${horizon - h1 - height * 0.17} ${baseX + w1 + 10},${horizon - h1}" fill="${p.walls[2]}"/>`);
  for (let i = 0; i < 4; i++) shapes.push(`<rect x="${baseX + 18 + i * (w1 - 36) / 4}" y="${horizon - h1 + 22}" width="${(w1 - 36) / 4 - 12}" height="${h1 * 0.42}" fill="${p.glass}" opacity=".85"/>`);
  shapes.push(`<rect x="${baseX + w1 * 0.42}" y="${horizon - h1 * 0.55}" width="${w1 * 0.12}" height="${h1 * 0.55}" fill="${p.accent}"/>`);
  const x2 = baseX + w1 + width * 0.06, w2 = width * 0.28, h2 = height * 0.42;
  shapes.push(`<rect x="${x2}" y="${horizon - h2}" width="${w2}" height="${h2}" fill="${p.walls[1]}"/>`);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) shapes.push(`<rect x="${x2 + 16 + c * (w2 - 32) / 3}" y="${horizon - h2 + 18 + r * (h2 - 30) / 4}" width="${(w2 - 32) / 3 - 10}" height="${(h2 - 30) / 4 - 12}" fill="${p.glass}" opacity=".8"/>`);
  // Trees.
  for (let t = 0; t < 3; t++) {
    const tx = width * (0.05 + t * 0.42 + (seed % 5) * 0.02), th = height * (0.18 + t * 0.03);
    shapes.push(`<rect x="${tx - 3}" y="${horizon - th * 0.3}" width="6" height="${th * 0.3}" fill="#4a3b2c"/><ellipse cx="${tx}" cy="${horizon - th * 0.55}" rx="${th * 0.22}" ry="${th * 0.38}" fill="${p.ground}" opacity=".9"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.sky[0]}"/><stop offset="1" stop-color="${p.sky[1]}"/></linearGradient></defs>
<rect width="100%" height="100%" fill="url(#s)"/><circle cx="${width * 0.82}" cy="${height * 0.2}" r="${height * 0.07}" fill="#fff6e0" opacity=".8"/>
<rect y="${horizon}" width="100%" height="${height - horizon}" fill="${p.ground}"/>${shapes.join('')}</svg>`;
}

function interior(width: number, height: number, seed: number): string {
  const p = PALETTES[seed % PALETTES.length]!;
  const floor = height * 0.68;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
<rect width="100%" height="${floor}" fill="${p.walls[0]}"/><rect y="${floor}" width="100%" height="${height - floor}" fill="${p.walls[1]}"/>
<rect x="${width * 0.08}" y="${height * 0.12}" width="${width * 0.34}" height="${height * 0.5}" fill="${p.sky[1]}"/><rect x="${width * 0.08}" y="${height * 0.12}" width="${width * 0.34}" height="${height * 0.5}" fill="none" stroke="${p.walls[2]}" stroke-width="10"/>
<line x1="${width * 0.25}" y1="${height * 0.12}" x2="${width * 0.25}" y2="${height * 0.62}" stroke="${p.walls[2]}" stroke-width="6"/>
<polygon points="${width * 0.08},${floor} ${width * 0.42},${floor} ${width * 0.62},${height} ${width * -0.1},${height}" fill="#fff8e6" opacity=".45"/>
<rect x="${width * 0.55}" y="${floor - height * 0.16}" width="${width * 0.32}" height="${height * 0.12}" rx="14" fill="${p.accent}"/><rect x="${width * 0.55}" y="${floor - height * 0.24}" width="${width * 0.32}" height="${height * 0.1}" rx="14" fill="${p.accent}" opacity=".8"/>
<circle cx="${width * 0.5}" cy="${floor - height * 0.04}" r="${height * 0.05}" fill="${p.ground}"/><rect x="${width * 0.49}" y="${floor - height * 0.3}" width="${width * 0.02}" height="${height * 0.26}" fill="${p.walls[2]}"/>
<ellipse cx="${width * 0.5}" cy="${floor - height * 0.33}" rx="${width * 0.05}" ry="${height * 0.05}" fill="${p.ground}" opacity=".9"/></svg>`;
}

function portrait(size: number, seed: number): string {
  const backgrounds = ['#d8e3e7', '#efe0d0', '#dfe6d8', '#e9dcea', '#e4e1d6'];
  const skins = ['#e8bfa0', '#c98f6b', '#f1cfb4', '#a8714f', '#dcae8c'];
  const hair = ['#3b2a20', '#6b4a2b', '#c9a46a', '#1f1f1f', '#8a5a3a'];
  const shirts = ['#2f4f5f', '#8a5a44', '#4f6b4a', '#5a4a6b', '#3f3f46'];
  const i = seed % 5;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
<rect width="100%" height="100%" fill="${backgrounds[i]}"/>
<ellipse cx="${size / 2}" cy="${size * 0.98}" rx="${size * 0.36}" ry="${size * 0.3}" fill="${shirts[i]}"/>
<rect x="${size * 0.44}" y="${size * 0.55}" width="${size * 0.12}" height="${size * 0.14}" fill="${skins[i]}"/>
<ellipse cx="${size / 2}" cy="${size * 0.42}" rx="${size * 0.17}" ry="${size * 0.2}" fill="${skins[i]}"/>
<path d="M${size * 0.32},${size * 0.4} Q${size / 2},${size * 0.12} ${size * 0.68},${size * 0.4} Q${size * 0.66},${size * 0.26} ${size / 2},${size * 0.24} Q${size * 0.34},${size * 0.26} ${size * 0.32},${size * 0.4}Z" fill="${hair[i]}"/></svg>`;
}

function wordmark(text: string, seed: number): string {
  const fonts = ['Georgia, serif', 'Helvetica, Arial, sans-serif', 'Futura, Avenir, sans-serif'];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="120"><rect width="100%" height="100%" fill="#ffffff" opacity="0"/>
<circle cx="52" cy="60" r="${22 + seed % 3 * 3}" fill="none" stroke="#2b2b2b" stroke-width="7"/>
<text x="92" y="74" font-family="${fonts[seed % 3]}" font-size="38" font-weight="${seed % 2 ? 700 : 500}" fill="#2b2b2b" letter-spacing="${seed % 2 ? 1 : 3}">${text}</text></svg>`;
}

export const DEMO_IMAGES = {
  hero: { draw: () => building(1600, 1000, 0), format: 'jpg' },
  ...Object.fromEntries([1, 2, 3, 4, 5, 6].map(n => [`project-${n}`, { draw: () => (n % 2 ? building(1200, 900, n) : interior(1200, 900, n)), format: 'jpg' }])),
  ...Object.fromEntries([1, 2, 3].map(n => [`interior-${n}`, { draw: () => interior(1200, 800, n + 1), format: 'jpg' }])),
  ...Object.fromEntries([1, 2, 3, 4, 5].map(n => [`person-${n}`, { draw: () => portrait(600, n), format: 'jpg' }])),
  ...Object.fromEntries(['Nordbygg', 'Ljusvik', 'Stråla', 'Kvarnen', 'Bergsand', 'Ekhagen'].map((name, n) => [`logo-${n + 1}`, { draw: () => wordmark(name, n), format: 'png' }])),
} satisfies Record<string, { draw: () => string; format: 'jpg' | 'png' }>;

export type DemoImage = keyof typeof DEMO_IMAGES;
export const demoImage = (name: DemoImage) => `/demo-media/${name}.${DEMO_IMAGES[name].format}`;

/** Write every demo image into `<dist>/demo-media/`. */
export async function writeDemoImages(dist: string) {
  const dir = path.join(dist, 'demo-media');
  await fs.mkdir(dir, { recursive: true });
  for (const [name, image] of Object.entries(DEMO_IMAGES)) {
    const pipeline = sharp(Buffer.from(image.draw()));
    await (image.format === 'png' ? pipeline.png() : pipeline.jpeg({ quality: 82 })).toFile(path.join(dir, `${name}.${image.format}`));
  }
}
