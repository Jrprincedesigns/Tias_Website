import type { Config } from '@react-router/dev/config';
import { vercelPreset } from '@vercel/react-router/vite';

/**
 * React Router build configuration.
 *
 * The default build emits build/server/index.js — a Node server that
 * `react-router-serve` runs as a long-lived process. That is what `npm start`
 * and the Dockerfile both expect.
 *
 * Vercel does not run a process like that, so its preset re-targets the build
 * at Vercel's functions and moves the output to build/server/nodejs_<hash>/.
 * Applying it unconditionally therefore breaks `npm start` and container
 * hosting, so it is switched on only inside a Vercel build — VERCEL is set in
 * their build environment and nowhere else.
 *
 * The result: Vercel gets the layout it needs, and every other target keeps
 * building exactly what it built before.
 */
export default {
  ssr: true,
  presets: process.env.VERCEL ? [vercelPreset()] : [],
} satisfies Config;
