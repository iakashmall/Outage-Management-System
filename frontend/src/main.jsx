import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import Splash from './Splash.jsx';
import './index.css';
import { initKeycloak } from './lib/auth.js';

initKeycloak()
  .then((authenticated) => {
    if (authenticated) {
      const root = createRoot(document.getElementById('root'));
      // Splash renders first — a few seconds of themed animation — then
      // swaps itself out for the real dashboard once it's done. The actual
      // App component doesn't mount until the splash finishes, so this
      // isn't just a visual overlay sitting on top of a half-loaded app.
      root.render(<Splash onDone={() => root.render(<React.StrictMode><App /></React.StrictMode>)} />);
    }
  })
  .catch((err) => {
    console.error('Keycloak init failed', err);
    document.getElementById('root').innerText = 'Could not reach the login server. Is Keycloak running?';
  });

  //This is added because 
  //Before React even even renders the app, it first aska Key cloak "is there a valid session?"- if not , it redirects the browser to Keycloak's login page.
  //automatically. Only once that comes back successful does your actual Dashboard/Incidents/etc. app render.