import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { createTheme, ThemeContext } from '@grafana/data';
import { GlobalStyles } from '@grafana/ui';
import { ChatPage } from '../../augur-app/src/components/ChatPage';

const scene = (window as any).__SCENE__ as string;
const theme = createTheme({ colors: { mode: 'dark' } });
const start = scene === 'investigation' ? 'checkout p99 latency jumped about 40 minutes ago. Why?' : 'Turn this into a checkout dashboard, add an alert for DB pool saturation and silence the latency alert during the rollback';
const mode = scene === 'investigation' ? 'investigate' : 'chat';
localStorage.clear();

createRoot(document.getElementById('root')!).render(
  <ThemeContext.Provider value={theme}>
    <GlobalStyles />
    <MemoryRouter initialEntries={[`/a/augur-assistant-app?mode=${mode}&q=${encodeURIComponent(start)}`]}>
      <ChatPage />
    </MemoryRouter>
  </ThemeContext.Provider>
);
