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

// The form-generation fixture (#72): every mapped widget kind plus the raw
// field's two sources — `date` (a coerced, unmapped node) and `aside` (the
// deliberately-unsupported field the ticket names). Existing entries stay
// valid: every addition carries a default or is optional.
const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string().min(3),
    date: z.coerce.date(),
    tags: z.array(z.string()).default([]),
    tone: z.enum(['bold', 'calm']).default('bold'),
    priority: z.number().default(0),
    featured: z.boolean().default(false),
    meta: z
      .object({
        source: z.string().optional(),
      })
      .optional(),
    aside: z.union([z.string(), z.number()]).optional(),
  }),
});

export const collections = { homepage, blog };
