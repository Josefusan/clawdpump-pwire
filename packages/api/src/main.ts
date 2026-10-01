import { createApp, configFromEnv } from './app.js';

const cfg = configFromEnv();
cfg.onSettled = (info) => console.log(JSON.stringify({ event: 'settled', ...info }));
const port = Number(process.env.PORT ?? 8402);
createApp(cfg).listen(port, () => {
  console.log(JSON.stringify({ event: 'listening', port, network: cfg.network, facilitator: cfg.facilitatorUrl, payTo: cfg.payTo }));
});
