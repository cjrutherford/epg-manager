import './patch-axios';
import { initDb } from '../db';
import { grabSiteBatchInProcess, grabChannelInProcess } from './grabber';

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 5) {
    console.error('Usage: node grab-worker.js <mode> <siteOrXmltvId> <data> <epgDays> <force>');
    process.exit(1);
  }

  const mode = args[0];
  const siteOrXmltvId = args[1];
  const data = args[2];
  const epgDays = args[3];
  const force = args[4] === 'true';

  try {
    // Initialize database connection inside the child process
    await initDb();
    
    if (mode === 'batch') {
      const channels = JSON.parse(data);
      const results = await grabSiteBatchInProcess(siteOrXmltvId, channels, epgDays, force);
      if (process.send) {
        process.send({ success: true, results });
      }
    } else if (mode === 'channel') {
      const success = await grabChannelInProcess(siteOrXmltvId, epgDays, force);
      if (process.send) {
        process.send({ success: true, results: success });
      }
    } else {
      throw new Error(`Unknown mode: ${mode}`);
    }
    process.exit(0);
  } catch (err: any) {
    console.error(`[GrabWorker] Fatal error:`, err);
    if (process.send) {
      process.send({ success: false, error: err.message });
    }
    process.exit(1);
  }
}

main();
