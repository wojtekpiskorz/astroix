import { defineConfig } from 'astro/config';
import astroix from '@wojciechpiskorz/astroix';

export default defineConfig({
  integrations: [astroix()],
});
