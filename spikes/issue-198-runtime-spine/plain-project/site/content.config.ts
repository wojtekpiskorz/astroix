import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const articles = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './site/content/articles' }),
  schema: z.object({
    title: z.string(),
    featured: z.boolean().default(false),
  }),
});

export const collections = { articles };
