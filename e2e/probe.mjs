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
        for (let n = f; n && changed.length < 12 && depth < 400; n = n.sibling) {
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
  window.__augurLoopReport = () => {
    const last = recent.slice(-60);
    const counts = {};
    for (const c of last) for (const x of new Set(c.changed)) counts[x] = (counts[x] ?? 0) + 1;
    const span = last.length ? Math.round(last[last.length - 1].t - last[0].t) : 0;
    const from = last.length ? last[0].t : 0;
    const scrolled = scrolls.filter((t) => t >= from).length;
    return `${last.length} commits in ${span}ms, ${scrolled} scroll events; most updated: ${Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}×${v}`).join(', ') || 'none'}`;
  };
};
