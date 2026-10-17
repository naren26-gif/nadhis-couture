import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { isConnectionProblem } from './errors.js';

// Last line of defence. A dropped database connection must never take the whole server down: log it and carry on
// (the request that was using it fails with a clear message). Anything else is a real bug: log it and stop, so it is
// noticed and the server restarts in a clean state.
function lastResort(kind) {
  return (err) => {
    if (isConnectionProblem(err)) {
      console.error(`${kind} (database connection, server keeps running):`, err?.code || '', err?.message);
      return;
    }
    console.error(`${kind}:`, err);
    process.exit(1);
  };
}
process.on('uncaughtException', lastResort('Uncaught error'));
process.on('unhandledRejection', lastResort('Unhandled promise rejection'));

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
