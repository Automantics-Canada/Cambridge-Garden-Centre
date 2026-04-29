import https from 'https';

const URL = 'https://cambridge-garden-centre-2.onrender.com/api/health';
const INTERVAL = 5 * 60 * 1000; // 5 minutes

function ping() {
  console.log(`[${new Date().toISOString()}] Pinging backend...`);
  
  https.get(URL, (res) => {
    console.log(`[${new Date().toISOString()}] Response: ${res.statusCode}`);
  }).on('error', (err) => {
    console.error(`[${new Date().toISOString()}] Error: ${err.message}`);
  });
}

// Initial ping
ping();

// Schedule pings
setInterval(ping, INTERVAL);

console.log(`Keep-alive script started. Pinging ${URL} every 5 minutes.`);
