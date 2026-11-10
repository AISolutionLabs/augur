// Minimal React DevTools hook (React reports commits to it even in production builds). It keeps a
// summary of recent commits so an update loop (React error #185) can be attributed to components
// and to where they are on the page, which the error's own stack cannot show.
export const LOOP_PROBE = () => {
  const recent = [];
  const scrolls = [];
  addEventListener('scroll', () => { scrolls.push(performance.now()); if (scrolls.length > 400) scrolls.shift(); }, { capture: true, passive: true });
  const nameOf = (f) => (typeof f.type === 'function' || typeof f.type === 'object' ? f.type?.displayName || f.type?.name || f.type?.render?.name || '?' : null);
  const where = (f) => {
    for (let n = f; n; n = n.child) {
      if (n.stateNode instanceof Element) {
        const el = n.stateNode.closest('[data-testid],[aria-label],[id]');
        const inAugur = !!n.stateNode.closest('[data-testid="claude-timeline"],[data-testid^="claude-"],[data-testid^="augur-"]') || location.pathname.includes('augur') && !!n.stateNode.closest('main');
        return `${el ? (el.getAttribute('data-testid') ? `testid=${el.getAttribute('data-testid')}` : el.getAttribute('aria-label') ? `aria=${el.getAttribute('aria-label')}` : `id=${el.id}`) : n.stateNode.tagName.toLowerCase()}${inAugur ? ' (augur)' : ''}`;
      }
    }
    return '';
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    isDisabled: false,
    supportsFiber: true,
    renderers: new Map(),
    inject(r) { const id = this.renderers.size + 1; this.renderers.set(id, r); return id; },
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
    onCommitFiberRoot(_id, root) {
      const changed = [];
      const visit = (f, depth) => {
        for (let n = f; n && changed.length < 3000 && depth < 400; n = n.sibling) {
          const a = n.alternate;
          if (a && nameOf(n) && (n.memoizedState !== a.memoizedState || n.memoizedProps !== a.memoizedProps) && n.flags & 0x4 /* Update */) {
            changed.push(`${nameOf(n)}@${where(n)}`);
          }
          if (n.child && (n.subtreeFlags || n.flags)) visit(n.child, depth + 1);
        }
      };
      try { visit(root.current.child, 0); } catch (e) { changed.push('probe-error'); }
      recent.push({ t: performance.now(), changed });
      if (recent.length > 120) recent.shift();
    },
  };
  // Per-frame layout sampler: records changes in the docked menu's width/scrollbar, the page
  // scroll container's scrollbar, and the document width, to show what oscillates in a loop.
  const layout = [];
  const sample = () => {
    try {
      const menu = document.querySelector('[data-testid="data-testid navigation mega-menu"]') ?? document.querySelector('[data-testid="data-testid Nav menu item"]')?.closest('nav, [role="navigation"], ul')?.parentElement;
      const list = menu?.querySelector('ul');
      const page = document.getElementById('page-scrollbar');
      const truncated = document.querySelectorAll('[data-testid="data-testid Nav menu item"] [class*="truncat"], [data-testid="data-testid Nav menu item"] [aria-describedby]').length;
      const v = [
        `menuW=${menu ? Math.round(menu.getBoundingClientRect().width) : '-'}`,
        `menuScroll=${list ? (list.scrollHeight > list.clientHeight ? 'y' : 'n') : '-'}`,
        `pageScroll=${page ? (page.scrollHeight > page.clientHeight ? 'y' : 'n') : '-'}`,
        `docW=${document.documentElement.scrollWidth}/${document.documentElement.clientWidth}`,
        `trunc=${truncated}`,
      ].join(' ');
      if (!layout.length || layout[layout.length - 1].v !== v) {
        layout.push({ t: performance.now(), v });
        if (layout.length > 300) layout.shift();
      }
    } catch {}
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);

  window.__augurLoopReport = () => {
    const last = recent.slice(-60);
    const counts = {};
    for (const c of last) for (const x of new Set(c.changed)) counts[x] = (counts[x] ?? 0) + 1;
    const span = last.length ? Math.round(last[last.length - 1].t - last[0].t) : 0;
    const from = last.length ? last[0].t : 0;
    const scrolled = scrolls.filter((t) => t >= from).length;
    const changes = layout.filter((x) => x.t >= from - 50);
    const layoutNote = `; layout changes in window: ${changes.length}${changes.length ? ` [${[...new Set(changes.map((x) => x.v))].slice(0, 4).join(' ↔ ')}]` : ''}`;
    const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const augur = ranked.filter(([k]) => k.includes('(augur)'));
    const fmt = (xs) => xs.slice(0, 6).map(([k, v]) => `${k}×${v}`).join(', ') || 'none';
    return `${last.length} commits in ${span}ms, ${scrolled} scroll events${layoutNote}; most updated: ${fmt(ranked)}; augur components updated: ${fmt(augur)}`;
  };
};
