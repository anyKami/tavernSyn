import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDevice } from '../lib/device.mjs';
import { cliOptions } from '../lib/io.mjs';
import { Manager } from '../helper/manager.mjs';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const options = cliOptions(), device = await loadDevice(options.state);
        const status = await new Manager(device, null).reconcile(options.job);
        console.log(status.note);
        if (status.maintenancePending) process.exitCode = 1;
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
