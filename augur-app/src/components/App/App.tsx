import React from 'react';
import { Route, Routes } from 'react-router-dom';
import { AppRootProps } from '@grafana/data';
import { ChatPage } from '../ChatPage';

function App(_props: AppRootProps) {
  return (
    <Routes>
      <Route path="*" element={<ChatPage />} />
    </Routes>
  );
}

export default App;
