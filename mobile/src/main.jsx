import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './app.css';
import { initKeycloak } from './lib/auth.js';

initKeycloak()
  .then((authenticated) => {
    if (authenticated) {
      createRoot(document.getElementById('root')).render(<App />);
    }
  })
  .catch((err) => {
    console.error('Keycloak init failed', err);
    document.getElementById('root').innerText = 'Could not reach the login server. Is Keycloak running?';
  });
