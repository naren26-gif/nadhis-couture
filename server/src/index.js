import { loadConfig } from './config.js';
import { createApp } from './app.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

createApp(config).listen(config.port, () => {
  console.log(`Nadhi's Couture server running on http://localhost:${config.port}`);
});
