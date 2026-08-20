import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';
import { initKeycloak } from './lib/auth.js';

initKeycloak()
  .then((authenticated) => {
    if (authenticated) {
      createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
    }
  })
  .catch((err) => {
    console.error('Keycloak init failed', err);
    document.getElementById('root').innerText = 'Could not reach the login server. Is Keycloak running?';
  });

  //This is added because 
  //Before React even even renders the app, it first aska Key cloak "is there a valid session?"- if not , it redirects the browser to Keycloak's login page.
  //automatically. Only once that comes back successful does your actual Dashboard/Incidents/etc. app render.