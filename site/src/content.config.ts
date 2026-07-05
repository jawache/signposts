// Content collections (Astro content layer). The docs are hand-authored MDX under
// src/content/docs; `order` drives the sidebar + prev/next sequence, `group` nests the
// Rules subpages under their index in the sidebar.
import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const docs = defineCollection({
  loader: glob({ pattern: '**/*.mdx', base: './src/content/docs' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    order: z.number(),
    group: z.string().optional(),
  }),
});

export const collections = { docs };
