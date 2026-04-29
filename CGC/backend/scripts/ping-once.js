import https from 'https';

const URL = 'https://cambridge-garden-centre-2.onrender.com/api/health';

console.log(`[${new Date().toISOString()}] Pinging backend...`);

https.get(URL, (res) => {
  console.log(`[${new Date().toISOString()}] Response: ${res.statusCode}`);
  process.exit(0);
}).on('error', (err) => {
  console.error(`[${new Date().toISOString()}] Error: ${err.message}`);
  process.exit(1);
});
