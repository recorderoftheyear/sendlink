import { createApp, lanAddress } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = createApp(config);

app.server.listen(config.port, config.host, () => {
  const lan = lanAddress();
  console.log(`SendLink listening on http://localhost:${config.port}`);
  if (config.publicUrl) console.log(`Public URL (used in QR codes): ${config.publicUrl}`);
  else if (lan) console.log(`Phones on your network will reach it at http://${lan}:${config.port}`);
});

const shutdown = () => {
  app.close().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
