---
title: Introduction
description: What Typeroll is, how it works, and what you need to get started.
---

Typeroll is an AI-native site builder. You describe what you want — in plain language, to Claude — and Claude creates, edits and deploys your site using a set of purpose-built tools.

Under the hood, Typeroll is:

- **A portal** (Astro SSR + React) where sites and their content live.
- **A static site generator** (Astro SSG) that builds one fast, secure HTML site per customer.
- **An MCP server** that exposes the portal's capabilities as tools Claude can call.

## The mental model

Content lives in the portal (pages, settings, partials, collections, forms). When you deploy, the portal builds a fresh static site and pushes it to Cloudflare Pages. The MCP server is the bridge between Claude and the portal.

```
You ──chat──▶ Claude ──tools──▶ MCP server ──API──▶ Portal ──build──▶ Cloudflare Pages
```

## What Claude can do

| Category                 | Example prompts                                                           |
| ------------------------ | ------------------------------------------------------------------------- |
| Sites                    | "Create a site for Acme Design Studio with a Nordic minimal look"         |
| Pages                    | "Add a Services page with our three main offerings"                       |
| [Blocks](/tools/blocks/) | "Add a feature grid with our three differentiators on the home page"      |
| Block authoring          | "Make me a custom 'quote with avatar' block I can reuse"                  |
| Navigation               | "Update the header to add a link to the blog"                             |
| Page templates           | "Build a blog-post template — featured image, title, body, related posts" |
| Blogs                    | "Set up a blog with three seed articles"                                  |
| Forms                    | "Add a contact form that emails hello@acme.se"                            |
| SEO                      | "Fix the meta descriptions across all pages"                              |
| Responsive               | "Make the feature grid 1 column on mobile, 3 on desktop"                  |
| Import                   | "Import the content from squarespace-export.html"                         |
| Migration                | "Migrate my WordPress site at acme.se"                                    |
| Deploy                   | "Deploy the site and give me the URL"                                     |

## Prerequisites

- **Claude Code** (the CLI) — [install instructions](https://docs.anthropic.com/en/docs/claude-code)
- **Node.js 20+**
- **A Typeroll account** — [app.typeroll.com](https://app.typeroll.com)

## Next steps

1. [Install the MCP server](/getting-started/mcp-server/) — one command, one config change.
2. [Build your first site](/getting-started/first-site/) — a complete walkthrough.
