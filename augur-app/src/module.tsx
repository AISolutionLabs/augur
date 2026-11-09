import React, { lazy, Suspense } from 'react';
import { AppPlugin, PluginExtensionPanelContext } from '@grafana/data';
import { locationService } from '@grafana/runtime';
import { LoadingPlaceholder } from '@grafana/ui';
import { alertContextText, claudeUrl, exploreContextText, panelContextText } from './extensions';
import type { SidebarProps } from './components/Sidebar';

const App = lazy(() => import('./components/App/App'));
const LazySidebar = lazy(() => import('./components/Sidebar'));
const LazyConfig = lazy(() => import('./components/AppConfig'));

// Extension point ids as string literals (not enum members) so the bundle also loads on Grafana 12.x,
// whose @grafana/data may not define newer enum members.
const EP = {
  sidebar: 'grafana/extension-sidebar/v0-alpha',
  panelMenu: 'grafana/dashboard/panel/menu',
  explore: 'grafana/explore/toolbar/action',
  alertRule: 'grafana/alerting/alertingrule/action',
  alertInstance: 'grafana/alerting/instance/action',
  commandPalette: 'grafana/commandpalette/action',
};

export const SIDEBAR_TITLE = 'Augur';

/** Opens Augur in the docked sidebar when this Grafana has one, otherwise on the app page. */
function openAugur(helpers: any, props: SidebarProps) {
  if (typeof helpers?.openSidebar === 'function') {
    try {
      helpers.openSidebar(SIDEBAR_TITLE, props);
      return;
    } catch {
      // fall through to the full page
    }
  }
  locationService.push(claudeUrl({ q: props.q ?? '', mode: props.mode ?? 'chat', context: props.context }));
}

const Sidebar = (props: SidebarProps) => (
  <Suspense fallback={<LoadingPlaceholder text="Loading Augur…" />}>
    <LazySidebar {...props} />
  </Suspense>
);

const AppConfig = (props: any) => (
  <Suspense fallback={<LoadingPlaceholder text="" />}>
    <LazyConfig {...props} />
  </Suspense>
);

export const plugin = new AppPlugin<{}>()
  .setRootPage(App)
  .addConfigPage({ title: 'Augur settings', icon: 'cog', body: AppConfig, id: 'settings' })
  .addComponent<SidebarProps>({
    targets: [EP.sidebar],
    title: SIDEBAR_TITLE,
    description: 'Ask Augur about what you are looking at',
    component: Sidebar,
  })
  .addLink<PluginExtensionPanelContext>({
    title: 'Ask Augur about this panel',
    description: 'Explain what this panel shows and anything unusual',
    targets: [EP.panelMenu],
    icon: 'comment-alt',
    onClick: (_e, helpers) =>
      openAugur(helpers, { mode: 'chat', q: 'Explain what this panel shows over its time range and point out anything unusual.', context: panelContextText(helpers.context) }),
  })
  .addLink<PluginExtensionPanelContext>({
    title: 'Investigate with Augur',
    description: 'Root-cause analysis across metrics, logs and traces starting from this panel',
    targets: [EP.panelMenu],
    icon: 'search',
    onClick: (_e, helpers) =>
      openAugur(helpers, {
        mode: 'investigate',
        q: 'Investigate any anomaly visible in this panel: when it started, what changed, and the likely root cause.',
        context: panelContextText(helpers.context),
      }),
  })
  .addLink<any>({
    title: 'Ask Augur',
    description: 'Explain, fix or improve these queries',
    targets: [EP.explore],
    icon: 'comment-alt',
    onClick: (_e, helpers) =>
      openAugur(helpers, { mode: 'chat', q: 'Explain these queries and their results, and suggest improvements or next queries.', context: exploreContextText(helpers.context) }),
  })
  .addLink<any>({
    title: 'Investigate with Augur',
    description: 'Root-cause analysis for this alert',
    targets: [EP.alertRule, EP.alertInstance],
    icon: 'search',
    onClick: (_e, helpers) =>
      openAugur(helpers, {
        mode: 'investigate',
        q: 'Investigate this alert: is it real, what is the root cause, and what should be done?',
        context: alertContextText(helpers.context),
      }),
  })
  .addLink({
    title: 'Ask Augur',
    description: 'Chat with Augur about your observability data',
    targets: [EP.commandPalette],
    icon: 'comment-alt',
    onClick: (_e, helpers) => openAugur(helpers, {}),
  });
