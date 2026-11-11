import { startServer } from './app.js';

const requested = Number(process.env.PORT) || 3000;
const { port, key } = await startServer({
  port: requested,
  presenterKey: process.env.PRESENTER_KEY,
  publicUrl: process.env.PUBLIC_URL,
}).catch((error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Le port ${requested} est déjà utilisé. Choisis-en un autre : PORT=3001 npm start`);
    process.exit(1);
  }
  throw error;
});

const base = process.env.PUBLIC_URL || `http://localhost:${port}`;
console.log(`
Flot en direct est lancé.

  Présentateur : ${base}/presentateur?cle=${key}
  Projecteur   : ${base}/projecteur
  Étudiants    : le QR code s'affiche sur le projecteur
`);
