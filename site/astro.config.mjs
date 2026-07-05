// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';

// The Signposts website. Static build → deployed to signposts.asim.dev (Cloudflare, later).
// Design + content are ported from the approved spike (see the task's design.md); this file
// only wires the build. The redirects keep the old numbered docs paths alive.
export default defineConfig({
  site: 'https://signposts.asim.dev',
  output: 'static',
  integrations: [mdx(), sitemap()],
  // Docs code blocks are plain terminal panes styled with --code-bg / --code-ink (see
  // docs.css) — not Shiki-themed. Off so our token-based CSS owns the pre background.
  markdown: { syntaxHighlight: false },
  // Old numbered docs paths → new slug scheme (the hand-authored HTML used NN-name.html).
  redirects: {
    '/docs/01-quickstart': '/docs/quickstart',
    '/docs/02-the-loop': '/docs/the-loop',
    '/docs/03-concepts': '/docs/concepts',
    '/docs/04-signposts-yaml': '/docs/signposts-yaml',
    '/docs/05-rules': '/docs/rules',
    '/docs/05-rules/ast-grep': '/docs/rules/ast-grep',
    '/docs/05-rules/sibling-exists': '/docs/rules/sibling-exists',
    '/docs/05-rules/symbols-in-sibling': '/docs/rules/symbols-in-sibling',
    '/docs/05-rules/json-invariant': '/docs/rules/json-invariant',
    '/docs/05-rules/text-ban': '/docs/rules/text-ban',
    '/docs/05-rules/command-guard': '/docs/rules/command-guard',
    '/docs/05-rules/protected-path': '/docs/rules/protected-path',
    '/docs/05-rules/tool-gate': '/docs/rules/tool-gate',
    '/docs/06-signs': '/docs/signs',
    '/docs/07-authoring': '/docs/authoring',
    '/docs/08-wiring': '/docs/wiring',
    '/docs/09-troubleshooting': '/docs/troubleshooting',
    '/docs/10-skills': '/docs/skills',
    '/docs/11-packs': '/docs/packs',
  },
});
