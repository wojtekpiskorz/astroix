import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const homepage = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/homepage' }),
  schema: z.object({
    lead: z.string(),
    title: z.string(),
  }),
});

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    tags: z.array(z.string()).default([]),
    title: z.string().min(3),
  }),
});

export const collections = { blog, homepage };
