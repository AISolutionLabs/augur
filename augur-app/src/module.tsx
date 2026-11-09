import { lazy } from 'react';
import { AppPlugin, PluginExtensionPanelContext, PluginExtensionPoints } from '@grafana/data';
import { alertContextText, claudeUrl, panelContextText } from './extensions';

const App = lazy(() => import('./components/App/App'));

export const plugin = new AppPlugin<{}>()
  .setRootPage(App)
  .addLink<PluginExtensionPanelContext>({
    title: 'Ask Claude about this panel',
    description: 'Explain what this panel shows and anything unusual',
    targets: [PluginExtensionPoints.DashboardPanelMenu],
    icon: 'comment-alt',
    path: claudeUrl({ q: '', mode: 'chat' }),
    configure: (ctx) => ({
      path: claudeUrl({
        mode: 'chat',
        q: 'Explain what this panel shows over its time range and point out anything unusual.',
        context: panelContextText(ctx),
      }),
    }),
  })
  .addLink<PluginExtensionPanelContext>({
    title: 'Investigate with Claude',
    description: 'Root-cause analysis across metrics, logs and traces starting from this panel',
    targets: [PluginExtensionPoints.DashboardPanelMenu],
    icon: 'search',
    path: claudeUrl({ q: '', mode: 'investigate' }),
    configure: (ctx) => ({
      path: claudeUrl({
        mode: 'investigate',
        q: 'Investigate any anomaly visible in this panel: when it started, what changed, and the likely root cause.',
        context: panelContextText(ctx),
      }),
    }),
  })
  .addLink<any>({
    title: 'Investigate with Claude',
    description: 'Root-cause analysis for this alert',
    targets: [PluginExtensionPoints.AlertingAlertingRuleAction, PluginExtensionPoints.AlertInstanceAction],
    icon: 'search',
    path: claudeUrl({ q: '', mode: 'investigate' }),
    configure: (ctx) => ({
      path: claudeUrl({
        mode: 'investigate',
        q: 'Investigate this alert: is it real, what is the root cause, and what should be done?',
        context: alertContextText(ctx),
      }),
    }),
  })
  .addLink({
    title: 'Ask Claude',
    description: 'Chat with Claude about your observability data',
    targets: [PluginExtensionPoints.CommandPalette],
    icon: 'comment-alt',
    path: claudeUrl({ q: '', mode: 'chat' }).replace(/\?.*$/, ''),
  });
