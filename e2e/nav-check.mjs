#!/usr/bin/env node
// Checks where the Augur app sits in Grafana's menu: node e2e/nav-check.mjs [expected-parent]
// expected-parent: "root" (top level, default) or a section id such as "apps".
const grafana = process.env.GRAFANA_URL ?? 'http://localhost:3000';
const expected = process.argv[2] ?? 'root';
const boot = await fetch(`${grafana}/bootdata`).then((r) => r.json());
const tree = boot.navTree ?? boot.bootData?.navTree ?? [];
const id = 'plugin-page-augur-assistant-app';
const find = (nodes, parent) => {
  for (const n of nodes ?? []) {
    if (n.id === id) return { parent, index: nodes.indexOf(n), siblings: nodes.map((x) => x.id) };
    const hit = find(n.children, n.id);
    if (hit) return hit;
  }
};
const hit = find(tree, 'root');
if (!hit) {
  console.log(`✗ Augur not in the menu (top level: ${tree.map((n) => n.id).join(', ')})`);
  process.exit(1);
}
const ok = hit.parent === expected;
console.log(`${ok ? '✓' : '✗'} Augur menu item under ${hit.parent} (expected ${expected}); neighbours: ${hit.siblings.slice(Math.max(0, hit.index - 1), hit.index + 2).join(' | ')}`);
process.exit(ok ? 0 : 1);
