---
title: Introduction
description: Learn how Typeroll CMS combines visual editing, AI-agent access and static publishing, and choose where to start.
---

Typeroll CMS is an open-source CMS for static websites. Edit content in your
browser or connect your own AI agent through the REST API and MCP server.
Self-host the CMS or use Typeroll Cloud.

Freelancers and web agencies can manage multiple client sites while clients edit
content in the browser. Organizations can also use it for their own websites.

## The three parts

| Part                  | What it does                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| CMS and visual editor | Store pages, blocks, templates, media and settings. Review changes and save content.                         |
| API and MCP           | Let your AI agent read and change the same content, within its credentials' scope.                           |
| Static publishing     | Freeze a version, generate source in GitHub, build it and upload static files to the site's hosting account. |

The CMS is the editing source of truth. Generated site repositories are portable
build inputs, but manual changes in them are unsupported and may be overwritten.

## Start without publishing accounts

Create a site, edit pages and use expiring previews before connecting GitHub,
Cloudflare or a domain. Public deployment stays locked until the required
publishing setup is ready. Saving a page and changing its status do not by
themselves update a public website.

- [Use the visual editor](../../guides/the-editor/) to work in your browser.
- [Connect an AI agent](../mcp-server/) for API or MCP workflows.
- [Build your first site](../first-site/) for an end-to-end example.

## When you are ready to publish

An Organization owns the GitHub connection, shared media and build-provider
selection. Each Hosting Group supplies a Cloudflare hosting account and site
address base. A Site has its own generated repository, static Pages project,
version branches and optional website and media domains.

Build execution and static hosting are separate. A shared Cloudflare build engine
or GitHub Actions builds sites for the organization; finished files go to each
site's Hosting Group. See [Publishing](../../guides/customer-publishing/).

Forms, Apps and Extensions may depend on runtime services after deployment.
[Self-hosting](../../guides/self-hosting/) covers running the CMS and core runtime yourself.
