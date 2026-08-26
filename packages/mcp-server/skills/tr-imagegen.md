---
name: tr-imagegen
description: Use when the user wants to generate images for a Typeroll site with AI models (Gemini, OpenAI, Higgsfield) — hero images, illustrations, section backgrounds, og-images. Triggers on "generera bilder", "generate images", "skapa en hero-bild", "AI-bilder", "bildgenerering", or when a brief calls for imagery that doesn't exist in assets/. Covers the local lab loop (generate → review → pick) and uploading winners to the Typeroll media library.
---

# Generate images for a Typeroll site (local lab → media library)

Image generation runs **locally** in the site workdir — provider API keys
live in the folder's `.env`, candidates land in `images/lab/`, and only
the picked winners are uploaded to the Typeroll media library via the
regular media tools (see `tr-images` for the upload/variants half).

Why local: you can look at the candidates (Read the files), iterate on
prompts cheaply, and never ship a key or a reject anywhere.

## Folder convention

```
<site>/
├── .env                  # provider keys — GITIGNORED, never committed
├── prompts/
│   └── image-style.md    # the site's image style profile (see below)
└── images/
    └── lab/              # generated candidates — gitignored, disposable
```

`.env` keys (only the ones the user has — check before assuming):

```
GEMINI_API_KEY=...
OPENAI_API_KEY=...
```

(Higgsfield needs no key here — it connects as an MCP server, see below.)

Load them per-command (`source .env` doesn't persist between Bash calls):

```bash
export $(grep -v '^#' .env | xargs)   # prepend to each generation command
```

## The style profile — prompts/image-style.md

Every site gets ONE style profile that you **prepend to every image
prompt**. This is what keeps 20 images generated across 5 sessions
looking like one site. Derive it from `assets/brand.md` + the brief if
it doesn't exist yet, and confirm it with the user before generating at
scale. Keep it short (5–10 lines): art direction, palette, mood,
photography vs illustration, what to avoid.

Example shape:

```markdown
# Bildstil — <Sajtnamn>
Varm, folklig illustration med mjuka rundade former. Platt 2D med
subtila skuggor — ingen 3D, ingen fotorealism. Palett: kobolt #1F4FB8,
sol #FFC83D, grädde #FFF8EC; accenter sparsamt. Människor: enkla,
inkluderande, glada — inga karikatyrer. Undvik: stockfoto-känsla, text
i bilden, logotyper, watermarks.
```

## Generate candidates

Name candidates descriptively: `images/lab/<motiv>-<modell>-<n>.png`.
Generate 3–6 candidates per slot (mix models when several keys exist),
then **Read the files to actually look at them** before showing the
user your shortlist.

### Gemini (gemini-2.5-flash-image)

```bash
curl -s "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent" \
  -H "x-goog-api-key: $GEMINI_API_KEY" -H 'Content-Type: application/json' \
  -d '{
    "contents": [{"parts": [{"text": "<STYLE PROFILE>\n\n<MOTIF PROMPT>"}]}],
    "generationConfig": {"imageConfig": {"aspectRatio": "16:9"}}
  }' | jq -r '.candidates[0].content.parts[] | select(.inlineData) | .inlineData.data' \
  | base64 -d > images/lab/hero-gemini-1.png
```

Aspect ratios: `1:1`, `16:9`, `4:3`, `3:4`, `9:16`. Gemini also does
image *editing* — pass an existing image as an `inlineData` part plus an
instruction to restyle/extend it (useful for "same illustration but
winter").

### OpenAI (gpt-image-1)

```bash
curl -s https://api.openai.com/v1/images/generations \
  -H "Authorization: Bearer $OPENAI_API_KEY" -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-image-1",
    "prompt": "<STYLE PROFILE>\n\n<MOTIF PROMPT>",
    "size": "1536x1024",
    "quality": "high"
  }' | jq -r '.data[0].b64_json' | base64 -d > images/lab/hero-openai-1.png
```

Sizes: `1024x1024`, `1536x1024` (landscape), `1024x1536` (portrait).

### Higgsfield (MCP server — no API key)

Higgsfield exposes its models through a hosted MCP server at
`https://mcp.higgsfield.ai/mcp` (OAuth-protected — first connect opens a
browser login; no secret lands in any file). Add it next to the
typeroll server in the site folder's `.mcp.json`:

```json
"higgsfield": { "type": "http", "url": "https://mcp.higgsfield.ai/mcp" }
```

Then use its tools directly — list what's available rather than
assuming tool names. Save/download outputs into `images/lab/` with the
same naming convention, and prepend the style profile to prompts here
too. **Headless caveat:** OAuth-protected MCP servers need an existing
login session on the machine — connect once interactively before
relying on it in a headless run. (The same URL works as a custom
connector in Claude Desktop, for editors who don't use Claude Code.)

## Review → pick → upload

1. **Look at every candidate** (Read the image files) and write one line
   per candidate in `build-log.md` (keep/reject + why).
2. Show the user the shortlist (file paths) and let them pick — unless
   they've delegated the pick to you.
3. Upload winners with the regular media tools (see `tr-images`):
   - small files → `upload_media_inline` (base64);
   - larger → `create_upload_url` + HTTP PUT + `finalize_media`.
   Give real `alt` text and a descriptive filename at upload time.
4. `generate_image_variants` for responsive sizes when the image is
   placed full-width.
5. Place via `update_block` (`core/image`, hero fields, …) or page HTML.
6. `images/lab/` is disposable — leave rejects there; never upload them.

## Pitfalls

- **Never put text in generated images** (headlines, buttons) — text is
  HTML's job; generated text renders as gibberish in non-English. And
  models sneak text onto surfaces where it "feels natural" — jerseys,
  signs, banners, packages — even when the prompt doesn't ask for any.
  Forbid it explicitly in the prompt ("plain unmarked clothing, no
  text, no letters, no numbers anywhere in the image") and make the
  same rule part of every site's style profile.
- **Don't commit `.env` or `images/lab/`** — both are gitignored by the
  kit convention; keep it that way.
- **Cost discipline:** generation costs real money per image. Batch
  thoughtfully (3–6 per slot, not 20), and reuse via Gemini's
  edit-an-image mode instead of regenerating from scratch.
- **Licensing/provenance:** AI-generated imagery is fine for site
  decoration, but never generate fake "photos" of real people, products
  the customer doesn't sell, or anything presented as documentary fact.
- **The style profile is the contract.** If the user rejects a batch on
  style grounds, fix `prompts/image-style.md` first, then regenerate —
  don't just tweak one prompt.
