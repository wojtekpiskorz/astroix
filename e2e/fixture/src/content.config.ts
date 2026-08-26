import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const homepage = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/homepage' }),
  schema: z.object({
    title: z.string(),
    lead: z.string(),
    image: z.string().optional(),
    cta: z
      .object({
        label: z.string(),
        href: z.string(),
      })
      .optional(),
  }),
});

export const collections = { homepage };
