import { Skill, slugify } from './settings';

/**
 * Parses a skill from Markdown with optional YAML-ish front matter:
 *
 * ---
 * name: kafka-lag
 * title: Kafka consumer lag
 * description: Use when consumers fall behind or lag alerts fire
 * tags: [kafka, streaming]
 * ---
 * # Steps ...
 */
export function parseSkillMarkdown(text: string, filename = 'skill.md'): Skill {
  const meta: Record<string, string> = {};
  let body = text;
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (m) {
    body = m[2];
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^\s*([A-Za-z_]+)\s*:\s*(.*)$/);
      if (kv) {
        meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  }
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const title = meta.title || heading || filename.replace(/\.(md|markdown|txt)$/i, '');
  const tags = meta.tags
    ? meta.tags
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((t) => t.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
    : [];
  const firstPara = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'));
  return {
    name: slugify(meta.name || title),
    title,
    description: meta.description || (firstPara ?? '').slice(0, 200),
    tags,
    body: body.trim(),
    enabled: true,
  };
}
