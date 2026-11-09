// Jest setup provided by Grafana scaffolding
import './.config/jest-setup';

// React 19's scheduler keeps a MessageChannel open under jsdom, which stops Jest from exiting.
// Removing it makes the scheduler fall back to setTimeout in tests.
// eslint-disable-next-line no-undef
delete global.MessageChannel;
